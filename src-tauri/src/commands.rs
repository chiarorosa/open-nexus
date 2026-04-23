use crate::router::{self, AllowedCommand, CommandArgs, RouterError, ValidatedCommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Deserialize)]
pub struct CommandInput {
    pub command: String,
    pub args: Value,
}

#[derive(Debug, Serialize)]
pub struct CommandOutput {
    pub success: bool,
    pub message: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SkillPlanStepInput {
    pub command: String,
    pub args: Value,
}

#[derive(Debug, Deserialize)]
pub struct SkillPlanInput {
    pub skill_id: String,
    pub steps: Vec<SkillPlanStepInput>,
}

#[derive(Debug, Serialize)]
pub struct SkillPlanStepOutput {
    pub index: usize,
    pub command: String,
    pub success: bool,
    pub message: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillPlanOutput {
    pub success: bool,
    pub skill_id: String,
    pub steps: Vec<SkillPlanStepOutput>,
    pub message: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SkillStepProgressEvent {
    skill_id: String,
    step_index: usize,
    total_steps: usize,
}

#[derive(Debug, Serialize)]
pub struct SkillPackImportOutput {
    pub imported: usize,
    pub updated: usize,
    pub skipped: usize,
}

#[tauri::command]
pub fn ping() -> CommandOutput {
    CommandOutput {
        success: true,
        message: "Nexus backend is alive".to_string(),
        error_code: None,
    }
}

#[tauri::command]
pub fn sample_process_cpu_percent() -> Result<f64, String> {
    let pid = std::process::id();
    sample_cpu_percent(pid)
}

#[tauri::command]
pub fn execute_skill_plan(app: AppHandle, input: SkillPlanInput) -> Result<SkillPlanOutput, String> {
    if input.steps.is_empty() {
        return Ok(SkillPlanOutput {
            success: false,
            skill_id: input.skill_id,
            steps: Vec::new(),
            message: "Plano de Skill vazio.".to_string(),
            error_code: Some("INVALID_ARGS".to_string()),
        });
    }

    let total_steps = input.steps.len();
    let mut outputs: Vec<SkillPlanStepOutput> = Vec::with_capacity(total_steps);

    for (index, step) in input.steps.iter().enumerate() {
        let _ = app.emit(
            "nexus://skill-step-progress",
            SkillStepProgressEvent {
                skill_id: input.skill_id.clone(),
                step_index: index + 1,
                total_steps,
            },
        );

        let validated = match router::validate(&step.command, &step.args) {
            Ok(v) => v,
            Err(err) => {
                let message = err.to_string();
                write_skill_step_audit_log(
                    &input.skill_id,
                    index,
                    &step.command,
                    &step.args,
                    false,
                    Some(err.code()),
                    &message,
                );
                outputs.push(SkillPlanStepOutput {
                    index,
                    command: step.command.clone(),
                    success: false,
                    message: message.clone(),
                    error_code: Some(err.code().to_string()),
                });
                return Ok(SkillPlanOutput {
                    success: false,
                    skill_id: input.skill_id,
                    steps: outputs,
                    message: format!("Falha na etapa {}: {}", index + 1, message),
                    error_code: Some(err.code().to_string()),
                });
            }
        };

        match dispatch_validated(&app, &validated) {
            Ok(message) => {
                write_skill_step_audit_log(
                    &input.skill_id,
                    index,
                    &step.command,
                    &step.args,
                    true,
                    None,
                    &message,
                );
                outputs.push(SkillPlanStepOutput {
                    index,
                    command: step.command.clone(),
                    success: true,
                    message,
                    error_code: None,
                });
            }
            Err(err) => {
                let message = err.to_string();
                write_skill_step_audit_log(
                    &input.skill_id,
                    index,
                    &step.command,
                    &step.args,
                    false,
                    Some(err.code()),
                    &message,
                );
                outputs.push(SkillPlanStepOutput {
                    index,
                    command: step.command.clone(),
                    success: false,
                    message: message.clone(),
                    error_code: Some(err.code().to_string()),
                });
                return Ok(SkillPlanOutput {
                    success: false,
                    skill_id: input.skill_id,
                    steps: outputs,
                    message: format!("Falha na etapa {}: {}", index + 1, message),
                    error_code: Some(err.code().to_string()),
                });
            }
        }
    }

    Ok(SkillPlanOutput {
        success: true,
        skill_id: input.skill_id,
        steps: outputs,
        message: "Skill executada com sucesso.".to_string(),
        error_code: None,
    })
}

#[tauri::command]
pub fn load_user_skills() -> Result<Vec<Value>, String> {
    let home = dirs_next::home_dir()
        .ok_or_else(|| "Nao foi possivel resolver o diretorio HOME".to_string())?;
    let skills_dir = home.join(".nexus").join("skills");

    if !skills_dir.exists() {
        return Ok(Vec::new());
    }

    let mut documents: Vec<Value> = Vec::new();
    let entries = fs::read_dir(&skills_dir)
        .map_err(|e| format!("Nao foi possivel listar skills em {}: {}", skills_dir.display(), e))?;

    for entry in entries {
        let entry = match entry {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[skills] falha ao ler entrada em {}: {}", skills_dir.display(), e);
                continue;
            }
        };

        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let text = match fs::read_to_string(&path) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[skills] falha ao ler {}: {}", path.display(), e);
                continue;
            }
        };

        let parsed: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[skills] JSON invalido em {}: {}", path.display(), e);
                continue;
            }
        };

        if !parsed.is_object() {
            log::warn!("[skills] skill ignorada em {}: raiz nao e objeto", path.display());
            continue;
        }

        documents.push(parsed);
    }

    Ok(documents)
}

#[tauri::command]
pub fn save_user_skill(skill: Value) -> Result<String, String> {
    if !skill.is_object() {
        return Err("Skill invalida: JSON raiz deve ser objeto".to_string());
    }

    let mut skill_object = skill;
    let id = skill_object
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Skill invalida: campo 'id' ausente".to_string())?;

    let home = dirs_next::home_dir()
        .ok_or_else(|| "Nao foi possivel resolver o diretorio HOME".to_string())?;
    let skills_dir = home.join(".nexus").join("skills");
    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Nao foi possivel criar diretorio de skills {}: {}", skills_dir.display(), e))?;

    let safe_file_stem = sanitize_skill_file_stem(&id);
    let mut file_path = skills_dir.join(format!("{}.json", safe_file_stem));
    if file_path.exists() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        file_path = skills_dir.join(format!("{}-{}.json", safe_file_stem, suffix));
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Some(object) = skill_object.as_object_mut() {
        object
            .entry("created_at".to_string())
            .or_insert_with(|| Value::String(now.to_string()));
        object
            .entry("source".to_string())
            .or_insert_with(|| Value::String("learned-from-success".to_string()));
        object
            .entry("usage_count".to_string())
            .or_insert_with(|| Value::Number(0.into()));
    }

    let serialized = serde_json::to_string_pretty(&skill_object)
        .map_err(|e| format!("Nao foi possivel serializar skill: {}", e))?;
    fs::write(&file_path, serialized)
        .map_err(|e| format!("Nao foi possivel salvar skill {}: {}", file_path.display(), e))?;

    Ok(file_path.display().to_string())
}

#[tauri::command]
pub fn update_user_skill(skill: Value) -> Result<String, String> {
    if !skill.is_object() {
        return Err("Skill invalida: JSON raiz deve ser objeto".to_string());
    }

    let id = skill
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Skill invalida: campo 'id' ausente".to_string())?;

    let home = dirs_next::home_dir()
        .ok_or_else(|| "Nao foi possivel resolver o diretorio HOME".to_string())?;
    let skills_dir = home.join(".nexus").join("skills");
    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Nao foi possivel criar diretorio de skills {}: {}", skills_dir.display(), e))?;

    let target_path = find_user_skill_file_by_id(&skills_dir, &id).unwrap_or_else(|| {
        let safe_file_stem = sanitize_skill_file_stem(&id);
        skills_dir.join(format!("{}.json", safe_file_stem))
    });

    let serialized = serde_json::to_string_pretty(&skill)
        .map_err(|e| format!("Nao foi possivel serializar skill: {}", e))?;
    fs::write(&target_path, serialized)
        .map_err(|e| format!("Nao foi possivel atualizar skill {}: {}", target_path.display(), e))?;

    Ok(target_path.display().to_string())
}

#[tauri::command]
pub fn export_skill_pack() -> Result<Value, String> {
    let skills = load_user_skills()?;
    Ok(json!({
        "version": "1.0.0",
        "skills": skills
    }))
}

#[tauri::command]
pub fn import_skill_pack(pack: Value) -> Result<SkillPackImportOutput, String> {
    let root = pack
        .as_object()
        .ok_or_else(|| "Skill pack invalido: raiz deve ser objeto".to_string())?;
    let raw_skills = root
        .get("skills")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Skill pack invalido: campo 'skills' deve ser array".to_string())?;

    let home = dirs_next::home_dir()
        .ok_or_else(|| "Nao foi possivel resolver o diretorio HOME".to_string())?;
    let skills_dir = home.join(".nexus").join("skills");
    fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Nao foi possivel criar diretorio de skills {}: {}", skills_dir.display(), e))?;

    let mut imported = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;

    for item in raw_skills {
        let skill = match item.as_object() {
            Some(v) => v,
            None => {
                skipped += 1;
                continue;
            }
        };

        let id = match skill.get("id").and_then(|v| v.as_str()) {
            Some(v) if !v.trim().is_empty() => v.trim().to_string(),
            _ => {
                skipped += 1;
                continue;
            }
        };

        let incoming_version = skill
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();

        let existing_path = find_user_skill_file_by_id(&skills_dir, &id);
        if let Some(path) = existing_path {
            let current_version = read_skill_version_from_path(&path).unwrap_or_else(|| "0.0.0".to_string());
            let cmp = compare_semver_strings(&incoming_version, &current_version);
            if cmp <= 0 {
                skipped += 1;
                continue;
            }

            let mut cloned = item.clone();
            if let Some(obj) = cloned.as_object_mut() {
                obj.entry("source".to_string())
                    .or_insert_with(|| Value::String("imported-pack".to_string()));
            }

            let serialized = serde_json::to_string_pretty(&cloned)
                .map_err(|e| format!("Nao foi possivel serializar skill importada: {}", e))?;
            fs::write(&path, serialized)
                .map_err(|e| format!("Nao foi possivel atualizar skill importada {}: {}", path.display(), e))?;
            updated += 1;
            continue;
        }

        let safe_file_stem = sanitize_skill_file_stem(&id);
        let target_path = skills_dir.join(format!("{}.json", safe_file_stem));
        let mut cloned = item.clone();
        if let Some(obj) = cloned.as_object_mut() {
            obj.entry("source".to_string())
                .or_insert_with(|| Value::String("imported-pack".to_string()));
        }
        let serialized = serde_json::to_string_pretty(&cloned)
            .map_err(|e| format!("Nao foi possivel serializar skill importada: {}", e))?;
        fs::write(&target_path, serialized)
            .map_err(|e| format!("Nao foi possivel salvar skill importada {}: {}", target_path.display(), e))?;
        imported += 1;
    }

    Ok(SkillPackImportOutput {
        imported,
        updated,
        skipped,
    })
}

#[cfg(target_os = "windows")]
fn sample_cpu_percent(pid: u32) -> Result<f64, String> {
    let first = read_total_cpu_ms_windows(pid)?;
    thread::sleep(Duration::from_millis(350));
    let second = read_total_cpu_ms_windows(pid)?;

    let cpu_delta_ms = second - first;
    if cpu_delta_ms < 0.0 {
        return Err("Falha ao medir CPU (delta negativo)".to_string());
    }

    let logical_cores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    let elapsed_ms = 350.0;

    let cpu_percent = (cpu_delta_ms / (elapsed_ms * logical_cores)) * 100.0;
    Ok(cpu_percent.max(0.0))
}

#[cfg(target_os = "windows")]
fn read_total_cpu_ms_windows(pid: u32) -> Result<f64, String> {
    let script = format!("(Get-Process -Id {}).TotalProcessorTime.TotalMilliseconds", pid);
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|e| format!("Falha ao executar medicao de CPU: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Falha ao ler CPU do processo (status {:?})",
            output.status.code()
        ));
    }

    let text = String::from_utf8(output.stdout)
        .map_err(|e| format!("Falha ao decodificar saida de CPU: {}", e))?;
    let parsed = text
        .trim()
        .parse::<f64>()
        .map_err(|e| format!("Falha ao converter CPU para numero: {}", e))?;
    Ok(parsed)
}

#[cfg(not(target_os = "windows"))]
fn sample_cpu_percent(pid: u32) -> Result<f64, String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "%cpu="])
        .output()
        .map_err(|e| format!("Falha ao executar medicao de CPU: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Falha ao ler CPU do processo (status {:?})",
            output.status.code()
        ));
    }

    let text = String::from_utf8(output.stdout)
        .map_err(|e| format!("Falha ao decodificar saida de CPU: {}", e))?;
    let parsed = text
        .trim()
        .parse::<f64>()
        .map_err(|e| format!("Falha ao converter CPU para numero: {}", e))?;
    Ok(parsed.max(0.0))
}

#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    let _ = router::validate("create_folder", &json!({ "path": path.clone() }))
        .map_err(format_router_error)?;

    let target = router::resolve_allowed_folder_path(&path).map_err(format_router_error)?;
    fs::create_dir_all(&target).map_err(|e| format!("Nao foi possivel criar pasta: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let _ = router::validate("open_url", &json!({ "url": url.clone() }))
        .map_err(format_router_error)?;

    do_open_url(&app, &url).map_err(format_router_error)
}

#[tauri::command]
pub fn launch_app(app: AppHandle, name: String) -> Result<(), String> {
    let _ = router::validate("launch_app", &json!({ "name": name.clone() }))
        .map_err(format_router_error)?;

    do_launch_app(&app, &name).map(|_| ()).map_err(format_router_error)
}

#[tauri::command]
pub fn open_skills_directory(app: AppHandle) -> Result<String, String> {
    let home = dirs_next::home_dir()
        .ok_or_else(|| "Nao foi possivel resolver o diretorio HOME".to_string())?;
    let skills_dir = home.join(".nexus").join("skills");
    fs::create_dir_all(&skills_dir).map_err(|e| {
        format!(
            "Nao foi possivel criar diretorio de skills {}: {}",
            skills_dir.display(),
            e
        )
    })?;

    let path = skills_dir.display().to_string();
    #[allow(deprecated)]
    app.shell()
        .open(&path, None)
        .map_err(|e| format!("Nao foi possivel abrir pasta de skills: {}", e))?;

    Ok(path)
}

#[tauri::command]
pub fn resolve_launch_target(query: String) -> Result<Option<String>, String> {
    Ok(resolve_dynamic_launch_target(&query))
}

#[tauri::command]
pub fn execute_command(app: AppHandle, input: CommandInput) -> Result<CommandOutput, String> {
    let validated = match router::validate(&input.command, &input.args) {
        Ok(v) => v,
        Err(err) => {
            write_audit_log(&input.command, &input.args, false, Some(err.code()), &err.to_string());
            return Ok(CommandOutput {
                success: false,
                message: err.to_string(),
                error_code: Some(err.code().to_string()),
            });
        }
    };

    match dispatch_validated(&app, &validated) {
        Ok(message) => {
            write_audit_log(&input.command, &input.args, true, None, &message);
            Ok(CommandOutput {
                success: true,
                message,
                error_code: None,
            })
        }
        Err(err) => {
            write_audit_log(
                &input.command,
                &input.args,
                false,
                Some(err.code()),
                &err.to_string(),
            );
            Ok(CommandOutput {
                success: false,
                message: err.to_string(),
                error_code: Some(err.code().to_string()),
            })
        }
    }
}

fn dispatch_validated(app: &AppHandle, validated: &ValidatedCommand) -> Result<String, RouterError> {
    match (&validated.command, &validated.args) {
        (AllowedCommand::Ping, CommandArgs::None) => Ok("pong".to_string()),
        (AllowedCommand::OpenUrl, CommandArgs::OpenUrl { url }) => {
            do_open_url(app, url)?;
            Ok(format!("URL aberta: {}", url))
        }
        (AllowedCommand::SearchWeb, CommandArgs::SearchWeb { query }) => {
            let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
            let search_url = format!("https://www.google.com/search?q={}", encoded);
            do_open_url(app, &search_url)?;
            Ok(format!("Pesquisa aberta no navegador: {}", query))
        }
        (AllowedCommand::CreateFolder, CommandArgs::CreateFolder { path }) => {
            let target = router::resolve_allowed_folder_path(path)?;
            fs::create_dir_all(&target)
                .map_err(|e| RouterError::ExecutionFailed(format!("{}", e)))?;
            Ok(format!("Pasta criada: {}", target.display()))
        }
        (AllowedCommand::LaunchApp, CommandArgs::LaunchApp { name }) => {
            let launched = do_launch_app(app, name)?;
            Ok(format!("Aplicativo iniciado: {}", launched))
        }
        _ => Err(RouterError::Internal(
            "Comando validado com combinacao de argumentos inconsistente".to_string(),
        )),
    }
}

fn do_open_url(app: &AppHandle, url: &str) -> Result<(), RouterError> {
    router::validate_url(url)?;

    #[allow(deprecated)]
    app.shell()
        .open(url, None)
        .map_err(|e| RouterError::ExecutionFailed(e.to_string()))
}

fn do_launch_app(app: &AppHandle, name: &str) -> Result<String, RouterError> {
    if should_prefer_dynamic_launch(name) {
        if let Some(resolved_target) = resolve_dynamic_launch_target(name) {
            let (program, args) = build_dynamic_launch_command(&resolved_target);
            if spawn_launch_command(app, &program, args).is_ok() {
                return Ok(format!("{} -> {}", name, resolved_target));
            }
        }
    }

    let (program, args) = resolve_app_command(name)?;
    match spawn_launch_command(app, &program, args) {
        Ok(_) => Ok(name.to_string()),
        Err(primary_err) => {
            if let Some(resolved_target) = resolve_dynamic_launch_target(name) {
                let (fallback_program, fallback_args) = build_dynamic_launch_command(&resolved_target);
                if spawn_launch_command(app, &fallback_program, fallback_args).is_ok() {
                    return Ok(format!("{} -> {}", name, resolved_target));
                }
            }
            Err(RouterError::ExecutionFailed(primary_err))
        }
    }
}

fn should_prefer_dynamic_launch(name: &str) -> bool {
    let normalized = normalize_launch_candidate(name);
    if normalized.is_empty() {
        return false;
    }

    if looks_like_existing_path(&normalized) {
        return false;
    }

    if normalized.contains('\\') || normalized.contains('/') || normalized.contains(':') {
        return false;
    }

    let token_count = normalized.split_whitespace().count();
    if token_count > 1 {
        return false;
    }

    let short_alias = normalized.len() <= 6;
    let has_digit = normalized.chars().any(|ch| ch.is_ascii_digit());
    short_alias || has_digit
}

fn resolve_app_command(name: &str) -> Result<(String, Vec<String>), RouterError> {
    let normalized = name.trim().to_lowercase();

    #[cfg(target_os = "windows")]
    {
        match normalized.as_str() {
            "vscode" => return Ok(("code".to_string(), vec![])),
            "steam" => {
                return Ok((
                    "cmd".to_string(),
                    vec![
                        "/C".to_string(),
                        "start".to_string(),
                        "steam://open/main".to_string(),
                    ],
                ))
            }
            "chrome" => return Ok(("chrome".to_string(), vec![])),
            "edge" => return Ok(("msedge".to_string(), vec![])),
            "firefox" => return Ok(("firefox".to_string(), vec![])),
            "terminal" => return Ok(("wt".to_string(), vec![])),
            "notepad" => return Ok(("notepad".to_string(), vec![])),
            "file-explorer" => return Ok(("explorer".to_string(), vec![])),
            "calculator" => return Ok(("calc".to_string(), vec![])),
            "spotify" => return Ok(("spotify".to_string(), vec![])),
            "slack" => return Ok(("slack".to_string(), vec![])),
            "discord" => return Ok(("discord".to_string(), vec![])),
            _ => {}
        }
    }

    #[cfg(target_os = "macos")]
    {
        match normalized.as_str() {
            "vscode" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Visual Studio Code".to_string()],
                ))
            }
            "steam" => {
                return Ok((
                    "open".to_string(),
                    vec!["steam://open/main".to_string()],
                ))
            }
            "chrome" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Google Chrome".to_string()],
                ))
            }
            "edge" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Microsoft Edge".to_string()],
                ))
            }
            "firefox" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Firefox".to_string()],
                ))
            }
            "terminal" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Terminal".to_string()],
                ))
            }
            "notepad" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "TextEdit".to_string()],
                ))
            }
            "file-explorer" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Finder".to_string()],
                ))
            }
            "calculator" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Calculator".to_string()],
                ))
            }
            "spotify" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Spotify".to_string()],
                ))
            }
            "slack" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Slack".to_string()],
                ))
            }
            "discord" => {
                return Ok((
                    "open".to_string(),
                    vec!["-a".to_string(), "Discord".to_string()],
                ))
            }
            _ => {}
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match normalized.as_str() {
            "vscode" => return Ok(("code".to_string(), vec![])),
            "steam" => {
                return Ok((
                    "xdg-open".to_string(),
                    vec!["steam://open/main".to_string()],
                ))
            }
            "chrome" => return Ok(("google-chrome".to_string(), vec![])),
            "edge" => return Ok(("microsoft-edge".to_string(), vec![])),
            "firefox" => return Ok(("firefox".to_string(), vec![])),
            "terminal" => return Ok(("x-terminal-emulator".to_string(), vec![])),
            "notepad" => return Ok(("gedit".to_string(), vec![])),
            "file-explorer" => return Ok(("xdg-open".to_string(), vec![".".to_string()])),
            "calculator" => return Ok(("gnome-calculator".to_string(), vec![])),
            "spotify" => return Ok(("spotify".to_string(), vec![])),
            "slack" => return Ok(("slack".to_string(), vec![])),
            "discord" => return Ok(("discord".to_string(), vec![])),
            _ => {}
        }
    }

    let mut tokens = split_command_line(name)?;
    if tokens.is_empty() {
        return Err(RouterError::InvalidAppName(name.to_string()));
    }

    let executable = tokens.remove(0);
    let executable_lower = executable.to_lowercase();

    #[cfg(target_os = "windows")]
    {
        if executable_lower.ends_with(".ps1") {
            let mut args = vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                executable,
            ];
            args.extend(tokens);
            return Ok(("powershell".to_string(), args));
        }

        if executable_lower.ends_with(".cmd") || executable_lower.ends_with(".bat") {
            let mut args = vec!["/C".to_string(), executable];
            args.extend(tokens);
            return Ok(("cmd".to_string(), args));
        }
    }

    #[cfg(all(unix, not(target_os = "windows")))]
    {
        if executable_lower.ends_with(".sh") {
            let mut args = vec![executable];
            args.extend(tokens);
            return Ok(("bash".to_string(), args));
        }
    }

    Ok((executable, tokens))
}

fn spawn_launch_command(
    app: &AppHandle,
    program: &str,
    args: Vec<String>,
) -> Result<(), String> {
    app.shell()
        .command(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn build_dynamic_launch_command(target: &str) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        return (
            "cmd".to_string(),
            vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                target.to_string(),
            ],
        );
    }

    #[cfg(target_os = "macos")]
    {
        if target.contains('/') {
            return ("open".to_string(), vec![target.to_string()]);
        }
        return (
            "open".to_string(),
            vec!["-a".to_string(), target.to_string()],
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if target.contains('/') {
            return (target.to_string(), vec![]);
        }
        return (target.to_string(), vec![]);
    }
}

fn resolve_dynamic_launch_target(raw: &str) -> Option<String> {
    let candidate = normalize_launch_candidate(raw);
    if candidate.is_empty() {
        return None;
    }

    if looks_like_existing_path(&candidate) {
        return Some(candidate);
    }

    #[cfg(target_os = "windows")]
    {
        let defer_where = should_defer_where_lookup(&candidate);
        if defer_where {
            if let Some(path) = search_windows_start_menu_shortcuts(&candidate) {
                return Some(path);
            }
            if let Some(path) = search_windows_install_dirs(&candidate) {
                return Some(path);
            }
            if let Some(path) = search_windows_where(&candidate) {
                return Some(path);
            }
        } else {
            if let Some(path) = search_windows_where(&candidate) {
                return Some(path);
            }
            if let Some(path) = search_windows_start_menu_shortcuts(&candidate) {
                return Some(path);
            }
            if let Some(path) = search_windows_install_dirs(&candidate) {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // "open -a <AppName>" supports user-installed apps by display name.
        return Some(candidate);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(path) = search_linux_bin(&candidate) {
            return Some(path);
        }
    }

    None
}

fn normalize_launch_candidate(raw: &str) -> String {
    let mut normalized = raw.trim().to_string();
    if normalized.is_empty() {
        return normalized;
    }

    let lowered = normalized
        .to_lowercase()
        .trim()
        .to_string();

    for prefix in [
        "abrir ",
        "abra ",
        "iniciar ",
        "inicie ",
        "executar ",
        "execute ",
    ] {
        if lowered.starts_with(prefix) {
            normalized = normalized[prefix.len()..].trim_start().to_string();
            break;
        }
    }

    let lowered = normalized.to_lowercase();
    for prefix in [
        "o ",
        "a ",
        "um ",
        "uma ",
        "app ",
        "aplicativo ",
        "programa ",
        "script ",
    ] {
        if lowered.starts_with(prefix) {
            normalized = normalized[prefix.len()..].trim_start().to_string();
            break;
        }
    }

    normalized.trim_matches('"').trim_matches('\'').trim().to_string()
}

fn looks_like_existing_path(candidate: &str) -> bool {
    let path = PathBuf::from(candidate);
    path.exists()
}

#[cfg(target_os = "windows")]
fn search_windows_where(candidate: &str) -> Option<String> {
    let candidate_token = normalize_token(candidate);
    let strict_match = should_defer_where_lookup(candidate);

    for query in [candidate.to_string(), format!("{}.exe", candidate)] {
        let output = Command::new("where").arg(&query).output().ok()?;
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8(output.stdout).ok()?;
        let first_line = text.lines().find(|line| !line.trim().is_empty())?;
        let path = first_line.trim();
        let path_buf = PathBuf::from(path);
        if !path_buf.exists() {
            continue;
        }

        if strict_match {
            let stem = path_buf
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !matches_candidate_against_name(&candidate_token, stem) {
                continue;
            }
        }

        if path_buf.exists() {
            return Some(path.to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn should_defer_where_lookup(candidate: &str) -> bool {
    if candidate.contains('\\') || candidate.contains('/') || candidate.contains(':') {
        return false;
    }

    let token_count = candidate.split_whitespace().count();
    if token_count != 1 {
        return false;
    }

    let short_alias = candidate.len() <= 6;
    let has_digit = candidate.chars().any(|ch| ch.is_ascii_digit());
    short_alias || has_digit
}

#[cfg(target_os = "windows")]
fn search_windows_start_menu_shortcuts(candidate: &str) -> Option<String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(program_data) = std::env::var("ProgramData") {
        roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        roots.push(
            PathBuf::from(app_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }

    let candidate_token = normalize_token(candidate);
    if candidate_token.is_empty() {
        return None;
    }

    walk_find_file_match(&roots, 6, 20_000, |path| {
        let ext_ok = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| matches!(ext.to_lowercase().as_str(), "lnk" | "url" | "appref-ms"))
            .unwrap_or(false);
        if !ext_ok {
            return false;
        }
        let file_name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        matches_candidate_against_name(&candidate_token, file_name)
    })
    .map(|path| path.display().to_string())
}

#[cfg(target_os = "windows")]
fn search_windows_install_dirs(candidate: &str) -> Option<String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(value) = std::env::var(key) {
            roots.push(PathBuf::from(value));
        }
    }

    let candidate_token = normalize_token(candidate);
    if candidate_token.is_empty() {
        return None;
    }

    walk_find_file_match(&roots, 4, 40_000, |path| {
        let is_exe = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !is_exe {
            return false;
        }
        let file_name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        matches_candidate_against_name(&candidate_token, file_name)
    })
    .map(|path| path.display().to_string())
}

#[cfg(target_os = "windows")]
fn matches_candidate_against_name(candidate_token: &str, raw_name: &str) -> bool {
    if candidate_token.is_empty() {
        return false;
    }

    let candidate_has_digit = candidate_token.chars().any(|ch| ch.is_ascii_digit());
    let normalized_name = normalize_token(raw_name);
    if normalized_name == candidate_token {
        return true;
    }

    if normalized_name.starts_with(candidate_token) {
        return true;
    }

    if normalized_name.contains(candidate_token) {
        return true;
    }

    // Acronym/digit fallback for names like "Counter-Strike 2" matching "cs2".
    let acronym = build_name_acronym(raw_name);
    if !acronym.is_empty() && (acronym == candidate_token || acronym.starts_with(candidate_token)) {
        return true;
    }

    // Loose in-order subsequence match only for longer aliases without digits.
    if !candidate_has_digit && candidate_token.len() >= 4 && candidate_token.len() <= 8 {
        return is_subsequence(candidate_token, &normalized_name);
    }

    false
}

#[cfg(target_os = "windows")]
fn build_name_acronym(raw_name: &str) -> String {
    let mut acronym = String::new();
    for part in raw_name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
    {
        let lower = part.to_lowercase();
        if lower.chars().all(|ch| ch.is_ascii_digit()) {
            acronym.push_str(&lower);
            continue;
        }
        if let Some(ch) = lower.chars().next() {
            acronym.push(ch);
        }
    }
    acronym
}

#[cfg(target_os = "windows")]
fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut it = haystack.chars();
    for ch in needle.chars() {
        if !it.by_ref().any(|h| h == ch) {
            return false;
        }
    }
    true
}

#[cfg(all(unix, not(target_os = "macos")))]
fn search_linux_bin(candidate: &str) -> Option<String> {
    let output = Command::new("which").arg(candidate).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let first_line = text.lines().find(|line| !line.trim().is_empty())?;
    Some(first_line.trim().to_string())
}

#[cfg(target_os = "windows")]
fn walk_find_file_match<F>(
    roots: &[PathBuf],
    depth_limit: usize,
    max_entries: usize,
    mut matcher: F,
) -> Option<PathBuf>
where
    F: FnMut(&PathBuf) -> bool,
{
    let mut stack: Vec<(PathBuf, usize)> = roots
        .iter()
        .filter(|root| root.exists())
        .map(|root| (root.clone(), 0usize))
        .collect();
    let mut visited = 0usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > depth_limit {
            continue;
        }

        let entries = match fs::read_dir(&dir) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for entry in entries {
            if visited >= max_entries {
                return None;
            }
            visited += 1;

            let entry = match entry {
                Ok(v) => v,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if path.is_file() && matcher(&path) {
                return Some(path);
            }
        }
    }

    None
}

fn normalize_token(input: &str) -> String {
    input
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn split_command_line(raw: &str) -> Result<Vec<String>, RouterError> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in raw.chars() {
        match ch {
            '\'' | '"' => {
                if let Some(active_quote) = quote {
                    if active_quote == ch {
                        quote = None;
                    } else {
                        current.push(ch);
                    }
                } else {
                    quote = Some(ch);
                }
            }
            ' ' | '\t' if quote.is_none() => {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return Err(RouterError::InvalidArgs("aspas nao fechadas em 'name'"));
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    Ok(tokens)
}

fn format_router_error(err: RouterError) -> String {
    let payload = err.payload();
    format!("{}: {}", payload.code, payload.message)
}

fn write_audit_log(command: &str, args: &Value, success: bool, error_code: Option<&str>, message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let entry = json!({
        "timestamp": timestamp,
        "command": command,
        "args": args,
        "success": success,
        "error_code": error_code,
        "message": message,
    });

    let line = entry.to_string();

    if is_debug_mode() {
        log::info!("[audit] {}", line);
    }

    let log_file = audit_log_path();
    if let Some(parent) = log_file.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log::error!("[audit] failed to create log directory: {}", e);
            return;
        }
    }

    let mut file = match OpenOptions::new().create(true).append(true).open(&log_file) {
        Ok(file) => file,
        Err(e) => {
            log::error!("[audit] failed to open {}: {}", log_file.display(), e);
            return;
        }
    };

    if let Err(e) = writeln!(file, "{}", line) {
        log::error!("[audit] failed to write {}: {}", log_file.display(), e);
    }
}

fn write_skill_step_audit_log(
    skill_id: &str,
    step_index: usize,
    command: &str,
    args: &Value,
    success: bool,
    error_code: Option<&str>,
    message: &str,
) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let entry = json!({
        "timestamp": timestamp,
        "kind": "skill_step",
        "skill_id": skill_id,
        "step_index": step_index,
        "command": command,
        "args": args,
        "success": success,
        "error_code": error_code,
        "message": message,
    });

    let line = entry.to_string();

    if is_debug_mode() {
        log::info!("[audit][skill] {}", line);
    }

    let log_file = audit_log_path();
    if let Some(parent) = log_file.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log::error!("[audit][skill] failed to create log directory: {}", e);
            return;
        }
    }

    let mut file = match OpenOptions::new().create(true).append(true).open(&log_file) {
        Ok(file) => file,
        Err(e) => {
            log::error!("[audit][skill] failed to open {}: {}", log_file.display(), e);
            return;
        }
    };

    if let Err(e) = writeln!(file, "{}", line) {
        log::error!("[audit][skill] failed to write {}: {}", log_file.display(), e);
    }
}

fn audit_log_path() -> PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".nexus").join("audit.log")
}

fn is_debug_mode() -> bool {
    if cfg!(debug_assertions) {
        return true;
    }

    std::env::var("NEXUS_DEBUG")
        .map(|value| {
            let normalized = value.trim().to_lowercase();
            normalized == "1" || normalized == "true" || normalized == "yes"
        })
        .unwrap_or(false)
}

fn sanitize_skill_file_stem(id: &str) -> String {
    let mut normalized: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();

    normalized = normalized.trim_matches('-').to_string();
    if normalized.is_empty() {
        "skill".to_string()
    } else {
        normalized
    }
}

fn find_user_skill_file_by_id(skills_dir: &PathBuf, skill_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(skills_dir).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let text = fs::read_to_string(&path).ok()?;
        let json: Value = serde_json::from_str(&text).ok()?;
        let id = json.get("id").and_then(|v| v.as_str())?;
        if id.trim() == skill_id {
            return Some(path);
        }
    }
    None
}

fn read_skill_version_from_path(path: &PathBuf) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

fn compare_semver_strings(a: &str, b: &str) -> i32 {
    let pa: Vec<i32> = a
        .split('.')
        .map(|part| part.parse::<i32>().unwrap_or(0))
        .collect();
    let pb: Vec<i32> = b
        .split('.')
        .map(|part| part.parse::<i32>().unwrap_or(0))
        .collect();

    let len = pa.len().max(pb.len());
    for idx in 0..len {
        let av = *pa.get(idx).unwrap_or(&0);
        let bv = *pb.get(idx).unwrap_or(&0);
        if av > bv {
            return 1;
        }
        if av < bv {
            return -1;
        }
    }

    0
}

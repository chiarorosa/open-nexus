use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use url::Url;

#[derive(Debug, Clone, Copy)]
pub enum AllowedCommand {
    Ping,
    OpenUrl,
    SearchWeb,
    CreateFolder,
    LaunchApp,
}

#[derive(Debug, Clone)]
pub enum CommandArgs {
    None,
    OpenUrl { url: String },
    SearchWeb { query: String },
    CreateFolder { path: String },
    LaunchApp { name: String },
}

#[derive(Debug, Clone)]
pub struct ValidatedCommand {
    pub command: AllowedCommand,
    pub args: CommandArgs,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouterErrorPayload {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum RouterError {
    UnauthorizedCommand(String),
    InvalidArgs(&'static str),
    InvalidUrl(String),
    InvalidPath(String),
    NotAllowedPath(String),
    InvalidAppName(String),
    ExecutionFailed(String),
    Internal(String),
}

impl RouterError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnauthorizedCommand(_) => "UNAUTHORIZED_COMMAND",
            Self::InvalidArgs(_) => "INVALID_ARGS",
            Self::InvalidUrl(_) => "INVALID_URL",
            Self::InvalidPath(_) => "INVALID_PATH",
            Self::NotAllowedPath(_) => "PATH_NOT_ALLOWED",
            Self::InvalidAppName(_) => "INVALID_APP_TARGET",
            Self::ExecutionFailed(_) => "EXECUTION_FAILED",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }

    pub fn payload(&self) -> RouterErrorPayload {
        RouterErrorPayload {
            code: self.code(),
            message: self.to_string(),
        }
    }
}

impl fmt::Display for RouterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnauthorizedCommand(cmd) => write!(f, "Comando nao autorizado: {}", cmd),
            Self::InvalidArgs(msg) => write!(f, "Argumentos invalidos: {}", msg),
            Self::InvalidUrl(url) => write!(f, "URL invalida: {}", url),
            Self::InvalidPath(path) => write!(f, "Caminho invalido: {}", path),
            Self::NotAllowedPath(path) => write!(
                f,
                "Caminho fora do escopo permitido (Desktop ou Documents/Nexus): {}",
                path
            ),
            Self::InvalidAppName(name) => write!(f, "Aplicativo ou script invalido: {}", name),
            Self::ExecutionFailed(msg) => write!(f, "Falha ao executar comando: {}", msg),
            Self::Internal(msg) => write!(f, "Erro interno: {}", msg),
        }
    }
}

impl std::error::Error for RouterError {}

pub fn validate(command: &str, args: &Value) -> Result<ValidatedCommand, RouterError> {
    match command {
        "ping" => Ok(ValidatedCommand {
            command: AllowedCommand::Ping,
            args: CommandArgs::None,
        }),
        "open_url" => {
            let url = read_string_arg(args, "url")?;
            validate_url(&url)?;
            Ok(ValidatedCommand {
                command: AllowedCommand::OpenUrl,
                args: CommandArgs::OpenUrl { url },
            })
        }
        "search_web" => {
            let query = read_string_arg(args, "query")?;
            if query.trim().is_empty() {
                return Err(RouterError::InvalidArgs("'query' nao pode ser vazio"));
            }
            Ok(ValidatedCommand {
                command: AllowedCommand::SearchWeb,
                args: CommandArgs::SearchWeb { query },
            })
        }
        "create_folder" => {
            let path = read_string_arg(args, "path")?;
            validate_folder_path_input(&path)?;
            Ok(ValidatedCommand {
                command: AllowedCommand::CreateFolder,
                args: CommandArgs::CreateFolder { path },
            })
        }
        "launch_app" => {
            let name = read_string_arg(args, "name")?;
            validate_app_name(&name)?;
            let normalized = normalize_allowed_app_alias(&name);
            Ok(ValidatedCommand {
                command: AllowedCommand::LaunchApp,
                args: CommandArgs::LaunchApp {
                    name: normalized,
                },
            })
        }
        other => {
            log::warn!("[router] blocked unauthorized command: {}", other);
            Err(RouterError::UnauthorizedCommand(other.to_string()))
        }
    }
}

pub fn validate_url(url: &str) -> Result<(), RouterError> {
    let parsed = Url::parse(url).map_err(|_| RouterError::InvalidUrl(url.to_string()))?;
    let scheme = parsed.scheme().to_lowercase();
    if matches!(scheme.as_str(), "file" | "javascript" | "vbscript" | "data") {
        return Err(RouterError::InvalidUrl(url.to_string()));
    }

    if scheme == "http" || scheme == "https" {
        if parsed.host_str().is_none() {
            return Err(RouterError::InvalidUrl(url.to_string()));
        }
        return Ok(());
    }

    // Custom app protocols (e.g. steam://, discord://) are allowed.
    if parsed.host_str().is_none() && parsed.path().trim_matches('/').is_empty() {
        return Err(RouterError::InvalidUrl(url.to_string()));
    }

    Ok(())
}

pub fn resolve_allowed_folder_path(path: &str) -> Result<PathBuf, RouterError> {
    validate_folder_path_input(path)?;

    let home = dirs_next::home_dir().ok_or_else(|| {
        RouterError::Internal("Nao foi possivel resolver o diretorio HOME".to_string())
    })?;
    let desktop_base = home.join("Desktop");
    let docs_nexus_base = home.join("Documents").join("Nexus");

    let raw = path.trim();
    let mut target = if raw.starts_with("~/") || raw.starts_with("~\\") {
        let stripped = raw[2..].replace('\\', "/");
        home.join(stripped)
    } else {
        PathBuf::from(raw)
    };

    if target.is_relative() {
        target = desktop_base.join(target);
    }

    if has_parent_dir_component(&target) {
        return Err(RouterError::InvalidPath(path.to_string()));
    }

    if target.starts_with(&desktop_base) || target.starts_with(&docs_nexus_base) {
        return Ok(target);
    }

    Err(RouterError::NotAllowedPath(path.to_string()))
}

fn read_string_arg(args: &Value, key: &'static str) -> Result<String, RouterError> {
    let value = args
        .get(key)
        .ok_or(RouterError::InvalidArgs("objeto 'args' incompleto"))?;

    let text = value
        .as_str()
        .ok_or(RouterError::InvalidArgs("tipo de argumento invalido"))?
        .trim()
        .to_string();

    if text.is_empty() {
        return Err(RouterError::InvalidArgs("argumento string vazio"));
    }

    Ok(text)
}

fn validate_folder_path_input(path: &str) -> Result<(), RouterError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(RouterError::InvalidPath(path.to_string()));
    }
    if trimmed.contains('\0') {
        return Err(RouterError::InvalidPath(path.to_string()));
    }
    if trimmed.contains("..") {
        return Err(RouterError::InvalidPath(path.to_string()));
    }

    let p = Path::new(trimmed);
    if has_parent_dir_component(p) {
        return Err(RouterError::InvalidPath(path.to_string()));
    }

    Ok(())
}

fn has_parent_dir_component(path: &Path) -> bool {
    path.components().any(|component| matches!(component, Component::ParentDir))
}

fn validate_app_name(name: &str) -> Result<(), RouterError> {
    if name.len() > 260 {
        return Err(RouterError::InvalidArgs("'name' muito longo"));
    }

    if name.trim().is_empty() {
        return Err(RouterError::InvalidArgs("'name' nao pode ser vazio"));
    }

    if name.contains('\0') || name.contains('\n') || name.contains('\r') {
        return Err(RouterError::InvalidArgs(
            "'name' contem caracteres de controle nao permitidos",
        ));
    }

    // Bloqueia metacaracteres de shell para evitar injecoes em command-line.
    if name.contains('|')
        || name.contains('&')
        || name.contains(';')
        || name.contains('>')
        || name.contains('<')
        || name.contains('`')
    {
        return Err(RouterError::InvalidArgs(
            "'name' contem caracteres nao permitidos",
        ));
    }

    let valid = name.chars().all(|c| {
        c.is_alphanumeric()
            || c == ' '
            || c == '-'
            || c == '_'
            || c == '.'
            || c == '\\'
            || c == '/'
            || c == ':'
            || c == '('
            || c == ')'
            || c == '['
            || c == ']'
            || c == '"'
            || c == '\''
            || c == '='
            || c == ','
            || c == '+'
    });

    if !valid {
        return Err(RouterError::InvalidArgs(
            "'name' contem caracteres nao permitidos",
        ));
    }

    Ok(())
}

fn normalize_allowed_app_alias(name: &str) -> String {
    let normalized = normalize_launch_phrase(name);
    let mapped = match normalized.as_str() {
        "vs code" | "vscode" | "visual studio code" | "code" => Some("vscode"),
        "steam" => Some("steam"),
        "chrome" | "google chrome" => Some("chrome"),
        "edge" | "microsoft edge" => Some("edge"),
        "firefox" | "mozilla firefox" => Some("firefox"),
        "terminal" | "windows terminal" | "console" | "cmd" | "prompt de comando" => {
            Some("terminal")
        }
        "notepad" | "bloco de notas" | "textedit" | "editor de texto" => Some("notepad"),
        "explorer" | "file explorer" | "explorador de arquivos" | "finder" => {
            Some("file-explorer")
        }
        "calculator" | "calculadora" => Some("calculator"),
        "spotify" => Some("spotify"),
        "slack" => Some("slack"),
        "discord" => Some("discord"),
        _ => None,
    };

    mapped.unwrap_or(name.trim()).to_string()
}

fn normalize_launch_phrase(name: &str) -> String {
    let mut normalized = name.trim().to_lowercase();

    for prefix in [
        "abrir ",
        "abra ",
        "iniciar ",
        "inicie ",
        "executar ",
        "execute ",
    ] {
        if normalized.starts_with(prefix) {
            normalized = normalized[prefix.len()..].trim_start().to_string();
            break;
        }
    }

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
        if normalized.starts_with(prefix) {
            normalized = normalized[prefix.len()..].trim_start().to_string();
            break;
        }
    }

    normalized
}

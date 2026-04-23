// Nexus — Desktop AI Assistant
// Architecture: LLM suggests → Backend validates → System executes

mod commands;
mod router;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Mandatory plugins (TECHNICAL_SCOPE §6)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // App setup: register global shortcuts
        .setup(|app| {
            let alt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            let alt_v = Shortcut::new(Some(Modifiers::ALT), Code::KeyV);

            app.global_shortcut().on_shortcut(alt_space, move |app, _shortcut, event| {
                // Only act on key PRESS — the callback fires on both press and release,
                // which would toggle the window twice (show → immediately hide).
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("nexus://window-opened", ());
                    }
                }
            })?;

            app.global_shortcut().on_shortcut(alt_v, move |app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }

                if let Some(window) = app.get_webview_window("main") {
                    // Voice shortcut: ensure window is visible/focused before toggling mic.
                    if !window.is_visible().unwrap_or(false) {
                        let _ = window.show();
                        let _ = window.emit("nexus://window-opened", ());
                    }
                    let _ = window.set_focus();
                    let _ = window.emit("nexus://toggle-mic", ());
                }
            })?;

            Ok(())
        })
        // IPC command handlers
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::sample_process_cpu_percent,
            commands::load_user_skills,
            commands::save_user_skill,
            commands::update_user_skill,
            commands::export_skill_pack,
            commands::import_skill_pack,
            commands::execute_skill_plan,
            commands::create_folder,
            commands::open_url,
            commands::launch_app,
            commands::open_skills_directory,
            commands::resolve_launch_target,
            commands::execute_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}


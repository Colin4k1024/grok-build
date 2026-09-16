#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod acp_bridge;
mod commands;
mod state;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::session::session_create,
            commands::session::session_send,
            commands::session::session_cancel,
            commands::session::session_close,
            commands::session::session_list,
            commands::session::session_list_history,
            commands::session::session_get_history,
            commands::session::session_set_model,
            commands::session::respond_permission,
            commands::session::session_compact,
            commands::config::get_config,
            commands::config::save_config,
            commands::config::save_models,
            commands::auth::check_auth_status,
            commands::auth::login,
            commands::auth::logout,
            commands::apikey::save_api_key,
            commands::apikey::get_api_key,
            commands::apikey::delete_api_key,
            commands::apikey::list_api_keys,
            commands::apikey::get_all_api_keys,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

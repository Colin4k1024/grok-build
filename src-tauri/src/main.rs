#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod acp_bridge;
mod commands;
mod state;

use state::AppState;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["CmdOrCtrl+Shift+A"])
                .unwrap()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(AppState::new())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Minimize to tray instead of closing
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Build system tray menu
            let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let new_item = MenuItem::with_id(app, "new", "New Session", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &new_item, &quit_item])?;

            let icon = app.default_window_icon()
                .ok_or("no default window icon")?
                .clone();

            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .menu(&menu)
                .tooltip("Grok Build")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "new" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.emit("tray-action", "new-session");
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::session_create,
            commands::session::session_send,
            commands::session::session_cancel,
            commands::session::session_close,
            commands::session::session_list,
            commands::session::session_list_history,
            commands::session::session_get_history,
            commands::session::session_set_model,
            commands::session::session_compact,
            commands::session::update_tray_badge,
            commands::session::respond_permission,
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
            commands::autostart::autostart_enable,
            commands::autostart::autostart_disable,
            commands::autostart::autostart_is_enabled,
            commands::mcp::get_mcp_servers,
            commands::mcp::save_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::toggle_mcp_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

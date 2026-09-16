use tauri_plugin_autostart::AutoLaunchManager;

#[tauri::command]
pub async fn autostart_enable(manager: tauri::State<'_, AutoLaunchManager>) -> Result<(), String> {
    manager.enable().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn autostart_disable(manager: tauri::State<'_, AutoLaunchManager>) -> Result<(), String> {
    manager.disable().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn autostart_is_enabled(manager: tauri::State<'_, AutoLaunchManager>) -> Result<bool, String> {
    Ok(manager.is_enabled().unwrap_or(false))
}

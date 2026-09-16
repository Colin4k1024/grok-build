use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub username: Option<String>,
}

#[tauri::command]
pub async fn check_auth_status() -> Result<AuthStatus, String> {
    // Full auth check in Phase1-06 (#22)
    Ok(AuthStatus {
        authenticated: false,
        username: None,
    })
}

#[tauri::command]
pub async fn login() -> Result<(), String> {
    // Full login flow in Phase1-06 (#22)
    Ok(())
}

#[tauri::command]
pub async fn logout() -> Result<(), String> {
    Ok(())
}

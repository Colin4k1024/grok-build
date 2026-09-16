use crate::state::AppState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateSessionArgs {
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub cwd: String,
}

#[tauri::command]
pub async fn session_create(
    state: tauri::State<'_, AppState>,
    args: CreateSessionArgs,
) -> Result<SessionInfo, String> {
    let id = format!("session-{}", uuid_like_id());
    let handle = crate::acp_bridge::SessionHandle {
        id: id.clone(),
        cwd: args.cwd.clone(),
    };
    state.sessions.write().push(handle);
    Ok(SessionInfo { id, cwd: args.cwd })
}

#[derive(Debug, Deserialize)]
pub struct SendArgs {
    pub session_id: String,
    pub message: String,
}

#[tauri::command]
pub async fn session_send(_state: tauri::State<'_, AppState>, _args: SendArgs) -> Result<(), String> {
    // Full ACP send logic in Phase1-02 (#18)
    Ok(())
}

#[tauri::command]
pub async fn session_cancel(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Cancel logic in Phase1-02 (#18)
    let _ = state;
    let _ = session_id;
    Ok(())
}

#[tauri::command]
pub async fn session_close(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.write();
    sessions.retain(|s| s.id != session_id);
    Ok(())
}

fn uuid_like_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}")
}

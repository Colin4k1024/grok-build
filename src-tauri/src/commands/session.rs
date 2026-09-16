use crate::acp_bridge::{self, AcpEvent};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Debug, Deserialize)]
pub struct CreateSessionArgs {
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub cwd: String,
    pub acp_session_id: String,
    pub models: Vec<ModelSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelSummary {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn session_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: CreateSessionArgs,
) -> Result<SessionInfo, String> {
    let cwd = PathBuf::from(&args.cwd);
    let session_id = format!("session-{}", nanoid());

    let (spawned, mut event_rx) =
        acp_bridge::create_and_init_session(session_id.clone(), cwd)
            .map_err(|e| e.to_string())?;

    let acp_session_id = spawned.handle.acp_session_id.clone();
    let models: Vec<ModelSummary> = spawned
        .models
        .iter()
        .map(|m| ModelSummary { id: m.id.clone(), name: m.name.clone() })
        .collect();

    state.pool.sessions.write().push(spawned.handle);

    // Spawn event forwarder: ACP events → Tauri events
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = app_handle.emit("acp_event", &event);
        }
    });

    // Emit SessionReady
    let _ = app.emit("acp_event", AcpEvent::SessionReady {
        session_id: session_id.clone(),
        models: spawned.models.clone(),
    });

    Ok(SessionInfo { id: session_id, cwd: args.cwd, acp_session_id, models })
}

#[derive(Debug, Deserialize)]
pub struct SendArgs {
    pub session_id: String,
    pub message: String,
}

#[tauri::command]
pub async fn session_send(state: tauri::State<'_, AppState>, args: SendArgs) -> Result<(), String> {
    let cmd_tx = {
        let sessions = state.pool.sessions.read();
        sessions
            .iter()
            .find(|s| s.id == args.session_id)
            .ok_or_else(|| format!("Session {} not found", args.session_id))?
            .cmd_tx.clone()
    };
    acp_bridge::send_prompt_cmd(&cmd_tx, args.message).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_cancel(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    let sessions = state.pool.sessions.read();
    if let Some(handle) = sessions.iter().find(|s| s.id == session_id) {
        acp_bridge::cancel_turn(handle);
    }
    Ok(())
}

#[tauri::command]
pub async fn session_close(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.pool.sessions.write().retain(|s| s.id != session_id);
    Ok(())
}

fn nanoid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{nanos:x}")
}

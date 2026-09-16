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
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    eprintln!("[{ts}] [CMD] session_create invoked: cwd={}", args.cwd);

    // Canonicalize the cwd to an absolute path — ACP NewSession requires it.
    let cwd = if std::path::Path::new(&args.cwd).is_absolute() {
        PathBuf::from(&args.cwd)
    } else {
        std::env::current_dir()
            .map(|d| d.join(&args.cwd))
            .and_then(|p| dunce::canonicalize(&p).or(Ok(p)))
            .unwrap_or_else(|_| PathBuf::from(&args.cwd))
    };
    let session_id = format!("session-{}", nanoid());
    eprintln!("[{ts}] [CMD] session_id={session_id}, spawning via spawn_blocking...");

    // create_and_init_session uses blocking_recv() internally, which panics
    // if called from within a tokio runtime. Wrap it in spawn_blocking.
    let session_id_for_blocking = session_id.clone();
    let (spawned, mut event_rx) =
        tauri::async_runtime::spawn_blocking(move || {
            acp_bridge::create_and_init_session(session_id_for_blocking, cwd)
        })
        .await
        .map_err(|e| format!("Blocking task panicked: {e}"))?
        .map_err(|e| { eprintln!("[{ts}] [CMD] create_and_init_session FAILED: {e}"); e.to_string() })?;
    eprintln!("[{ts}] [CMD] create_and_init_session OK, acp_session_id={}", spawned.handle.acp_session_id);

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
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
}

#[derive(Debug, Deserialize)]
pub struct ImageAttachment {
    pub data: String,
    pub mime_type: String,
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
    let images: Vec<acp_bridge::AttachmentImage> = args.images
        .iter()
        .map(|i| acp_bridge::AttachmentImage {
            data: i.data.clone(),
            mime_type: i.mime_type.clone(),
        })
        .collect();
    acp_bridge::send_prompt_cmd(&cmd_tx, args.message, images)
        .await
        .map_err(|e| e.to_string())
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

#[derive(Debug, Serialize)]
pub struct SessionListItem {
    pub id: String,
    pub cwd: String,
    pub acp_session_id: String,
}

#[tauri::command]
pub async fn session_list(state: tauri::State<'_, AppState>) -> Result<Vec<SessionListItem>, String> {
    let sessions = state.pool.sessions.read();
    Ok(sessions
        .iter()
        .map(|s| SessionListItem {
            id: s.id.clone(),
            cwd: s.cwd.clone(),
            acp_session_id: s.acp_session_id.clone(),
        })
        .collect())
}

// --- Session history ---

#[derive(Debug, Serialize)]
pub struct HistorySession {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub model: String,
    pub created_at: String,
    pub last_active_at: String,
    pub num_messages: usize,
}

#[derive(Debug, Serialize)]
pub struct ChatHistoryEntry {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
struct SummaryJson {
    info: SummaryInfo,
    #[serde(default)]
    generated_title: Option<String>,
    #[serde(default)]
    session_summary: Option<String>,
    #[serde(default)]
    current_model_id: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    last_active_at: Option<String>,
    #[serde(default)]
    num_messages: Option<usize>,
}

#[derive(Deserialize)]
struct SummaryInfo {
    id: String,
    cwd: String,
}

#[derive(Deserialize)]
struct ChatHistoryLine {
    #[serde(rename = "type")]
    line_type: String,
    #[serde(default)]
    content: serde_json::Value,
}

fn extract_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            let texts: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                })
                .collect();
            texts.join("\n")
        }
        _ => String::new(),
    }
}

#[tauri::command]
pub async fn session_list_history() -> Result<Vec<HistorySession>, String> {
    let sessions_root = xai_dirs::grok_home().join("sessions");
    if !sessions_root.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();

    let cwd_dirs = std::fs::read_dir(&sessions_root)
        .map_err(|e| format!("Failed to read sessions dir: {e}"))?;

    for cwd_entry in cwd_dirs.flatten() {
        if !cwd_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let cwd_path = cwd_entry.path();
        let session_dirs = match std::fs::read_dir(&cwd_path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for session_entry in session_dirs.flatten() {
            if !session_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let summary_path = session_entry.path().join("summary.json");
            let summary_str = match std::fs::read_to_string(&summary_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let summary: SummaryJson = match serde_json::from_str(&summary_str) {
                Ok(s) => s,
                Err(_) => continue,
            };

            sessions.push(HistorySession {
                id: summary.info.id.clone(),
                cwd: summary.info.cwd.clone(),
                title: summary
                    .generated_title
                    .or(summary.session_summary)
                    .unwrap_or_else(|| "Untitled".to_string()),
                model: summary.current_model_id.unwrap_or_default(),
                created_at: summary.created_at.unwrap_or_default(),
                last_active_at: summary.last_active_at.unwrap_or_default(),
                num_messages: summary.num_messages.unwrap_or(0),
            });
        }
    }

    // Sort by last_active_at descending
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn session_get_history(session_id: String, cwd: String) -> Result<Vec<ChatHistoryEntry>, String> {
    let sessions_dir = xai_grok_config::sessions_cwd_dir(&cwd);
    let history_path = sessions_dir.join(&session_id).join("chat_history.jsonl");

    let content = std::fs::read_to_string(&history_path)
        .map_err(|e| format!("Failed to read chat history: {e}"))?;

    let mut entries = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parsed: ChatHistoryLine = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Only show user and assistant messages (skip system)
        if parsed.line_type == "system" {
            continue;
        }
        entries.push(ChatHistoryEntry {
            role: parsed.line_type.clone(),
            content: extract_text(&parsed.content),
        });
    }

    Ok(entries)
}

#[derive(Debug, Deserialize)]
pub struct SetModelArgs {
    pub session_id: String,
    pub model_id: String,
}

#[tauri::command]
pub async fn session_set_model(state: tauri::State<'_, AppState>, args: SetModelArgs) -> Result<(), String> {
    let cmd_tx = {
        let sessions = state.pool.sessions.read();
        sessions
            .iter()
            .find(|s| s.id == args.session_id)
            .ok_or_else(|| format!("Session {} not found", args.session_id))?
            .cmd_tx.clone()
    };
    acp_bridge::set_model_cmd(&cmd_tx, args.model_id)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct RespondPermissionArgs {
    pub session_id: String,
    pub request_id: String,
    pub option_id: String,
    pub remember: bool,
}

#[tauri::command]
pub async fn respond_permission(state: tauri::State<'_, AppState>, args: RespondPermissionArgs) -> Result<(), String> {
    let cmd_tx = {
        let sessions = state.pool.sessions.read();
        sessions
            .iter()
            .find(|s| s.id == args.session_id)
            .ok_or_else(|| format!("Session {} not found", args.session_id))?
            .cmd_tx.clone()
    };
    let _ = cmd_tx.send(acp_bridge::SessionCommand::RespondPermission {
        request_id: args.request_id,
        option_id: args.option_id,
        remember: args.remember,
    });
    Ok(())
}

#[tauri::command]
pub async fn session_compact(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    let cmd_tx = {
        let sessions = state.pool.sessions.read();
        sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?
            .cmd_tx.clone()
    };
    acp_bridge::compact_cmd(&cmd_tx)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_tray_badge(app: tauri::AppHandle, unread: u64) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let tooltip = if unread > 0 {
            format!("Grok Build — {} unread", unread)
        } else {
            "Grok Build".to_string()
        };
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

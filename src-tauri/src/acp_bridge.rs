//! ACP Bridge — spawns grok-shell agent and bridges ACP messages to the frontend.
//!
//! The agent runs on a dedicated thread with a single-threaded tokio runtime
//! (mirroring the pager's architecture). Communication happens via channels.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol as acp;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use xai_acp_lib::{AcpClientMessage, acp_send};
use xai_grok_pager::acp::select_eager_auth_method;
use xai_grok_shell::agent::config::Config as AgentConfig;

/// Commands sent to the agent worker thread.
pub enum SessionCommand {
    SendPrompt { message: String, images: Vec<AttachmentImage>, reply: oneshot::Sender<Result<(), String>> },
    SetModel { model_id: String, reply: oneshot::Sender<Result<(), String>> },
    RespondPermission {
        request_id: String,
        option_id: String,
        remember: bool,
    },
    Cancel,
    Compact { reply: oneshot::Sender<Result<(), String>> },
    Shutdown,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct AttachmentImage {
    pub data: String,
    pub mime_type: String,
}

/// A handle to a running ACP session.
pub struct SessionHandle {
    pub id: String,
    pub cwd: String,
    pub acp_session_id: String,
    pub cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    pub cancel: CancellationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AcpEvent {
    TextDelta { session_id: String, delta: String },
    ToolCall { session_id: String, tool_name: String },
    ToolResult { session_id: String, tool_name: String, output: String, success: bool },
    TurnComplete { session_id: String },
    Error { session_id: String, message: String },
    SessionReady { session_id: String, models: Vec<ModelSummary> },
    PermissionRequest {
        session_id: String,
        request_id: String,
        tool_name: String,
        command: String,
        options: Vec<PermissionOption>,
    },
    PlanUpdate {
        session_id: String,
        entries: Vec<PlanEntryDto>,
    },
    UsageUpdate {
        session_id: String,
        used: u64,
        size: u64,
    },
    CompactionStatus {
        session_id: String,
        status: String,
        tokens_before: Option<u64>,
        tokens_after: Option<u64>,
        summary: Option<String>,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanEntryDto {
    pub content: String,
    pub status: String,
    pub priority: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSummary {
    pub id: String,
    pub name: String,
}

pub struct SpawnedSession {
    pub handle: SessionHandle,
    pub models: Vec<ModelSummary>,
}

/// Create and initialize an ACP session on a dedicated thread.
///
/// Spawns the agent via `spawn_grok_shell`, drives the ACP lifecycle, then
/// enters a message loop forwarding events. All of this runs on a dedicated
/// thread because the agent uses `Rc`/`LocalSet` (non-Send).
pub fn create_and_init_session(
    session_id: String,
    cwd: PathBuf,
) -> anyhow::Result<(
    SpawnedSession,
    mpsc::UnboundedReceiver<AcpEvent>,
)> {
    let (event_tx, event_rx) = mpsc::unbounded_channel::<AcpEvent>();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
    let cancel = CancellationToken::new();

    let init_cwd = cwd.clone();
    let init_session_id = session_id.clone();
    let init_cancel = cancel.clone();
    let init_event_tx = event_tx.clone();

    // Spawn a dedicated OS thread with its own runtime for the agent.
    // The agent uses Rc/LocalSet internally, so it cannot run on the
    // multi-threaded Tauri runtime directly.
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(String, Vec<ModelSummary>), String>>();

    std::thread::Builder::new()
        .name("grok-acp-bridge".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(1)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("Failed to create runtime: {e}")));
                    return;
                }
            };

            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                if let Err(e) = run_agent_loop(
                    init_session_id, init_cwd, init_cancel, cmd_rx, init_event_tx, ready_tx,
                ).await {
                    eprintln!("[BRIDGE] run_agent_loop exited with error: {e}");
                }
            });
        })
        .map_err(|e| anyhow::anyhow!("Failed to spawn agent thread: {e}"))?;

    eprintln!("[BRIDGE] waiting for agent thread to be ready (blocking_recv)...");
    // Wait for the agent to be ready (or fail)
    let (acp_session_id, models) = ready_rx.blocking_recv()
        .map_err(|_| { eprintln!("[BRIDGE] ERROR: agent thread died before responding"); anyhow::anyhow!("Agent thread died before responding") })?
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let handle = SessionHandle {
        id: session_id.clone(),
        cwd: cwd.to_string_lossy().to_string(),
        acp_session_id,
        cmd_tx,
        cancel,
    };

    Ok((SpawnedSession { handle, models }, event_rx))
}

/// Runs on the dedicated agent thread: spawns the agent, drives ACP lifecycle,
/// then loops forwarding events and handling commands.
async fn run_agent_loop(
    session_id: String,
    cwd: PathBuf,
    cancel: CancellationToken,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    event_tx: mpsc::UnboundedSender<AcpEvent>,
    ready_tx: oneshot::Sender<Result<(String, Vec<ModelSummary>), String>>,
) -> anyhow::Result<()> {
    use xai_grok_pager::acp::spawn::{spawn_grok_shell, AgentShutdownGuard, SpawnedAgent};

    // Load config
    let raw_config = xai_grok_shell::config::load_effective_config()
        .map_err(|e| anyhow::anyhow!("Failed to load config: {e}"))?;
    let mut agent_config = AgentConfig::new_from_toml_cfg(&raw_config)
        .map_err(|e| anyhow::anyhow!("Failed to create agent config: {e}"))?;

    agent_config.resolve_runtime_fields(
        &xai_grok_shell::agent::config::RuntimeResolutionContext {
            raw_config: &raw_config,
            remote_settings: None,
            is_headless: true,
            cli_subagents: None,
            cli_web_search_model: None,
            cli_session_summary_model: None,
            memory_enabled_override: None,
            disable_web_search: false,
            todo_gate: false,
            laziness_debug_log: None,
            storage_mode: None,
        },
    );
    agent_config.mode = xai_grok_shell::agent::config::AgentMode::Headless;
    agent_config.default_yolo_mode = true;

    // Inject keychain-stored API keys into the process environment so the
    // agent can resolve them via std::env::var. The agent reads credentials
    // from env vars, not the OS keychain — this bridges the gap.
    let env_keys = crate::commands::config::collect_model_env_keys();
    crate::commands::apikey::inject_stored_keys_into_env(&env_keys);

    let memory_config = agent_config.memory_config.clone();

    // Spawn the agent
    let spawned: SpawnedAgent = match spawn_grok_shell(agent_config, &cancel, memory_config).await {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("Couldn't start session: {e}");
            let _ = ready_tx.send(Err(msg.clone()));
            return Err(anyhow::anyhow!(msg));
        }
    };

    let _guard = AgentShutdownGuard::new(cancel.clone(), Some(spawned.thread_handle));
    let acp_tx = spawned.channel.tx.clone();
    let mut acp_rx = spawned.channel.rx;

    // 1. Initialize
    let init_req = acp::InitializeRequest::new(acp::ProtocolVersion::V1)
        .client_capabilities(
            acp::ClientCapabilities::new()
                .fs(acp::FileSystemCapabilities::new())
                .terminal(false),
        );
    let init_resp: acp::InitializeResponse = match acp_send(init_req, &acp_tx).await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Initialize failed: {e}");
            let _ = ready_tx.send(Err(msg.clone()));
            return Err(anyhow::anyhow!(msg));
        }
    };

    // 2. Authenticate
    let default_auth_method_id = init_resp
        .meta
        .as_ref()
        .and_then(|m| m.get("defaultAuthMethodId"))
        .and_then(|v| v.as_str())
        .map(|s| acp::AuthMethodId::new(s.to_string()));

    let method_id = select_eager_auth_method(&init_resp.auth_methods, default_auth_method_id.as_ref())
        .ok_or_else(|| anyhow::anyhow!("No usable auth method available"))?;

    let _auth_resp: acp::AuthenticateResponse = match acp_send(
        acp::AuthenticateRequest::new(method_id), &acp_tx,
    ).await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Authenticate failed: {e}");
            let _ = ready_tx.send(Err(msg.clone()));
            return Err(anyhow::anyhow!(msg));
        }
    };

    // 3. Create session
    let new_resp: acp::NewSessionResponse = match acp_send(
        acp::NewSessionRequest::new(cwd.clone()), &acp_tx,
    ).await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("NewSession failed: {e}");
            let _ = ready_tx.send(Err(msg.clone()));
            return Err(anyhow::anyhow!(msg));
        }
    };

    let acp_session_id = new_resp.session_id.0.to_string();
    let models: Vec<ModelSummary> = new_resp
        .models
        .as_ref()
        .map(|state| {
            state.available_models.iter().map(|m| ModelSummary {
                id: m.model_id.0.to_string(),
                name: m.name.clone(),
            }).collect()
        })
        .unwrap_or_default();

    // Signal readiness to the caller — this unblocks create_and_init_session.
    let _ = ready_tx.send(Ok((acp_session_id.clone(), models.clone())));

    // 4. Main loop: forward ACP events + handle commands
    let fwd_session_id = session_id.clone();
    let session_id_for_loop = session_id.clone();
    use std::collections::HashMap;
    let mut pending_permissions: HashMap<String, oneshot::Sender<acp::Result<acp::RequestPermissionResponse>>> = HashMap::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            msg = acp_rx.recv() => {
                match msg {
                    Some(acp_msg) => {
                        // Intercept permission requests for inline approval UI
                        if let xai_acp_lib::AcpClientMessage::RequestPermission(args) = acp_msg {
                            let perm = &args.request;
                            let request_id = uuid::Uuid::new_v4().to_string();
                            let tool_name = perm.tool_call.fields.title.clone().unwrap_or_default();
                            let options: Vec<PermissionOption> = perm.options.iter().map(|o| PermissionOption {
                                id: o.option_id.0.to_string(),
                                label: o.name.clone(),
                                kind: format!("{:?}", o.kind),
                            }).collect();
                            let _ = event_tx.send(AcpEvent::PermissionRequest {
                                session_id: fwd_session_id.clone(),
                                request_id: request_id.clone(),
                                tool_name,
                                command: perm.options.iter()
                                    .filter_map(|o| if matches!(o.kind, acp::PermissionOptionKind::AllowOnce) { Some(o.name.clone()) } else { None })
                                    .next().unwrap_or_default(),
                                options,
                            });
                            pending_permissions.insert(request_id, args.response_tx);
                        } else {
                            if let Err(e) = forward_acp_message(&event_tx, &fwd_session_id, acp_msg, &acp_tx).await {
                                tracing::warn!("Failed to forward ACP message: {e}");
                            }
                        }
                    }
                    None => {
                        let _ = event_tx.send(AcpEvent::Error {
                            session_id: session_id_for_loop.clone(),
                            message: "Agent process exited".into(),
                        });
                        break;
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::SendPrompt { message, images, reply }) => {
                        let mut blocks: Vec<acp::ContentBlock> = Vec::new();
                        if !message.is_empty() {
                            blocks.push(acp::ContentBlock::Text(acp::TextContent::new(message)));
                        }
                        for img in &images {
                            let mut ic = acp::ImageContent::new(img.data.clone(), img.mime_type.clone());
                            blocks.push(acp::ContentBlock::Image(ic));
                        }
                        let prompt_id = uuid::Uuid::new_v4().to_string();
                        let mut meta = serde_json::Map::new();
                        meta.insert("promptId".to_string(), serde_json::Value::String(prompt_id));
                        meta.insert("screenMode".to_string(), serde_json::Value::String("desktop".to_string()));
                        let request = acp::PromptRequest::new(
                            new_resp.session_id.clone(),
                            blocks,
                        ).meta(Some(meta));
                        let result = acp_send(request, &acp_tx).await
                            .map(|_: acp::PromptResponse| ())
                            .map_err(|e| e.to_string());
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::SetModel { model_id, reply }) => {
                        let req = acp::SetSessionModelRequest::new(
                            new_resp.session_id.clone(),
                            acp::ModelId::new(model_id.clone()),
                        );
                        let result = acp_send(req, &acp_tx).await
                            .map(|_: acp::SetSessionModelResponse| ())
                            .map_err(|e| e.to_string());
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::RespondPermission { request_id, option_id, remember }) => {
                        if let Some(tx) = pending_permissions.remove(&request_id) {
                            let outcome = acp::RequestPermissionOutcome::Selected(
                                acp::SelectedPermissionOutcome::new(
                                    acp::PermissionOptionId::new(option_id),
                                ),
                            );
                            let _ = tx.send(Ok(acp::RequestPermissionResponse::new(outcome)));
                            if remember {
                                tracing::info!("User selected 'always approve' for permission request");
                            }
                        }
                    }
                    Some(SessionCommand::Compact { reply }) => {
                        let blocks = vec![acp::ContentBlock::Text(
                            acp::TextContent::new("/compact".to_string()),
                        )];
                        let request = acp::PromptRequest::new(
                            new_resp.session_id.clone(),
                            blocks,
                        );
                        let result = acp_send(request, &acp_tx).await
                            .map(|_: acp::PromptResponse| ())
                            .map_err(|e| e.to_string());
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::Cancel) => {
                        cancel.cancel();
                    }
                    Some(SessionCommand::Shutdown) | None => break,
                }
            }
        }
    }

    Ok(())
}

async fn forward_acp_message(
    event_tx: &mpsc::UnboundedSender<AcpEvent>,
    session_id: &str,
    msg: AcpClientMessage,
    _acp_tx: &xai_acp_lib::AcpAgentTx,
) -> anyhow::Result<()> {
    use xai_acp_lib::AcpClientMessage as M;
    match msg {
        M::SessionNotification(args) => {
            let notification = &args.request;
            match &notification.update {
                acp::SessionUpdate::AgentMessageChunk(chunk) => {
                    if let acp::ContentBlock::Text(text) = &chunk.content {
                        if !text.text.is_empty() {
                            let _ = event_tx.send(AcpEvent::TextDelta {
                                session_id: session_id.to_string(),
                                delta: text.text.clone(),
                            });
                        }
                    }
                }
                acp::SessionUpdate::AgentThoughtChunk(chunk) => {
                    if let acp::ContentBlock::Text(text) = &chunk.content {
                        if !text.text.is_empty() {
                            let _ = event_tx.send(AcpEvent::TextDelta {
                                session_id: session_id.to_string(),
                                delta: text.text.clone(),
                            });
                        }
                    }
                }
                acp::SessionUpdate::ToolCall(tc) => {
                    let _ = event_tx.send(AcpEvent::ToolCall {
                        session_id: session_id.to_string(),
                        tool_name: tc.title.clone(),
                    });
                }
                acp::SessionUpdate::ToolCallUpdate(update) => {
                    if let Some(status) = &update.fields.status {
                        if matches!(status, acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed) {
                            let output = update.fields.content.as_ref()
                                .and_then(|c| c.first())
                                .map(|c| serde_json::to_string(c).unwrap_or_default())
                                .unwrap_or_default();
                            let _ = event_tx.send(AcpEvent::ToolResult {
                                session_id: session_id.to_string(),
                                tool_name: String::new(),
                                output,
                                success: matches!(status, acp::ToolCallStatus::Completed),
                            });
                        }
                    }
                }
                acp::SessionUpdate::Plan(plan) => {
                    let entries: Vec<PlanEntryDto> = plan.entries.iter().map(|e| PlanEntryDto {
                        content: e.content.clone(),
                        status: format!("{:?}", e.status),
                        priority: format!("{:?}", e.priority),
                    }).collect();
                    let _ = event_tx.send(AcpEvent::PlanUpdate {
                        session_id: session_id.to_string(),
                        entries,
                    });
                }
                acp::SessionUpdate::UsageUpdate(usage) => {
                    let _ = event_tx.send(AcpEvent::UsageUpdate {
                        session_id: session_id.to_string(),
                        used: usage.used,
                        size: usage.size,
                    });
                }
                _ => {}
            }
        }
        M::RequestPermission(_) => {
            // Handled in the agent loop before forward_acp_message is called.
        }
        M::ReadTextFile(args) => {
            let _ = args.response_tx.send(Ok(acp::ReadTextFileResponse::new("")));
        }
        M::WriteTextFile(args) => {
            let _ = args.response_tx.send(Ok(acp::WriteTextFileResponse::new()));
        }
        M::ExtNotification(args) => {
            let method = args.method.to_string();
            if method == "x.ai/session_notification" {
                let params_str = args.params.get();
                if let Ok(params) = serde_json::from_str::<serde_json::Value>(params_str) {
                    if let Some(update_type) = params.get("sessionUpdate").and_then(|v| v.as_str()) {
                        match update_type {
                            "auto_compact_started" => {
                                let tokens_used = params.get("tokens_used").and_then(|v| v.as_u64());
                                let _ = event_tx.send(AcpEvent::CompactionStatus {
                                    session_id: session_id.to_string(),
                                    status: "started".into(),
                                    tokens_before: tokens_used,
                                    tokens_after: None,
                                    summary: None,
                                    error: None,
                                });
                            }
                            "auto_compact_completed" => {
                                let tokens_before = params.get("tokens_before").and_then(|v| v.as_u64());
                                let tokens_after = params.get("tokens_after").and_then(|v| v.as_u64());
                                let summary = params.get("summary_preview").and_then(|v| v.as_str()).map(|s| s.to_string());
                                let _ = event_tx.send(AcpEvent::CompactionStatus {
                                    session_id: session_id.to_string(),
                                    status: "completed".into(),
                                    tokens_before,
                                    tokens_after,
                                    summary,
                                    error: None,
                                });
                            }
                            "auto_compact_failed" => {
                                let error = params.get("error").and_then(|v| v.as_str()).map(|s| s.to_string());
                                let _ = event_tx.send(AcpEvent::CompactionStatus {
                                    session_id: session_id.to_string(),
                                    status: "failed".into(),
                                    tokens_before: None,
                                    tokens_after: None,
                                    summary: None,
                                    error,
                                });
                            }
                            "auto_compact_cancelled" => {
                                let _ = event_tx.send(AcpEvent::CompactionStatus {
                                    session_id: session_id.to_string(),
                                    status: "cancelled".into(),
                                    tokens_before: None,
                                    tokens_after: None,
                                    summary: None,
                                    error: None,
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        M::ExtMethod(_)
        | M::CreateTerminal(_) | M::TerminalOutput(_)
        | M::ReleaseTerminal(_) | M::WaitForTerminalExit(_)
        | M::KillTerminalCommand(_) => {}
    }
    Ok(())
}

/// Send a prompt to the agent via the command channel.
pub async fn send_prompt(handle: &SessionHandle, message: String) -> anyhow::Result<()> {
    let (reply_tx, reply_rx) = oneshot::channel();
    handle.cmd_tx.send(SessionCommand::SendPrompt { message, images: Vec::new(), reply: reply_tx })
        .map_err(|_| anyhow::anyhow!("Agent channel closed"))?;
    reply_rx.await
        .map_err(|_| anyhow::anyhow!("Agent thread not responding"))?
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

/// Cancel the current turn.
pub fn cancel_turn(handle: &SessionHandle) {
    let _ = handle.cmd_tx.send(SessionCommand::Cancel);
}

/// Change the model for a session via ACP SetSessionModel.
pub async fn set_model_cmd(
    cmd_tx: &mpsc::UnboundedSender<SessionCommand>,
    model_id: String,
) -> anyhow::Result<()> {
    let (reply_tx, reply_rx) = oneshot::channel();
    cmd_tx.send(SessionCommand::SetModel { model_id, reply: reply_tx })
        .map_err(|_| anyhow::anyhow!("Agent channel closed"))?;
    reply_rx.await
        .map_err(|_| anyhow::anyhow!("Agent thread not responding"))?
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

/// Trigger a manual compaction of the session context.
pub async fn compact_cmd(
    cmd_tx: &mpsc::UnboundedSender<SessionCommand>,
) -> anyhow::Result<()> {
    let (reply_tx, reply_rx) = oneshot::channel();
    cmd_tx.send(SessionCommand::Compact { reply: reply_tx })
        .map_err(|_| anyhow::anyhow!("Agent channel closed"))?;
    reply_rx.await
        .map_err(|_| anyhow::anyhow!("Agent thread not responding"))?
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

#[derive(Default)]
pub struct SessionPool {
    pub sessions: Arc<RwLock<Vec<SessionHandle>>>,
}

/// Send a prompt via the command channel directly.
pub async fn send_prompt_cmd(
    cmd_tx: &mpsc::UnboundedSender<SessionCommand>,
    message: String,
    images: Vec<AttachmentImage>,
) -> anyhow::Result<()> {
    let (reply_tx, reply_rx) = oneshot::channel();
    cmd_tx.send(SessionCommand::SendPrompt { message, images, reply: reply_tx })
        .map_err(|_| anyhow::anyhow!("Agent channel closed"))?;
    reply_rx.await
        .map_err(|_| anyhow::anyhow!("Agent thread not responding"))?
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

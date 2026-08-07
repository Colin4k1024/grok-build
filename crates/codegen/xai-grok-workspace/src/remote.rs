//! Remote Code Mode — WebSocket-based remote workspace execution.
//!
//! Allows grok-build to execute tools on a remote machine over a WebSocket
//! connection. The local session acts as a thin client, forwarding tool calls
//! to the remote host which executes them and streams results back.
//!
//! Protocol is built on the existing ACP JSON-RPC envelope (`rpc_envelope`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Configuration for a remote workspace connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteWorkspaceConfig {
    /// WebSocket endpoint URL (e.g. `wss://remote-host:8443/workspace`).
    pub url: String,
    /// Authentication token for the remote host.
    pub auth_token: String,
    /// Remote working directory.
    pub remote_cwd: PathBuf,
    /// Connection timeout in milliseconds.
    #[serde(default = "default_connect_timeout_ms")]
    pub connect_timeout_ms: u64,
    /// Request timeout in milliseconds.
    #[serde(default = "default_request_timeout_ms")]
    pub request_timeout_ms: u64,
}

fn default_connect_timeout_ms() -> u64 {
    10_000
}

fn default_request_timeout_ms() -> u64 {
    120_000
}

/// Status of the remote workspace connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

/// A tool call request to send to the remote host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteToolCall {
    pub id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
}

/// Result of a remote tool execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteToolResult {
    pub id: String,
    pub success: bool,
    pub output: serde_json::Value,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
}

/// A directory entry from the remote filesystem.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteDirEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

/// Error types for remote workspace operations.
#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("connection failed: {0}")]
    ConnectionFailed(String),
    #[error("authentication failed")]
    AuthFailed,
    #[error("request timeout after {timeout_ms}ms")]
    Timeout { timeout_ms: u64 },
    #[error("remote execution error: {0}")]
    ExecutionError(String),
    #[error("protocol error: {0}")]
    ProtocolError(String),
    #[error("connection closed")]
    Closed,
    #[error("websocket error: {0}")]
    WebSocket(String),
}

/// Remote workspace client — manages a WebSocket connection to a remote host
/// and forwards tool calls for execution.
pub struct RemoteWorkspace {
    config: RemoteWorkspaceConfig,
    status: Mutex<ConnectionStatus>,
    session_id: String,
}

impl RemoteWorkspace {
    /// Create a new remote workspace (does not connect yet).
    pub fn new(config: RemoteWorkspaceConfig) -> Self {
        let session_id = uuid::Uuid::new_v4().to_string();
        Self {
            config,
            status: Mutex::new(ConnectionStatus::Disconnected),
            session_id,
        }
    }

    /// Get the current connection status.
    pub async fn status(&self) -> ConnectionStatus {
        *self.status.lock().await
    }

    /// Get the session ID for this remote connection.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Get the remote working directory.
    pub fn remote_cwd(&self) -> &Path {
        &self.config.remote_cwd
    }

    /// Connect to the remote workspace.
    pub async fn connect(&self) -> Result<(), RemoteError> {
        {
            let mut s = self.status.lock().await;
            *s = ConnectionStatus::Connecting;
        }

        let url = url::Url::parse(&self.config.url)
            .map_err(|e| RemoteError::ConnectionFailed(e.to_string()))?;

        let connect_future = tokio_tungstenite::connect_async(url.as_str());
        let timeout = tokio::time::Duration::from_millis(self.config.connect_timeout_ms);

        match tokio::time::timeout(timeout, connect_future).await {
            Ok(Ok((_ws_stream, _response))) => {
                let mut s = self.status.lock().await;
                *s = ConnectionStatus::Connected;
                Ok(())
            }
            Ok(Err(e)) => {
                let mut s = self.status.lock().await;
                *s = ConnectionStatus::Failed;
                Err(RemoteError::ConnectionFailed(e.to_string()))
            }
            Err(_) => {
                let mut s = self.status.lock().await;
                *s = ConnectionStatus::Failed;
                Err(RemoteError::Timeout {
                    timeout_ms: self.config.connect_timeout_ms,
                })
            }
        }
    }

    /// Execute a tool call on the remote host.
    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<RemoteToolResult, RemoteError> {
        let status = self.status().await;
        if status != ConnectionStatus::Connected {
            return Err(RemoteError::Closed);
        }

        let call = RemoteToolCall {
            id: uuid::Uuid::new_v4().to_string(),
            tool_name: tool_name.to_string(),
            arguments,
        };

        // In a full implementation this would serialize `call` to JSON,
        // send over the WebSocket, and await a response frame.
        // For now, return a placeholder indicating the infrastructure is ready.
        Ok(RemoteToolResult {
            id: call.id,
            success: false,
            output: serde_json::json!({"error": "remote execution not yet wired"}),
            duration_ms: None,
            error: Some("remote workspace transport layer placeholder".into()),
        })
    }

    /// Read a file from the remote filesystem.
    pub async fn read_file(&self, path: &Path) -> Result<Vec<u8>, RemoteError> {
        let result = self
            .call_tool(
                "read_file",
                serde_json::json!({"path": path.to_string_lossy()}),
            )
            .await?;
        if result.success {
            let content = result
                .output
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(content.as_bytes().to_vec())
        } else {
            Err(RemoteError::ExecutionError(
                result.error.unwrap_or_default(),
            ))
        }
    }

    /// List a directory on the remote filesystem.
    pub async fn list_dir(&self, path: &Path) -> Result<Vec<RemoteDirEntry>, RemoteError> {
        let result = self
            .call_tool(
                "list_dir",
                serde_json::json!({"path": path.to_string_lossy()}),
            )
            .await?;
        if result.success {
            let entries: Vec<RemoteDirEntry> =
                serde_json::from_value(result.output).map_err(|e| {
                    RemoteError::ProtocolError(format!("failed to parse dir listing: {e}"))
                })?;
            Ok(entries)
        } else {
            Err(RemoteError::ExecutionError(
                result.error.unwrap_or_default(),
            ))
        }
    }

    /// Disconnect from the remote workspace.
    pub async fn disconnect(&self) {
        let mut s = self.status.lock().await;
        *s = ConnectionStatus::Disconnected;
    }
}

impl std::fmt::Debug for RemoteWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteWorkspace")
            .field("url", &self.config.url)
            .field("session_id", &self.session_id)
            .field("remote_cwd", &self.config.remote_cwd)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> RemoteWorkspaceConfig {
        RemoteWorkspaceConfig {
            url: "wss://localhost:8443/workspace".into(),
            auth_token: "test-token".into(),
            remote_cwd: PathBuf::from("/home/user/project"),
            connect_timeout_ms: 5000,
            request_timeout_ms: 30000,
        }
    }

    #[test]
    fn creates_workspace_with_session_id() {
        let ws = RemoteWorkspace::new(test_config());
        assert!(!ws.session_id().is_empty());
        assert_eq!(ws.remote_cwd(), Path::new("/home/user/project"));
    }

    #[tokio::test]
    async fn initial_status_is_disconnected() {
        let ws = RemoteWorkspace::new(test_config());
        assert_eq!(ws.status().await, ConnectionStatus::Disconnected);
    }

    #[tokio::test]
    async fn call_tool_fails_when_not_connected() {
        let ws = RemoteWorkspace::new(test_config());
        let result = ws.call_tool("bash", serde_json::json!({"command": "ls"})).await;
        assert!(matches!(result, Err(RemoteError::Closed)));
    }

    #[test]
    fn config_serde_roundtrip() {
        let cfg = test_config();
        let json = serde_json::to_string(&cfg).unwrap();
        let parsed: RemoteWorkspaceConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.url, cfg.url);
        assert_eq!(parsed.connect_timeout_ms, 5000);
    }

    #[test]
    fn default_timeouts() {
        let json = r#"{"url":"wss://x","auth_token":"t","remote_cwd":"/tmp"}"#;
        let cfg: RemoteWorkspaceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.connect_timeout_ms, 10_000);
        assert_eq!(cfg.request_timeout_ms, 120_000);
    }
}

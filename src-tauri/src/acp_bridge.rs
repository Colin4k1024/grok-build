//! ACP Bridge — spawns grok-shell agent and bridges ACP messages to the frontend.
//!
//! Full implementation in Phase1-02 (#18). This stub provides the types
//! and structure so the Tauri scaffold compiles and links grok-build crates.

use serde::{Deserialize, Serialize};

/// A handle to a running ACP session.
pub struct SessionHandle {
    pub id: String,
    pub cwd: String,
}

/// Event payload sent to the frontend via Tauri events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AcpEvent {
    /// Agent text delta (streaming)
    TextDelta {
        session_id: String,
        message_id: String,
        delta: String,
    },
    /// Tool call started
    ToolCall {
        session_id: String,
        tool_name: String,
        args: serde_json::Value,
    },
    /// Tool call result
    ToolResult {
        session_id: String,
        tool_name: String,
        output: String,
        success: bool,
    },
    /// Agent turn finished
    TurnComplete {
        session_id: String,
    },
    /// Error
    Error {
        session_id: String,
        message: String,
    },
}

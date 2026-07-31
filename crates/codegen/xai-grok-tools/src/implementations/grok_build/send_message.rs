//! `SendMessage` tool — inter-agent messaging.
//!
//! Allows an agent to send a message to another named subagent or to the
//! main conversation. Messages are delivered to the target's interjection buffer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageInput {
    /// Recipient: agent name, or "main" for parent session.
    pub to: String,
    /// The message content (plain text or structured JSON).
    pub message: serde_json::Value,
    /// Short summary shown as preview in the UI.
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageOutput {
    pub delivered: bool,
    pub recipient: String,
    pub error: Option<String>,
}

/// Validate and prepare a send-message request.
///
/// The actual delivery is handled by the session coordinator which has access
/// to the SubagentCoordinator. This function validates the input.
pub fn validate(input: &SendMessageInput) -> Result<(), String> {
    if input.to.trim().is_empty() {
        return Err("'to' field must not be empty".to_string());
    }
    if input.to.len() > 200 {
        return Err("'to' field exceeds 200 characters".to_string());
    }
    // Message validation: must be string or object
    match &input.message {
        serde_json::Value::String(s) if s.is_empty() => {
            return Err("message must not be empty".to_string());
        }
        serde_json::Value::Null => {
            return Err("message must not be null".to_string());
        }
        _ => {}
    }
    Ok(())
}

/// Format the message for delivery (extract text content).
pub fn format_for_delivery(input: &SendMessageInput) -> String {
    match &input.message {
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

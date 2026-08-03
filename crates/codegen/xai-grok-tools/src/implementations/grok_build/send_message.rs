//! Coordinator-backed inter-agent messaging.

use serde::{Deserialize, Serialize};

use crate::implementations::grok_build::task::backend::SubagentBackendResource;
use crate::implementations::grok_build::task::types::SubagentMessageOutcome;
use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::tool::{ToolKind, ToolNamespace};

const MAX_RECIPIENT_CHARS: usize = 200;
const MAX_SUMMARY_CHARS: usize = 200;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SendMessageInput {
    #[schemars(description = "Recipient subagent id, or `main` when called from a subagent")]
    pub to: String,
    #[schemars(description = "Non-empty plain text or structured JSON object to deliver")]
    pub message: serde_json::Value,
    #[serde(default)]
    #[schemars(description = "Optional short UI-oriented preview retained in the result")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SendMessageOutput {
    pub delivered: bool,
    pub recipient: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl xai_tool_runtime::ToolOutput for SendMessageOutput {}

#[derive(Debug, Default)]
pub struct SendMessageTool;

impl crate::types::tool_metadata::ToolMetadata for SendMessageTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Send a message to a live subagent in the current session, or from a subagent to `main`. \
         Use the exact subagent id returned by the task tool. Delivery is scoped to the root \
         session; unknown and foreign-session ids both fail without revealing foreign state."
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        use crate::implementations::grok_build::task::TaskTool;
        use crate::types::tool_metadata::ToolMetadata as TM;
        Expr::Value(ToolRequirement::Tool {
            namespace: TM::tool_namespace(&TaskTool).to_string(),
            id: xai_tool_runtime::Tool::id(&TaskTool).to_string(),
            if_params: None,
        })
    }
}

impl xai_tool_runtime::Tool for SendMessageTool {
    type Args = SendMessageInput;
    type Output = SendMessageOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("send_message").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "send_message",
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: false,
            tool_scope: Some(xai_tool_protocol::ToolScope::Write),
            ..Default::default()
        }
    }

    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: SendMessageInput,
    ) -> Result<SendMessageOutput, xai_tool_runtime::ToolError> {
        validate(&input).map_err(xai_tool_runtime::ToolError::invalid_arguments)?;
        let recipient = input.to.trim().to_owned();
        let message = format_for_delivery(&input);
        let backend = {
            let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
            let resources = resources.lock().await;
            resources.require::<SubagentBackendResource>()?.0.clone()
        };
        match backend.send_message(&recipient, message).await {
            SubagentMessageOutcome::Delivered {
                recipient,
                message_id,
            } => Ok(SendMessageOutput {
                delivered: true,
                recipient,
                message_id,
                summary: input.summary,
            }),
            SubagentMessageOutcome::NotReady => Err(xai_tool_runtime::ToolError::custom(
                "recipient_not_ready",
                format!("subagent '{recipient}' is still initializing; retry after it starts"),
            )),
            SubagentMessageOutcome::AlreadyFinished { status } => {
                Err(xai_tool_runtime::ToolError::custom(
                    "recipient_finished",
                    format!("subagent '{recipient}' already finished with status '{status}'"),
                ))
            }
            SubagentMessageOutcome::SelfTarget => Err(xai_tool_runtime::ToolError::custom(
                "invalid_recipient",
                "cannot send a message to the calling session itself",
            )),
            SubagentMessageOutcome::NotFound => Err(xai_tool_runtime::ToolError::custom(
                "recipient_not_found",
                format!("no live subagent '{recipient}' exists in this session"),
            )),
            SubagentMessageOutcome::Unavailable => Err(xai_tool_runtime::ToolError::custom(
                "message_delivery_unavailable",
                "the session coordinator could not queue the message",
            )),
        }
    }
}

pub fn validate(input: &SendMessageInput) -> Result<(), String> {
    let recipient = input.to.trim();
    if recipient.is_empty() {
        return Err("'to' field must not be empty".to_owned());
    }
    if recipient.chars().count() > MAX_RECIPIENT_CHARS {
        return Err(format!(
            "'to' field exceeds {MAX_RECIPIENT_CHARS} characters"
        ));
    }
    if input.summary.as_ref().is_some_and(|summary| {
        summary.trim().is_empty() || summary.chars().count() > MAX_SUMMARY_CHARS
    }) {
        return Err(format!(
            "summary must be non-empty and at most {MAX_SUMMARY_CHARS} characters"
        ));
    }
    match &input.message {
        serde_json::Value::String(value) if value.trim().is_empty() => {
            return Err("message must not be empty".to_owned());
        }
        serde_json::Value::String(_) | serde_json::Value::Object(_) => {}
        _ => return Err("message must be a string or JSON object".to_owned()),
    }
    if serde_json::to_vec(&input.message)
        .map_err(|error| format!("message is not serializable: {error}"))?
        .len()
        > MAX_MESSAGE_BYTES
    {
        return Err(format!("message exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    Ok(())
}

pub fn format_for_delivery(input: &SendMessageInput) -> String {
    match &input.message {
        serde_json::Value::String(value) => value.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_rejects_non_message_json() {
        let input = SendMessageInput {
            to: "agent-1".into(),
            message: serde_json::json!(["not", "an", "object"]),
            summary: None,
        };
        assert!(
            validate(&input)
                .unwrap_err()
                .contains("string or JSON object")
        );
    }

    #[test]
    fn structured_message_is_pretty_printed() {
        let input = SendMessageInput {
            to: "agent-1".into(),
            message: serde_json::json!({"action": "check"}),
            summary: None,
        };
        assert_eq!(format_for_delivery(&input), "{\n  \"action\": \"check\"\n}");
    }
}

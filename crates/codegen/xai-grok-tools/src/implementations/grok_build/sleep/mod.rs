//! `SleepTool` — pause execution for a specified duration, interruptible.

use std::time::Instant;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::tool::{ToolKind, ToolNamespace};

pub const SLEEP_TOOL_NAME: &str = "sleep";

const MIN_DURATION_MS: u64 = 1;
const MAX_DURATION_MS: u64 = 300_000;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SleepInput {
    #[schemars(description = "Duration to sleep in milliseconds (clamped 1..300000).")]
    pub duration_ms: u64,

    #[serde(default)]
    #[schemars(description = "Optional reason for the sleep (logged for observability).")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SleepOutput {
    pub slept_ms: u64,
    pub interrupted: bool,
    pub message: String,
}

impl xai_tool_runtime::ToolOutput for SleepOutput {}

#[derive(Debug, Default)]
pub struct SleepTool;

impl crate::types::tool_metadata::ToolMetadata for SleepTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Execute
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Pause execution for a specified duration (milliseconds). Interruptible by user input or cancellation."
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for SleepTool {
    type Args = SleepInput;
    type Output = SleepOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new(SLEEP_TOOL_NAME).expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            SLEEP_TOOL_NAME,
            crate::types::tool_metadata::ToolMetadata::sanitized_description_template(self),
        )
    }

    fn capabilities(&self) -> xai_tool_protocol::ToolCapabilities {
        xai_tool_protocol::ToolCapabilities {
            is_read_only: true,
            tool_scope: Some(xai_tool_protocol::ToolScope::Read),
            ..Default::default()
        }
    }

    #[tracing::instrument(name = "new_tool.sleep", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: SleepInput,
    ) -> Result<SleepOutput, xai_tool_runtime::ToolError> {
        let clamped = input.duration_ms.clamp(MIN_DURATION_MS, MAX_DURATION_MS);
        let duration = std::time::Duration::from_millis(clamped);
        let start = Instant::now();

        let cancelled = ctx.get::<xai_tool_runtime::Cancellation>();

        let interrupted = if let Some(cancel) = cancelled {
            tokio::select! {
                _ = tokio::time::sleep(duration) => false,
                _ = cancel.0.cancelled() => true,
            }
        } else {
            tokio::time::sleep(duration).await;
            false
        };

        let elapsed_ms = start.elapsed().as_millis() as u64;

        let message = if interrupted {
            format!(
                "Sleep interrupted after {}ms (requested {}ms).",
                elapsed_ms, clamped
            )
        } else {
            let reason_suffix = input
                .reason
                .as_deref()
                .map(|r| format!(" Reason: {r}"))
                .unwrap_or_default();
            format!("Slept for {}ms.{}", elapsed_ms, reason_suffix)
        };

        Ok(SleepOutput {
            slept_ms: elapsed_ms,
            interrupted,
            message,
        })
    }
}

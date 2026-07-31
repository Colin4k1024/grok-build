//! `TurnRollbackTool` — accept or reject all hunks for a specific turn.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::types::requirements::{Expr, ToolRequirement};
use crate::types::tool::{ToolKind, ToolNamespace};

pub const TURN_ROLLBACK_TOOL_NAME: &str = "turn_rollback";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TurnRollbackInput {
    #[schemars(description = "The prompt/turn index to act on.")]
    pub prompt_index: usize,

    #[schemars(description = "Action to take: \"reject\" reverts changes, \"accept\" keeps them.")]
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnRollbackOutput {
    pub success: bool,
    pub hunks_affected: usize,
    pub files_reverted: Vec<String>,
    pub error: Option<String>,
}

impl xai_tool_runtime::ToolOutput for TurnRollbackOutput {}

#[derive(Debug, Default)]
pub struct TurnRollbackTool;

impl crate::types::tool_metadata::ToolMetadata for TurnRollbackTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Execute
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Accept or reject all file changes from a specific turn. Use action=\"reject\" to revert, action=\"accept\" to keep."
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn requires_expr(&self) -> Expr<ToolRequirement> {
        Expr::True
    }
}

impl xai_tool_runtime::Tool for TurnRollbackTool {
    type Args = TurnRollbackInput;
    type Output = TurnRollbackOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new(TURN_ROLLBACK_TOOL_NAME).expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            TURN_ROLLBACK_TOOL_NAME,
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

    #[tracing::instrument(name = "new_tool.turn_rollback", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: TurnRollbackInput,
    ) -> Result<TurnRollbackOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        use xai_hunk_tracker::HunkAction;

        let action = match input.action.as_str() {
            "reject" => HunkAction::Reject,
            "accept" => HunkAction::Accept,
            other => {
                return Ok(TurnRollbackOutput {
                    success: false,
                    hunks_affected: 0,
                    files_reverted: vec![],
                    error: Some(format!(
                        "Invalid action \"{other}\". Must be \"reject\" or \"accept\"."
                    )),
                });
            }
        };

        let resources = shared_resources(&ctx)?;
        let handle = {
            let res = resources.lock().await;
            res.get::<xai_hunk_tracker::HunkTrackerHandle>()
                .ok_or_else(|| {
                    xai_tool_runtime::ToolError::custom(
                        "hunk_tracker_not_available",
                        "HunkTrackerHandle not registered in resources",
                    )
                })?
                .clone()
        };

        match handle.turn_action(input.prompt_index, action).await {
            Ok(hunk_ids) => {
                let hunks = handle.get_turn_hunks(input.prompt_index).await;
                let files: Vec<String> = hunks
                    .iter()
                    .map(|h| h.path.to_string_lossy().to_string())
                    .collect::<std::collections::HashSet<_>>()
                    .into_iter()
                    .collect();

                Ok(TurnRollbackOutput {
                    success: true,
                    hunks_affected: hunk_ids.len(),
                    files_reverted: files,
                    error: None,
                })
            }
            Err(e) => Ok(TurnRollbackOutput {
                success: false,
                hunks_affected: 0,
                files_reverted: vec![],
                error: Some(e.to_string()),
            }),
        }
    }
}

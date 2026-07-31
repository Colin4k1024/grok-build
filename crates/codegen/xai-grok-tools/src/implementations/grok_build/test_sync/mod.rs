pub mod detect;
pub mod parse;
pub mod types;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::computer::types::TerminalRunRequest;
use crate::types::resources::{NotificationHandle, SessionFolder, Terminal};
use crate::types::tool::{ToolKind, ToolNamespace};

use types::{TestSyncInput, TestSyncOutput};

#[derive(Debug, Default)]
pub struct TestSyncTool;

impl crate::types::tool_metadata::ToolMetadata for TestSyncTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Execute
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Run project tests with framework auto-detection and return structured results (pass/fail counts, failed test names). Detects cargo, jest, vitest, pytest, and go test frameworks."
    }
}

impl xai_tool_runtime::Tool for TestSyncTool {
    type Args = TestSyncInput;
    type Output = TestSyncOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("test_sync").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "test_sync",
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

    #[tracing::instrument(name = "tool.test_sync", skip_all)]
    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: TestSyncInput,
    ) -> Result<TestSyncOutput, xai_tool_runtime::ToolError> {
        use crate::types::tool_metadata::shared_resources;
        let resources = shared_resources(&ctx)?;

        let cwd = crate::types::tool_metadata::resolve_cwd(&ctx, &resources).await?;

        let (terminal, notification_handle, session_folder) = {
            let res = resources.lock().await;
            (
                res.require::<Terminal>()?.0.clone(),
                res.get::<NotificationHandle>()
                    .map(|h| h.0.clone())
                    .unwrap_or_default(),
                res.require::<SessionFolder>()?.0.clone(),
            )
        };

        let (framework_name, command) = resolve_command(&input, &cwd)?;

        let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(300_000));
        let output_file = session_folder
            .join("terminal")
            .join(format!("test_sync-{}.log", ctx.call_id.as_str()));

        let start = Instant::now();

        let result = terminal
            .run(TerminalRunRequest {
                command: command.clone(),
                working_directory: cwd,
                env: std::collections::HashMap::new(),
                timeout,
                output_byte_limit: 512_000,
                output_file,
                notification_handle,
                tool_call_id: ctx.call_id.to_string(),
                display_command: Some(command.clone()),
                auto_background_on_timeout: false,
                foreground_block_budget: None,
                kind: crate::computer::types::TaskKind::Bash,
                owner_session_id: None,
                description: Some("test_sync".to_string()),
            })
            .await
            .map_err(|e| {
                xai_tool_runtime::ToolError::custom("execution_failed", e.to_string())
            })?;

        let duration_ms = start.elapsed().as_millis() as u64;
        let output = parse::parse_output(&framework_name, &result.combined_output, &command, duration_ms);

        Ok(output)
    }
}

fn resolve_command(
    input: &TestSyncInput,
    cwd: &PathBuf,
) -> Result<(String, String), xai_tool_runtime::ToolError> {
    if let Some(ref cmd) = input.command {
        return Ok(("custom".to_string(), cmd.clone()));
    }

    let detected = detect::detect_framework(cwd, input.filter.as_deref()).ok_or_else(|| {
        xai_tool_runtime::ToolError::invalid_arguments(
            "Could not auto-detect test framework. Please provide a `command` parameter.".to_string(),
        )
    })?;

    Ok((detected.name, detected.command))
}

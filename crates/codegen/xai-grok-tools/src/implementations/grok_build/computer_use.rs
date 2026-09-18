//! Explicitly-enabled browser/desktop automation backed by real transports.

pub use xai_grok_computer_use::Action;
use xai_grok_computer_use::browser::{BrowserBackend, validate_navigation_url};
use xai_grok_computer_use::desktop::DesktopBackend;
use xai_grok_computer_use::{ScreenSize, Screenshot};

use crate::types::resources::Params;
use crate::types::tool::{ToolKind, ToolNamespace};

const MAX_TEXT_BYTES: usize = 10_000;
const MAX_KEY_BYTES: usize = 128;
const MAX_WAIT_MS: u64 = 60_000;
const MAX_SCROLL_AMOUNT: u32 = 100;

#[derive(
    Debug,
    Clone,
    Copy,
    Default,
    PartialEq,
    Eq,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseMode {
    #[default]
    Browser,
    Desktop,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ComputerUseParams {
    /// Must be explicitly set to true. The tool is absent from default presets.
    pub enabled: bool,
    pub mode: ComputerUseMode,
    pub viewport_width: u32,
    pub viewport_height: u32,
}

impl Default for ComputerUseParams {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: ComputerUseMode::Browser,
            viewport_width: 1280,
            viewport_height: 720,
        }
    }
}

crate::register_resource!("grok_build", "ComputerUse", ComputerUseParams);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ComputerUseCapability {
    pub compiled_in: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ComputerUseOutput {
    pub success: bool,
    pub mode: ComputerUseMode,
    pub action: String,
    pub capability: ComputerUseCapability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Screenshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_size: Option<ScreenSize>,
    pub message: String,
}

impl xai_tool_runtime::ToolOutput for ComputerUseOutput {
    fn model_output(&self) -> Vec<xai_tool_runtime::ContentBlock> {
        let mut blocks = vec![xai_tool_runtime::ContentBlock::Text {
            text: self.message.clone(),
        }];
        if let Some(screenshot) = &self.screenshot {
            blocks.push(xai_tool_runtime::ContentBlock::Image {
                mime_type: match screenshot.format {
                    xai_grok_computer_use::types::ImageFormat::Png => "image/png",
                    xai_grok_computer_use::types::ImageFormat::Jpeg => "image/jpeg",
                }
                .to_owned(),
                data: screenshot.data_base64.clone(),
                media_id: None,
                filename: None,
                path: None,
                metadata: std::collections::HashMap::new(),
            });
        }
        blocks
    }
}

enum ActiveBackend {
    Browser(BrowserBackend),
    Desktop(DesktopBackend),
}

impl ActiveBackend {
    async fn execute(
        &self,
        action: &Action,
    ) -> Result<Option<Screenshot>, xai_grok_computer_use::ComputerUseError> {
        match self {
            Self::Browser(backend) => backend.execute(action).await,
            Self::Desktop(backend) => backend.execute(action).await,
        }
    }

    fn screen_size(&self) -> ScreenSize {
        match self {
            Self::Browser(backend) => backend.viewport().clone(),
            Self::Desktop(backend) => backend.screen_size().clone(),
        }
    }

    async fn close(&mut self) {
        if let Self::Browser(backend) = self {
            backend.close().await;
        }
    }
}

struct ActiveSession {
    params: ComputerUseParams,
    backend: ActiveBackend,
}

pub struct ComputerUseTool {
    active: tokio::sync::Mutex<Option<ActiveSession>>,
}

impl std::fmt::Debug for ComputerUseTool {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComputerUseTool")
            .finish_non_exhaustive()
    }
}

impl Default for ComputerUseTool {
    fn default() -> Self {
        Self {
            active: tokio::sync::Mutex::new(None),
        }
    }
}

impl crate::types::tool_metadata::ToolMetadata for ComputerUseTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Execute
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Control an explicitly enabled isolated headless browser or the local desktop. Every call is treated as a high-risk write-scope operation. Use capability_status before relying on platform-specific desktop control. Screenshots are returned as image content."
    }
}

impl xai_tool_runtime::Tool for ComputerUseTool {
    type Args = Action;
    type Output = ComputerUseOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("computer_use").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "computer_use",
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
        action: Action,
    ) -> Result<ComputerUseOutput, xai_tool_runtime::ToolError> {
        validate_action(&action)?;
        let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
        let params = {
            let resources = resources.lock().await;
            resources
                .get::<Params<ComputerUseParams>>()
                .map(|params| params.0.clone())
                .unwrap_or_default()
        };
        let action_name = action_name(&action);
        let destination_host = match &action {
            Action::Navigate { url } => reqwest::Url::parse(url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned)),
            _ => None,
        };
        tracing::info!(
            target: "computer_use.audit",
            call_id = %ctx.call_id,
            mode = ?params.mode,
            action = action_name,
            destination_host,
            enabled = params.enabled,
            "computer-use action requested"
        );

        if matches!(action, Action::CapabilityStatus) {
            let output = capability_output(&params);
            tracing::info!(
                target: "computer_use.audit",
                call_id = %ctx.call_id,
                mode = ?params.mode,
                available = output.capability.available,
                "computer-use capability probe completed"
            );
            return Ok(output);
        }
        if !params.enabled {
            return Err(xai_tool_runtime::ToolError::custom(
                "computer_use_disabled",
                "computer_use is disabled; explicitly configure the tool with enabled=true",
            ));
        }
        if params.viewport_width == 0 || params.viewport_height == 0 {
            return Err(xai_tool_runtime::ToolError::invalid_arguments(
                "viewport dimensions must be greater than zero",
            ));
        }
        if let Some(cancellation) = ctx.get::<xai_tool_runtime::Cancellation>()
            && cancellation.0.is_cancelled()
        {
            return Err(xai_tool_runtime::ToolError::custom(
                "cancelled",
                "computer-use action was cancelled before execution",
            ));
        }

        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|session| session.params != params)
            && let Some(mut previous) = active.take()
        {
            previous.backend.close().await;
        }
        if active.is_none() {
            let backend = launch_backend(&params).await.map_err(tool_error)?;
            *active = Some(ActiveSession {
                params: params.clone(),
                backend,
            });
        }

        let cancellation = ctx.get::<xai_tool_runtime::Cancellation>();
        let execution = active
            .as_ref()
            .expect("backend initialized")
            .backend
            .execute(&action);
        let result = if let Some(cancellation) = cancellation {
            tokio::select! {
                result = execution => result,
                _ = cancellation.0.cancelled() => {
                    return Err(xai_tool_runtime::ToolError::custom(
                        "cancelled",
                        "computer-use action was cancelled",
                    ));
                }
            }
        } else {
            execution.await
        };
        let screenshot = match result {
            Ok(screenshot) => screenshot,
            Err(error) => {
                if let Some(mut failed) = active.take() {
                    failed.backend.close().await;
                }
                tracing::warn!(
                    target: "computer_use.audit",
                    call_id = %ctx.call_id,
                    mode = ?params.mode,
                    action = action_name,
                    error = %error,
                    "computer-use action failed"
                );
                return Err(tool_error(error));
            }
        };
        let screen_size = active.as_ref().map(|session| session.backend.screen_size());
        tracing::info!(
            target: "computer_use.audit",
            call_id = %ctx.call_id,
            mode = ?params.mode,
            action = action_name,
            "computer-use action completed"
        );
        Ok(ComputerUseOutput {
            success: true,
            mode: params.mode,
            action: action_name.to_owned(),
            capability: ComputerUseCapability {
                compiled_in: true,
                available: true,
                reason: None,
            },
            screenshot,
            screen_size,
            message: format!(
                "Computer-use {action_name} completed in {:?} mode.",
                params.mode
            ),
        })
    }
}

fn capability_output(params: &ComputerUseParams) -> ComputerUseOutput {
    if !params.enabled {
        return ComputerUseOutput {
            success: true,
            mode: params.mode,
            action: "capability_status".to_owned(),
            capability: ComputerUseCapability {
                compiled_in: true,
                available: false,
                reason: Some("disabled by configuration".to_owned()),
            },
            screenshot: None,
            screen_size: None,
            message: "Computer-use is compiled in but disabled by configuration.".to_owned(),
        };
    }
    let (available, reason, screen_size) = match params.mode {
        ComputerUseMode::Browser => {
            let status = BrowserBackend::probe();
            (
                status.available,
                status.reason,
                Some(ScreenSize {
                    width: params.viewport_width,
                    height: params.viewport_height,
                }),
            )
        }
        ComputerUseMode::Desktop => {
            let status = DesktopBackend::probe();
            (status.available, status.reason, status.screen_size)
        }
    };
    ComputerUseOutput {
        success: true,
        mode: params.mode,
        action: "capability_status".to_owned(),
        capability: ComputerUseCapability {
            compiled_in: true,
            available,
            reason: reason.clone(),
        },
        screenshot: None,
        screen_size,
        message: if available {
            format!("Computer-use {:?} backend is available.", params.mode)
        } else {
            format!(
                "Computer-use {:?} backend is unavailable: {}",
                params.mode,
                reason.as_deref().unwrap_or("unknown reason")
            )
        },
    }
}

async fn launch_backend(
    params: &ComputerUseParams,
) -> Result<ActiveBackend, xai_grok_computer_use::ComputerUseError> {
    match params.mode {
        ComputerUseMode::Browser => BrowserBackend::launch(Some(ScreenSize {
            width: params.viewport_width,
            height: params.viewport_height,
        }))
        .await
        .map(ActiveBackend::Browser),
        ComputerUseMode::Desktop => DesktopBackend::new().map(ActiveBackend::Desktop),
    }
}

fn tool_error(error: xai_grok_computer_use::ComputerUseError) -> xai_tool_runtime::ToolError {
    xai_tool_runtime::ToolError::custom("computer_use_failed", error.to_string())
}

fn validate_action(action: &Action) -> Result<(), xai_tool_runtime::ToolError> {
    match action {
        Action::Type { text } if text.len() > MAX_TEXT_BYTES => {
            Err(xai_tool_runtime::ToolError::invalid_arguments(format!(
                "text exceeds {MAX_TEXT_BYTES} bytes"
            )))
        }
        Action::KeyPress { key } if key.is_empty() || key.len() > MAX_KEY_BYTES => {
            Err(xai_tool_runtime::ToolError::invalid_arguments(format!(
                "key must contain 1..={MAX_KEY_BYTES} bytes"
            )))
        }
        Action::Wait { ms } if *ms > MAX_WAIT_MS => {
            Err(xai_tool_runtime::ToolError::invalid_arguments(format!(
                "wait exceeds the {MAX_WAIT_MS}ms limit"
            )))
        }
        Action::Scroll { amount, .. } if *amount > MAX_SCROLL_AMOUNT => {
            Err(xai_tool_runtime::ToolError::invalid_arguments(format!(
                "scroll amount exceeds {MAX_SCROLL_AMOUNT}"
            )))
        }
        Action::Navigate { url } => validate_navigation_url(url).map_err(tool_error),
        _ => Ok(()),
    }
}

fn action_name(action: &Action) -> &'static str {
    match action {
        Action::CapabilityStatus => "capability_status",
        Action::Screenshot => "screenshot",
        Action::Click { .. } => "click",
        Action::DoubleClick { .. } => "double_click",
        Action::Type { .. } => "type",
        Action::KeyPress { .. } => "key_press",
        Action::Scroll { .. } => "scroll",
        Action::MoveMouse { .. } => "move_mouse",
        Action::Navigate { .. } => "navigate",
        Action::Wait { .. } => "wait",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_tool_runtime::Tool as _;

    fn params_resources(params: ComputerUseParams) -> crate::types::resources::SharedResources {
        let mut resources = crate::types::resources::Resources::new();
        resources.insert(Params(params));
        std::sync::Arc::new(tokio::sync::Mutex::new(resources))
    }

    #[test]
    fn defaults_fail_closed() {
        let params = ComputerUseParams::default();
        assert!(!params.enabled);
        let output = capability_output(&params);
        assert!(!output.capability.available);
        assert_eq!(
            output.capability.reason.as_deref(),
            Some("disabled by configuration")
        );
    }

    #[tokio::test]
    async fn disabled_tool_rejects_actions_without_launching_backend() {
        let mut ctx = xai_tool_runtime::ToolCallContext::default();
        ctx.insert(params_resources(ComputerUseParams::default()));
        let error = ComputerUseTool::default()
            .run(ctx, Action::Screenshot)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("disabled"));
    }

    #[tokio::test]
    async fn capability_status_reports_disabled_state() {
        let mut ctx = xai_tool_runtime::ToolCallContext::default();
        ctx.insert(params_resources(ComputerUseParams::default()));
        let output = ComputerUseTool::default()
            .run(ctx, Action::CapabilityStatus)
            .await
            .unwrap();
        assert!(output.success);
        assert!(output.capability.compiled_in);
        assert!(!output.capability.available);
    }

    #[test]
    fn high_risk_scope_requires_write_permission() {
        let capabilities = ComputerUseTool::default().capabilities();
        assert_eq!(
            capabilities.tool_scope,
            Some(xai_tool_protocol::ToolScope::Write)
        );
        assert!(!capabilities.is_read_only);
    }

    #[test]
    fn validates_resource_limits_and_navigation_policy() {
        assert!(
            validate_action(&Action::Wait {
                ms: MAX_WAIT_MS + 1
            })
            .is_err()
        );
        assert!(
            validate_action(&Action::Navigate {
                url: "http://127.0.0.1/private".to_owned(),
            })
            .is_err()
        );
    }
}

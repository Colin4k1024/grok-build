use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn default_timeout_ms() -> Option<u64> {
    Some(300_000)
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TestSyncInput {
    /// Override the auto-detected test command.
    #[schemars(description = "Override the auto-detected test command. Leave empty for auto-detection.")]
    #[serde(default)]
    pub command: Option<String>,

    /// Test name filter/pattern to run a subset of tests.
    #[schemars(description = "Test name filter/pattern to run a subset of tests.")]
    #[serde(default)]
    pub filter: Option<String>,

    /// Timeout in milliseconds. Default: 300000 (5 minutes).
    #[serde(default = "default_timeout_ms")]
    #[schemars(
        description = "Timeout in milliseconds. Default: 300000 (5 minutes).",
        default = "default_timeout_ms"
    )]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TestSyncOutput {
    pub framework: String,
    pub command_run: String,
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub duration_ms: u64,
    pub failed_tests: Vec<FailedTest>,
    pub summary: String,
}

impl xai_tool_runtime::ToolOutput for TestSyncOutput {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FailedTest {
    pub name: String,
    pub message: String,
}

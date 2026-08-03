//! Structured, validated code-review findings.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::types::resources::{Cwd, DisplayCwd, FileSystem, resolve_model_path};
use crate::types::tool::{ToolKind, ToolNamespace};

const MAX_FINDINGS: usize = 100;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ReviewLevel {
    Quick,
    Standard,
    Thorough,
}

impl Default for ReviewLevel {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Low,
    Medium,
    High,
    Critical,
}

impl Default for FindingSeverity {
    fn default() -> Self {
        Self::Medium
    }
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct Finding {
    #[schemars(description = "Workspace-relative path of the affected file")]
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "1-based line number in the affected file")]
    pub line: Option<usize>,
    pub summary: String,
    pub failure_scenario: String,
    #[serde(default)]
    pub severity: FindingSeverity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct ReportFindingsInput {
    #[schemars(description = "One or more actionable findings; empty reports are rejected")]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub level: ReviewLevel,
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct ReportFindingsOutput {
    pub accepted: bool,
    pub level: ReviewLevel,
    pub findings_count: usize,
    pub findings: Vec<Finding>,
}

impl xai_tool_runtime::ToolOutput for ReportFindingsOutput {}

#[derive(Debug, Default)]
pub struct ReportFindingsTool;

fn normalize_workspace_path(cwd: &Path, candidate: PathBuf) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("path escapes the workspace".to_owned());
                }
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    if !normalized.starts_with(cwd) {
        return Err("path must be inside the workspace".to_owned());
    }
    Ok(normalized)
}

impl crate::types::tool_metadata::ToolMetadata for ReportFindingsTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Other
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Submit the final structured findings from a code review. Every finding is validated against the current workspace, including its file path and optional line number. Use this only for actionable defects, not general review commentary."
    }
}

impl xai_tool_runtime::Tool for ReportFindingsTool {
    type Args = ReportFindingsInput;
    type Output = ReportFindingsOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("report_findings").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "report_findings",
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
        input: ReportFindingsInput,
    ) -> Result<ReportFindingsOutput, xai_tool_runtime::ToolError> {
        if input.findings.is_empty() {
            return Err(xai_tool_runtime::ToolError::custom(
                "invalid_findings",
                "findings must contain at least one actionable item",
            ));
        }
        if input.findings.len() > MAX_FINDINGS {
            return Err(xai_tool_runtime::ToolError::custom(
                "invalid_findings",
                format!("at most {MAX_FINDINGS} findings may be reported at once"),
            ));
        }

        let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
        let (cwd, display_cwd, fs) = {
            let resources = resources.lock().await;
            (
                resources.require::<Cwd>()?.0.clone(),
                resources.get::<DisplayCwd>().map(|value| value.0.clone()),
                resources.require::<FileSystem>()?.0.clone(),
            )
        };
        let canonical_cwd = dunce::canonicalize(&cwd).unwrap_or(cwd.clone());
        let mut line_counts = HashMap::<PathBuf, usize>::new();

        for (index, finding) in input.findings.iter().enumerate() {
            if finding.file.trim().is_empty()
                || finding.summary.trim().is_empty()
                || finding.failure_scenario.trim().is_empty()
            {
                return Err(xai_tool_runtime::ToolError::custom(
                    "invalid_finding",
                    format!(
                        "finding {} must include a non-empty file, summary, and failure_scenario",
                        index + 1
                    ),
                ));
            }

            let resolved = resolve_model_path(&cwd, display_cwd.as_deref(), &finding.file);
            let resolved = normalize_workspace_path(&cwd, resolved).map_err(|message| {
                xai_tool_runtime::ToolError::custom(
                    "invalid_finding_path",
                    format!("finding {}: {message}: {}", index + 1, finding.file),
                )
            })?;
            let actual_path = dunce::canonicalize(&resolved).unwrap_or(resolved);
            if !actual_path.starts_with(&canonical_cwd) {
                return Err(xai_tool_runtime::ToolError::custom(
                    "invalid_finding_path",
                    format!("finding {} resolves outside the workspace", index + 1),
                ));
            }

            let line_count = if let Some(line_count) = line_counts.get(&actual_path) {
                *line_count
            } else {
                let bytes = fs.read_file(&actual_path).await.map_err(|error| {
                    xai_tool_runtime::ToolError::custom(
                        "finding_file_unavailable",
                        format!(
                            "finding {} cannot read {}: {error}",
                            index + 1,
                            finding.file
                        ),
                    )
                })?;
                let text = std::str::from_utf8(&bytes).map_err(|_| {
                    xai_tool_runtime::ToolError::custom(
                        "finding_file_not_text",
                        format!("finding {} points to a non-UTF-8 file", index + 1),
                    )
                })?;
                let count = text.lines().count();
                line_counts.insert(actual_path, count);
                count
            };
            if let Some(line) = finding.line
                && (line == 0 || line > line_count)
            {
                return Err(xai_tool_runtime::ToolError::custom(
                    "invalid_finding_line",
                    format!(
                        "finding {} line {} is outside {} ({} lines)",
                        index + 1,
                        line,
                        finding.file,
                        line_count
                    ),
                ));
            }
        }

        Ok(ReportFindingsOutput {
            accepted: true,
            level: input.level,
            findings_count: input.findings.len(),
            findings: input.findings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::local::LocalFs;
    use crate::types::resources::Resources;
    use crate::types::tool_metadata::test_ctx;
    use std::sync::Arc;

    #[test]
    fn output_preserves_structured_findings() {
        let finding = Finding {
            file: "src/lib.rs".into(),
            line: Some(3),
            summary: "panic".into(),
            failure_scenario: "empty input".into(),
            severity: FindingSeverity::High,
            category: Some("correctness".into()),
            verdict: None,
            outcome: None,
        };
        let output = ReportFindingsOutput {
            accepted: true,
            level: ReviewLevel::Thorough,
            findings_count: 1,
            findings: vec![finding.clone()],
        };
        assert_eq!(output.findings, vec![finding]);
    }

    #[tokio::test]
    async fn validates_finding_line_against_workspace_file() {
        use xai_tool_runtime::Tool;

        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("lib.rs"), "one\ntwo\n").unwrap();
        let mut resources = Resources::new();
        resources.insert(Cwd(temp.path().to_path_buf()));
        resources.insert(FileSystem(Arc::new(LocalFs)));
        let input = ReportFindingsInput {
            findings: vec![Finding {
                file: "lib.rs".into(),
                line: Some(3),
                summary: "bad line".into(),
                failure_scenario: "review points past EOF".into(),
                severity: FindingSeverity::Medium,
                category: None,
                verdict: None,
                outcome: None,
            }],
            level: ReviewLevel::Standard,
        };
        let error = ReportFindingsTool
            .run(test_ctx(resources.into_shared()), input)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("outside lib.rs (2 lines)"));
    }
}

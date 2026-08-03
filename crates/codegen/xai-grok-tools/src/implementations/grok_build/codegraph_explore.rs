//! Symbol definition/reference lookup backed by the live codebase graph.

use std::path::{Component, Path, PathBuf};

use crate::types::resources::{Cwd, DisplayCwd, resolve_model_path};
use crate::types::tool::{ToolKind, ToolNamespace};

const DEFAULT_MAX_RESULTS: usize = 20;
const MAX_RESULTS: usize = 100;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum CodeGraphOperation {
    Definitions,
    References,
}

impl Default for CodeGraphOperation {
    fn default() -> Self {
        Self::Definitions
    }
}

fn default_max_results() -> usize {
    DEFAULT_MAX_RESULTS
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct CodeGraphExploreInput {
    #[serde(default)]
    pub operation: CodeGraphOperation,
    #[schemars(description = "Exact symbol name to find")]
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Optional workspace-relative file used to rank ambiguous symbols")]
    pub context_file: Option<String>,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct CodeGraphLocation {
    pub path: String,
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_symbol: Option<String>,
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct CodeGraphExploreOutput {
    pub operation: CodeGraphOperation,
    pub query: String,
    pub results: Vec<CodeGraphLocation>,
    pub total_results: usize,
    pub truncated: bool,
}

impl xai_tool_runtime::ToolOutput for CodeGraphExploreOutput {}

#[derive(Debug, Default)]
pub struct CodeGraphExploreTool;

fn normalize_workspace_path(cwd: &Path, candidate: PathBuf) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("context_file escapes the workspace".to_owned());
                }
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    if !normalized.starts_with(cwd) {
        return Err("context_file must be inside the workspace".to_owned());
    }
    Ok(normalized)
}

impl crate::types::tool_metadata::ToolMetadata for CodeGraphExploreTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Search
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Find definitions or references for an exact symbol using the workspace's incrementally maintained code graph. Use context_file to improve ranking when the symbol is ambiguous."
    }
}

impl xai_tool_runtime::Tool for CodeGraphExploreTool {
    type Args = CodeGraphExploreInput;
    type Output = CodeGraphExploreOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("codegraph_explore").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "codegraph_explore",
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

    async fn run(
        &self,
        ctx: xai_tool_runtime::ToolCallContext,
        input: CodeGraphExploreInput,
    ) -> Result<CodeGraphExploreOutput, xai_tool_runtime::ToolError> {
        let query = input.query.trim();
        if query.is_empty() || query.len() > 256 {
            return Err(xai_tool_runtime::ToolError::custom(
                "invalid_symbol",
                "query must contain an exact symbol name of at most 256 bytes",
            ));
        }
        if input.max_results == 0 || input.max_results > MAX_RESULTS {
            return Err(xai_tool_runtime::ToolError::custom(
                "invalid_max_results",
                format!("max_results must be between 1 and {MAX_RESULTS}"),
            ));
        }

        let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
        let (cwd, display_cwd) = {
            let resources = resources.lock().await;
            (
                resources.require::<Cwd>()?.0.clone(),
                resources.get::<DisplayCwd>().map(|value| value.0.clone()),
            )
        };
        let canonical_cwd = dunce::canonicalize(&cwd).map_err(|error| {
            xai_tool_runtime::ToolError::custom(
                "codegraph_workspace_unavailable",
                format!("cannot access workspace {}: {error}", cwd.display()),
            )
        })?;
        if !canonical_cwd.is_dir() {
            return Err(xai_tool_runtime::ToolError::custom(
                "codegraph_workspace_unavailable",
                "workspace root is not a directory",
            ));
        }

        let context_file = input
            .context_file
            .as_deref()
            .map(|context_file| {
                let resolved = resolve_model_path(&cwd, display_cwd.as_deref(), context_file);
                let resolved = normalize_workspace_path(&cwd, resolved).map_err(|message| {
                    xai_tool_runtime::ToolError::custom("invalid_context_file", message)
                })?;
                let canonical = dunce::canonicalize(&resolved).map_err(|error| {
                    xai_tool_runtime::ToolError::custom(
                        "invalid_context_file",
                        format!("cannot access {context_file}: {error}"),
                    )
                })?;
                if !canonical.starts_with(&canonical_cwd) || !canonical.is_file() {
                    return Err(xai_tool_runtime::ToolError::custom(
                        "invalid_context_file",
                        "context_file must be a file inside the workspace",
                    ));
                }
                Ok(canonical)
            })
            .transpose()?;

        // IndexManager::spawn is process-wide deduplicated by canonical root.
        // Existing shell/watch integrations and this tool therefore share the
        // same actor and incremental index instead of building competing copies.
        let index = xai_codebase_graph::IndexManager::spawn(
            xai_codebase_graph::IndexManagerConfig::new(canonical_cwd),
        );
        let query_future = async {
            match input.operation {
                CodeGraphOperation::Definitions => {
                    index.find_definitions(query.to_owned(), context_file).await
                }
                CodeGraphOperation::References => {
                    index.find_references(query.to_owned(), context_file).await
                }
            }
        };
        let locations = if let Some(cancellation) = ctx
            .extensions
            .get::<xai_tool_runtime::Cancellation>()
            .map(|value| value.0.clone())
        {
            tokio::select! {
                result = query_future => result,
                _ = cancellation.cancelled() => {
                    return Err(xai_tool_runtime::ToolError::custom(
                        "cancelled",
                        "code graph query was cancelled",
                    ));
                }
            }
        } else {
            query_future.await
        }
        .map_err(|error| {
            xai_tool_runtime::ToolError::custom(
                "codegraph_query_failed",
                format!("code graph index is unavailable: {error}"),
            )
        })?;

        let total_results = locations.len();
        let results = locations
            .into_iter()
            .take(input.max_results)
            .map(|location| CodeGraphLocation {
                path: location.path,
                line: location.line,
                matched_symbol: location.matched_symbol,
            })
            .collect();
        Ok(CodeGraphExploreOutput {
            operation: input.operation,
            query: query.to_owned(),
            results,
            total_results,
            truncated: total_results > input.max_results,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::resources::Resources;
    use crate::types::tool_metadata::test_ctx;

    #[test]
    fn default_limit_is_bounded() {
        assert_eq!(default_max_results(), 20);
        assert!(default_max_results() <= MAX_RESULTS);
    }

    #[tokio::test]
    async fn queries_real_index_for_definition() {
        use xai_tool_runtime::Tool;

        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("lib.rs"),
            "pub fn production_symbol() -> usize { 1 }\n",
        )
        .unwrap();
        let mut resources = Resources::new();
        resources.insert(Cwd(temp.path().to_path_buf()));
        let output = CodeGraphExploreTool
            .run(
                test_ctx(resources.into_shared()),
                CodeGraphExploreInput {
                    operation: CodeGraphOperation::Definitions,
                    query: "production_symbol".into(),
                    context_file: Some("lib.rs".into()),
                    max_results: 20,
                },
            )
            .await
            .unwrap();
        assert_eq!(output.total_results, 1);
        assert_eq!(output.results[0].path, "lib.rs");
        assert_eq!(output.results[0].line, 1);
    }
}

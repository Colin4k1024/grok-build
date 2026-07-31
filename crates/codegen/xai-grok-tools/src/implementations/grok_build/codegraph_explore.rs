//! `CodeGraphExplore` tool — query the project's symbol graph.
//!
//! Wraps the xai-codebase-graph crate to expose symbol lookup, call paths,
//! and source retrieval as a tool callable by the model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeGraphExploreInput {
    pub query: String,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default = "default_max_files")]
    pub max_files: u32,
}

fn default_max_files() -> u32 {
    12
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeGraphExploreOutput {
    pub results: String,
    pub files_shown: u32,
}

/// Execute a codegraph query.
///
/// In production this delegates to the `xai-codebase-graph` index.
/// When no index is available, returns a guidance message.
pub fn execute(input: &CodeGraphExploreInput, workspace_root: &std::path::Path) -> CodeGraphExploreOutput {
    let index_dir = workspace_root.join(".codegraph");
    if !index_dir.exists() {
        return CodeGraphExploreOutput {
            results: format!(
                "No .codegraph/ index found at {}. Run `codegraph index` to create one.",
                workspace_root.display()
            ),
            files_shown: 0,
        };
    }
    // Stub: in production, this calls into xai_codebase_graph::query()
    CodeGraphExploreOutput {
        results: format!(
            "[CodeGraph] Query: '{}' (max {} files)\nIndex found at {}\n\n(Full implementation pending xai-codebase-graph integration)",
            input.query, input.max_files, index_dir.display()
        ),
        files_shown: 0,
    }
}

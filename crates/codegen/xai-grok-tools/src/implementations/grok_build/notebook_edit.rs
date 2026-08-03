//! Cell-level Jupyter notebook editing with atomic persistence.

use std::path::{Component, Path, PathBuf};

use crate::notification::types::FileWritten;
use crate::types::resources::{
    Cwd, DisplayCwd, FileSystem, NotificationHandle, resolve_model_path,
};
use crate::types::tool::{ToolKind, ToolNamespace};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum NotebookEditMode {
    Insert,
    Replace,
    Delete,
}

impl Default for NotebookEditMode {
    fn default() -> Self {
        Self::Replace
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum NotebookCellType {
    Code,
    Markdown,
    Raw,
}

impl NotebookCellType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Markdown => "markdown",
            Self::Raw => "raw",
        }
    }
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct NotebookEditInput {
    pub notebook_path: String,
    #[serde(default)]
    pub new_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Target cell for replace/delete, or insertion anchor for insert")]
    pub cell_id: Option<String>,
    #[serde(default)]
    pub edit_mode: NotebookEditMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_type: Option<NotebookCellType>,
}

#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct NotebookEditOutput {
    pub success: bool,
    pub notebook_path: String,
    pub edit_mode: NotebookEditMode,
    pub cell_id: String,
    pub cells_count: usize,
}

impl xai_tool_runtime::ToolOutput for NotebookEditOutput {}

#[derive(Debug, Default)]
pub struct NotebookEditTool;

fn source_lines(source: &str) -> Vec<serde_json::Value> {
    source
        .split_inclusive('\n')
        .map(|line| serde_json::Value::String(line.to_owned()))
        .collect()
}

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

impl crate::types::tool_metadata::ToolMetadata for NotebookEditTool {
    fn kind(&self) -> ToolKind {
        ToolKind::Edit
    }

    fn tool_namespace(&self) -> ToolNamespace {
        ToolNamespace::GrokBuild
    }

    fn description_template(&self) -> &str {
        "Atomically insert, replace, or delete one cell in an existing Jupyter notebook. Replace and delete require cell_id. Insert places the new cell after cell_id, or at the beginning when cell_id is omitted."
    }

    fn emitted_notifications(&self) -> &'static [&'static str] {
        &["FileWritten"]
    }
}

impl xai_tool_runtime::Tool for NotebookEditTool {
    type Args = NotebookEditInput;
    type Output = NotebookEditOutput;

    fn id(&self) -> xai_tool_protocol::ToolId {
        xai_tool_protocol::ToolId::new("notebook_edit").expect("valid tool id")
    }

    fn description(
        &self,
        _ctx: &xai_tool_runtime::ListToolsContext,
    ) -> xai_tool_types::ToolDescription {
        xai_tool_types::ToolDescription::new(
            "notebook_edit",
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
        input: NotebookEditInput,
    ) -> Result<NotebookEditOutput, xai_tool_runtime::ToolError> {
        if !input.notebook_path.to_ascii_lowercase().ends_with(".ipynb") {
            return Err(xai_tool_runtime::ToolError::custom(
                "invalid_notebook_path",
                "notebook_path must identify an .ipynb file",
            ));
        }
        let resources = crate::types::tool_metadata::shared_resources(&ctx)?;
        let (cwd, display_cwd, fs, notifications) = {
            let resources = resources.lock().await;
            (
                resources.require::<Cwd>()?.0.clone(),
                resources.get::<DisplayCwd>().map(|value| value.0.clone()),
                resources.require::<FileSystem>()?.0.clone(),
                resources.require::<NotificationHandle>()?.0.clone(),
            )
        };
        let canonical_cwd = dunce::canonicalize(&cwd).unwrap_or(cwd.clone());
        let resolved = resolve_model_path(&cwd, display_cwd.as_deref(), &input.notebook_path);
        let resolved = normalize_workspace_path(&cwd, resolved).map_err(|message| {
            xai_tool_runtime::ToolError::custom("invalid_notebook_path", message)
        })?;
        let path = dunce::canonicalize(&resolved).unwrap_or(resolved);
        if !path.starts_with(&canonical_cwd) {
            return Err(xai_tool_runtime::ToolError::custom(
                "invalid_notebook_path",
                "notebook resolves outside the workspace",
            ));
        }

        let previous_bytes = fs.read_file(&path).await.map_err(|error| {
            xai_tool_runtime::ToolError::custom(
                "notebook_read_failed",
                format!("failed to read {}: {error}", input.notebook_path),
            )
        })?;
        let previous_content = String::from_utf8(previous_bytes).map_err(|_| {
            xai_tool_runtime::ToolError::custom(
                "invalid_notebook",
                "notebook is not valid UTF-8 JSON",
            )
        })?;
        let mut notebook: serde_json::Value =
            serde_json::from_str(&previous_content).map_err(|e| {
                xai_tool_runtime::ToolError::custom(
                    "invalid_notebook",
                    format!("failed to parse notebook JSON: {e}"),
                )
            })?;
        if notebook.get("nbformat").and_then(serde_json::Value::as_u64) != Some(4) {
            return Err(xai_tool_runtime::ToolError::custom(
                "unsupported_notebook",
                "only Jupyter nbformat 4 notebooks are supported",
            ));
        }
        let cells = notebook
            .get_mut("cells")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| {
                xai_tool_runtime::ToolError::custom(
                    "invalid_notebook",
                    "notebook must contain a cells array",
                )
            })?;

        let changed_cell_id = match input.edit_mode {
            NotebookEditMode::Replace => {
                let cell_id = input
                    .cell_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        xai_tool_runtime::ToolError::custom(
                            "missing_cell_id",
                            "cell_id is required for replace",
                        )
                    })?;
                let cell = cells
                    .iter_mut()
                    .find(|cell| {
                        cell.get("id").and_then(serde_json::Value::as_str) == Some(cell_id)
                    })
                    .ok_or_else(|| {
                        xai_tool_runtime::ToolError::custom(
                            "cell_not_found",
                            format!("cell not found: {cell_id}"),
                        )
                    })?;
                cell["source"] = serde_json::Value::Array(source_lines(&input.new_source));
                cell_id.to_owned()
            }
            NotebookEditMode::Insert => {
                let cell_type = input.cell_type.ok_or_else(|| {
                    xai_tool_runtime::ToolError::custom(
                        "missing_cell_type",
                        "cell_type is required for insert",
                    )
                })?;
                let new_id = uuid::Uuid::now_v7()
                    .simple()
                    .to_string()
                    .chars()
                    .take(8)
                    .collect::<String>();
                let mut cell = serde_json::json!({
                    "id": new_id,
                    "cell_type": cell_type.as_str(),
                    "metadata": {},
                    "source": source_lines(&input.new_source),
                });
                if cell_type == NotebookCellType::Code {
                    cell["execution_count"] = serde_json::Value::Null;
                    cell["outputs"] = serde_json::Value::Array(Vec::new());
                }
                let position = match input.cell_id.as_deref() {
                    Some(anchor) => cells
                        .iter()
                        .position(|candidate| {
                            candidate.get("id").and_then(serde_json::Value::as_str) == Some(anchor)
                        })
                        .map(|index| index + 1)
                        .ok_or_else(|| {
                            xai_tool_runtime::ToolError::custom(
                                "cell_not_found",
                                format!("insertion anchor not found: {anchor}"),
                            )
                        })?,
                    None => 0,
                };
                cells.insert(position, cell);
                new_id
            }
            NotebookEditMode::Delete => {
                let cell_id = input
                    .cell_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        xai_tool_runtime::ToolError::custom(
                            "missing_cell_id",
                            "cell_id is required for delete",
                        )
                    })?;
                let position = cells
                    .iter()
                    .position(|cell| {
                        cell.get("id").and_then(serde_json::Value::as_str) == Some(cell_id)
                    })
                    .ok_or_else(|| {
                        xai_tool_runtime::ToolError::custom(
                            "cell_not_found",
                            format!("cell not found: {cell_id}"),
                        )
                    })?;
                cells.remove(position);
                cell_id.to_owned()
            }
        };
        let cells_count = cells.len();

        if ctx
            .extensions
            .get::<xai_tool_runtime::Cancellation>()
            .is_some_and(|token| token.0.is_cancelled())
        {
            return Err(xai_tool_runtime::ToolError::custom(
                "cancelled",
                "notebook edit was cancelled before writing",
            ));
        }

        let mut content = serde_json::to_string_pretty(&notebook).map_err(|error| {
            xai_tool_runtime::ToolError::custom(
                "notebook_serialize_failed",
                format!("failed to serialize notebook: {error}"),
            )
        })?;
        content.push('\n');
        fs.write_file_atomic(&path, content.as_bytes())
            .await
            .map_err(|error| {
                xai_tool_runtime::ToolError::custom(
                    "notebook_write_failed",
                    format!(
                        "failed to atomically write {}: {error}",
                        input.notebook_path
                    ),
                )
            })?;

        notifications.send_file_written(FileWritten {
            tool_call_id: ctx.call_id.as_str().to_owned(),
            absolute_path: path,
            content,
            previous_content: Some(previous_content),
            is_new_file: false,
        });

        Ok(NotebookEditOutput {
            success: true,
            notebook_path: input.notebook_path,
            edit_mode: input.edit_mode,
            cell_id: changed_cell_id,
            cells_count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::local::LocalFs;
    use crate::notification::types::ToolNotificationHandle;
    use crate::types::resources::Resources;
    use crate::types::tool_metadata::test_ctx;
    use std::sync::Arc;

    #[test]
    fn source_lines_preserve_final_newline_exactly() {
        assert_eq!(source_lines(""), Vec::<serde_json::Value>::new());
        assert_eq!(
            source_lines("a\nb"),
            vec![serde_json::json!("a\n"), serde_json::json!("b")]
        );
        assert_eq!(source_lines("a\n"), vec![serde_json::json!("a\n")]);
    }

    #[tokio::test]
    async fn inserts_code_cell_and_persists_valid_notebook() {
        use xai_tool_runtime::Tool;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.ipynb");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "cells": [],
                "metadata": {},
                "nbformat": 4,
                "nbformat_minor": 5
            }))
            .unwrap(),
        )
        .unwrap();
        let mut resources = Resources::new();
        resources.insert(Cwd(temp.path().to_path_buf()));
        resources.insert(FileSystem(Arc::new(LocalFs)));
        resources.insert(NotificationHandle(ToolNotificationHandle::noop()));

        let output = NotebookEditTool
            .run(
                test_ctx(resources.into_shared()),
                NotebookEditInput {
                    notebook_path: "test.ipynb".into(),
                    new_source: "print('ok')".into(),
                    cell_id: None,
                    edit_mode: NotebookEditMode::Insert,
                    cell_type: Some(NotebookCellType::Code),
                },
            )
            .await
            .unwrap();

        assert_eq!(output.cells_count, 1);
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let cell = &persisted["cells"][0];
        assert_eq!(cell["id"], output.cell_id);
        assert_eq!(cell["source"], serde_json::json!(["print('ok')"]));
        assert_eq!(cell["execution_count"], serde_json::Value::Null);
        assert_eq!(cell["outputs"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn invalid_json_is_rejected_without_overwriting_original() {
        use xai_tool_runtime::Tool;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("broken.ipynb");
        let original = b"{not valid notebook json";
        std::fs::write(&path, original).unwrap();
        let mut resources = Resources::new();
        resources.insert(Cwd(temp.path().to_path_buf()));
        resources.insert(FileSystem(Arc::new(LocalFs)));
        resources.insert(NotificationHandle(ToolNotificationHandle::noop()));

        let error = NotebookEditTool
            .run(
                test_ctx(resources.into_shared()),
                NotebookEditInput {
                    notebook_path: "broken.ipynb".into(),
                    new_source: "ignored".into(),
                    cell_id: None,
                    edit_mode: NotebookEditMode::Insert,
                    cell_type: Some(NotebookCellType::Markdown),
                },
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("failed to parse notebook JSON"));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
}

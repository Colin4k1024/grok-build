//! `NotebookEdit` tool — cell-level Jupyter notebook (.ipynb) editing.
//!
//! Supports insert, replace, and delete operations on individual cells.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookEditInput {
    pub notebook_path: String,
    pub new_source: String,
    #[serde(default)]
    pub cell_id: Option<String>,
    #[serde(default = "default_edit_mode")]
    pub edit_mode: String,
    #[serde(default)]
    pub cell_type: Option<String>,
}

fn default_edit_mode() -> String {
    "replace".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookEditOutput {
    pub success: bool,
    pub message: String,
}

pub fn execute(input: &NotebookEditInput) -> Result<NotebookEditOutput, String> {
    let path = Path::new(&input.notebook_path);
    if !path.exists() {
        return Err(format!("notebook not found: {}", input.notebook_path));
    }

    let content =
        std::fs::read_to_string(path).map_err(|e| format!("read notebook: {e}"))?;
    let mut notebook: Value =
        serde_json::from_str(&content).map_err(|e| format!("parse notebook JSON: {e}"))?;

    let cells = notebook
        .get_mut("cells")
        .and_then(|c| c.as_array_mut())
        .ok_or_else(|| "notebook has no cells array".to_string())?;

    match input.edit_mode.as_str() {
        "replace" => {
            let cell_id = input
                .cell_id
                .as_ref()
                .ok_or_else(|| "cell_id required for replace".to_string())?;
            let cell = cells
                .iter_mut()
                .find(|c| c.get("id").and_then(|id| id.as_str()) == Some(cell_id))
                .ok_or_else(|| format!("cell not found: {cell_id}"))?;
            let source_lines: Vec<Value> = input
                .new_source
                .lines()
                .map(|line| Value::String(format!("{line}\n")))
                .collect();
            cell["source"] = Value::Array(source_lines);
        }
        "insert" => {
            let cell_type = input
                .cell_type
                .as_ref()
                .ok_or_else(|| "cell_type required for insert".to_string())?;
            let new_id = uuid::Uuid::now_v7()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>();
            let source_lines: Vec<Value> = input
                .new_source
                .lines()
                .map(|line| Value::String(format!("{line}\n")))
                .collect();
            let new_cell = serde_json::json!({
                "id": new_id,
                "cell_type": cell_type,
                "source": source_lines,
                "metadata": {},
                "outputs": []
            });
            match &input.cell_id {
                Some(after_id) => {
                    let pos = cells
                        .iter()
                        .position(|c| {
                            c.get("id").and_then(|id| id.as_str()) == Some(after_id)
                        })
                        .ok_or_else(|| format!("cell not found: {after_id}"))?;
                    cells.insert(pos + 1, new_cell);
                }
                None => cells.insert(0, new_cell),
            }
        }
        "delete" => {
            let cell_id = input
                .cell_id
                .as_ref()
                .ok_or_else(|| "cell_id required for delete".to_string())?;
            let pos = cells
                .iter()
                .position(|c| c.get("id").and_then(|id| id.as_str()) == Some(cell_id))
                .ok_or_else(|| format!("cell not found: {cell_id}"))?;
            cells.remove(pos);
        }
        other => return Err(format!("unknown edit_mode: {other}")),
    }

    let output = serde_json::to_string_pretty(&notebook)
        .map_err(|e| format!("serialize notebook: {e}"))?;
    std::fs::write(path, output).map_err(|e| format!("write notebook: {e}"))?;

    Ok(NotebookEditOutput {
        success: true,
        message: format!("{} completed on {}", input.edit_mode, input.notebook_path),
    })
}

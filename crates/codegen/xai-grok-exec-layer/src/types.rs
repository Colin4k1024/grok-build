//! Core data types for the unified execution layer.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// OperationId – UUID newtype
// ---------------------------------------------------------------------------

/// Unique identifier for every operation that goes through the executor.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OperationId(uuid::Uuid);

impl OperationId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl Default for OperationId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for OperationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ---------------------------------------------------------------------------
// Operation classification
// ---------------------------------------------------------------------------

/// The kind of operation performed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OperationType {
    Bash,
    Edit,
    Write,
}

// ---------------------------------------------------------------------------
// State snapshots
// ---------------------------------------------------------------------------

/// Snapshot captured *before* an operation executes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PreState {
    /// Environment variables captured before a bash command ran.
    Bash {
        env: HashMap<String, String>,
        cwd: PathBuf,
    },
    /// File state captured before an edit/write.
    File(FileSnapshot),
}

/// Snapshot captured *after* an operation completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PostState {
    /// Nothing to capture (e.g. bash output is the post-state itself).
    None,
    /// File state after the write / edit.
    File(FileSnapshot),
}

/// A point-in-time snapshot of a file's contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileSnapshot {
    /// File did not exist prior to (or after) the operation.
    NonExistent,
    /// Full file content, stored inline (file < 1 MB).
    Full {
        content: Vec<u8>,
        sha256: String,
    },
    /// Only the SHA-256 hash is stored (file >= 1 MB) to save memory.
    Incremental {
        sha256: String,
        size: u64,
    },
}

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

/// A single contiguous block of changes inside a diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunk {
    /// 0-based line in the old file where the hunk starts.
    pub old_start: usize,
    /// Number of lines from the old file in this hunk.
    pub old_count: usize,
    /// 0-based line in the new file where the hunk starts.
    pub new_start: usize,
    /// Number of lines in the new file in this hunk.
    pub new_count: usize,
    /// Human-readable hunk text (unified-diff style lines).
    pub lines: Vec<String>,
}

/// Per-file diff produced by an edit or write operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: PathBuf,
    pub hunks: Vec<DiffHunk>,
}

/// A single changed line inside a [`ChunkDiff`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkDiff {
    /// `+` for addition, `-` for deletion, ` ` for context.
    pub tag: String,
    pub value: String,
}

/// Aggregate statistics across all diffs in an operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffStats {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// Summary of all file diffs produced by an operation (or across history).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffSummary {
    pub files: Vec<FileDiff>,
    pub stats: DiffStats,
}

// ---------------------------------------------------------------------------
// Operation record – stored in history
// ---------------------------------------------------------------------------

/// One completed (or attempted) operation recorded by the executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationRecord {
    pub id: OperationId,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub op_type: OperationType,
    pub pre_state: PreState,
    pub post_state: PostState,
    pub diff: Option<DiffSummary>,
    pub success: bool,
}

// ---------------------------------------------------------------------------
// Request / Output types
// ---------------------------------------------------------------------------

/// Input for `exec_bash`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashRequest {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub timeout_ms: Option<u64>,
}

/// Output produced by `exec_bash`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Input for `exec_edit` – a literal string-replace operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditRequest {
    pub file_path: PathBuf,
    pub old_string: String,
    pub new_string: String,
}

/// Output produced by `exec_edit`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditOutput {
    pub file_path: PathBuf,
    pub diff: DiffSummary,
}

/// Input for `exec_write` – create or overwrite a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteRequest {
    pub file_path: PathBuf,
    pub content: Vec<u8>,
}

/// Output produced by `exec_write`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteOutput {
    pub file_path: PathBuf,
    pub diff: DiffSummary,
    /// Whether the file was newly created (did not exist before).
    pub created: bool,
}

/// Report returned by `undo` / `undo_last`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoReport {
    pub operation_id: OperationId,
    pub file_path: Option<PathBuf>,
    pub success: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Errors that can occur during execution.
#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("file not found: {0}")]
    FileNotFound(PathBuf),

    #[error("string not found in file: {path}")]
    StringNotFound { path: PathBuf },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("command failed with exit code {exit_code}: {stderr}")]
    CommandFailed { exit_code: i32, stderr: String },

    #[error("nothing to undo")]
    NothingToUndo,

    #[error("cannot undo operation {0}: no pre-state available")]
    NoPreState(OperationId),

    #[error("lock acquisition failed for {0}")]
    LockError(PathBuf),

    #[error("snapshot error: {0}")]
    Snapshot(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Convenience alias.
pub type ExecResult<T> = Result<T, ExecError>;

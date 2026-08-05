//! # xai-grok-exec-layer — Unified Exec Layer
//!
//! Provides a single trait ([`UnifiedExecutor`]) and a default implementation
//! ([`DefaultUnifiedExecutor`]) that unifies bash execution, file editing,
//! file writing, and undo/rollback behind one consistent interface.
//!
//! Every operation is recorded with pre/post state snapshots and a diff, so the
//! full history can be inspected and any operation can be rolled back.

#![allow(unused)]

pub mod diff;
pub mod executor;
pub mod rollback;
pub mod snapshot;
pub mod types;

// Re-export key types at crate root for convenience.
pub use executor::DefaultUnifiedExecutor;
pub use types::{
    BashOutput, BashRequest, ChunkDiff, DiffHunk, DiffStats, DiffSummary, EditOutput, EditRequest,
    ExecError, ExecResult, FileDiff, FileSnapshot, OperationId, OperationRecord, OperationType,
    PreState, PostState, UndoReport, WriteOutput, WriteRequest,
};

/// Core trait: a unified interface for executing commands and file operations.
///
/// Implementors must record every operation for undo/rollback support.
pub trait UnifiedExecutor {
    /// Run a shell command and return its output.
    fn exec_bash(&mut self, req: BashRequest) -> ExecResult<BashOutput>;

    /// Perform a string-replace edit on an existing file.
    fn exec_edit(&mut self, req: EditRequest) -> ExecResult<EditOutput>;

    /// Write (create or overwrite) a file.
    fn exec_write(&mut self, req: WriteRequest) -> ExecResult<WriteOutput>;

    /// Undo the most recent operation.
    fn undo_last(&mut self) -> ExecResult<UndoReport>;

    /// Undo a specific operation by id (and everything after it).
    fn undo(&mut self, op_id: OperationId) -> ExecResult<UndoReport>;

    /// Aggregate diff summary across all recorded operations.
    fn diff_summary(&self) -> DiffSummary;

    /// Full operation history.
    fn history(&self) -> &[OperationRecord];
}

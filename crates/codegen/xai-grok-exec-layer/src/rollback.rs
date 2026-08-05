//! Rollback engine – records pre-state, supports undo, and tracks history.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::snapshot::SnapshotEngine;
use crate::types::{
    DiffSummary, ExecError, ExecResult, FileSnapshot, OperationId, OperationRecord, OperationType,
    PreState, UndoReport,
};

// ---------------------------------------------------------------------------
// FileLockManager + RAII guard
// ---------------------------------------------------------------------------

/// Maps file paths to per-file locks so concurrent operations on the same
/// file are serialised.
#[derive(Debug, Default)]
pub struct FileLockManager {
    locks: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
}

/// RAII guard that releases the lock when dropped.
pub struct FileGuard {
    flag: Arc<AtomicBool>,
    path: PathBuf,
}

impl FileLockManager {
    pub fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire a per-file lock for `path`.  Spins until the lock is available.
    /// The returned [`FileGuard`] releases the lock on drop.
    pub fn acquire(&self, path: &Path) -> FileGuard {
        let flag = {
            let mut map = self.locks.lock();
            map.entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(AtomicBool::new(false)))
                .clone()
        };

        // Spin until we acquire the lock.
        while flag
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            std::thread::yield_now();
        }

        FileGuard {
            flag,
            path: path.to_path_buf(),
        }
    }
}

impl Drop for FileGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
        tracing::debug!(path = %self.path.display(), "file lock released");
    }
}

// ---------------------------------------------------------------------------
// RollbackEngine
// ---------------------------------------------------------------------------

/// Engine that records the history of operations and supports rolling back to
/// any prior state using stored pre-state snapshots.
pub struct RollbackEngine {
    history: Vec<OperationRecord>,
    snapshot_engine: SnapshotEngine,
    lock_manager: Arc<FileLockManager>,
}

impl RollbackEngine {
    pub fn new(lock_manager: Arc<FileLockManager>) -> Self {
        Self {
            history: Vec::new(),
            snapshot_engine: SnapshotEngine::new(),
            lock_manager,
        }
    }

    /// Acquire the file-lock manager (for external callers).
    pub fn lock_manager(&self) -> &FileLockManager {
        &self.lock_manager
    }

    // -- state capture ------------------------------------------------------

    /// Record a file's pre-state before an operation mutates it.
    pub fn record_pre_state(&mut self, path: &Path) -> ExecResult<PreState> {
        let snap = self.snapshot_engine.capture(path)?;
        Ok(PreState::File(snap))
    }

    // -- history management -------------------------------------------------

    /// Push a completed operation into the history.
    pub fn push_operation(&mut self, record: OperationRecord) {
        self.history.push(record);
    }

    /// Return a read-only view of the full operation history.
    pub fn history(&self) -> &[OperationRecord] {
        &self.history
    }

    /// Compute an aggregate [`DiffSummary`] across all recorded operations.
    pub fn diff_summary(&self) -> DiffSummary {
        let mut all_files = Vec::new();
        let mut total_ins: usize = 0;
        let mut total_del: usize = 0;
        let mut total_files: usize = 0;

        for rec in &self.history {
            if let Some(ds) = &rec.diff {
                total_ins += ds.stats.insertions;
                total_del += ds.stats.deletions;
                total_files += ds.stats.files_changed;
                all_files.extend(ds.files.iter().cloned());
            }
        }

        DiffSummary {
            files: all_files,
            stats: crate::types::DiffStats {
                files_changed: total_files,
                insertions: total_ins,
                deletions: total_del,
            },
        }
    }

    // -- rollback -----------------------------------------------------------

    /// Undo the most recently recorded operation.
    pub fn rollback_last(&mut self) -> ExecResult<UndoReport> {
        let record = self
            .history
            .pop()
            .ok_or(ExecError::NothingToUndo)?;
        self.apply_rollback(&record)
    }

    /// Undo operations back to (and including) the operation with the given id.
    ///
    /// All operations after `target_id` (in reverse chronological order) are
    /// rolled back first, then `target_id` itself.
    pub fn rollback_to(&mut self, target_id: &OperationId) -> ExecResult<UndoReport> {
        // Find the target's index.
        let idx = self
            .history
            .iter()
            .position(|r| r.id == *target_id)
            .ok_or_else(|| ExecError::NoPreState(target_id.clone()))?;

        // Roll back from the tail up to (and including) idx.
        while self.history.len() > idx {
            let record = self.history.pop().unwrap();
            self.apply_rollback(&record)?;
        }

        Ok(UndoReport {
            operation_id: target_id.clone(),
            file_path: None,
            success: true,
            message: format!("Rolled back to operation {}", target_id),
        })
    }

    /// Apply the inverse of a single operation.
    fn apply_rollback(&self, record: &OperationRecord) -> ExecResult<UndoReport> {
        match &record.pre_state {
            PreState::File(snap) => {
                let path = extract_file_path(record);
                if let Some(p) = &path {
                    let _guard = self.lock_manager.acquire(p);
                    restore_from_snapshot(p, snap)?;
                }
                Ok(UndoReport {
                    operation_id: record.id.clone(),
                    file_path: path,
                    success: true,
                    message: "File restored to pre-operation state".to_string(),
                })
            }
            PreState::Bash { .. } => Ok(UndoReport {
                operation_id: record.id.clone(),
                file_path: None,
                success: true,
                message: "Bash operations cannot be undone (no-op)".to_string(),
            }),
        }
    }
}

impl Default for RollbackEngine {
    fn default() -> Self {
        Self::new(Arc::new(FileLockManager::new()))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Try to pull the file path out of a record's diff or post-state.
fn extract_file_path(record: &OperationRecord) -> Option<PathBuf> {
    if let Some(diff) = &record.diff {
        if let Some(first) = diff.files.first() {
            return Some(first.path.clone());
        }
    }
    None
}

/// Restore a file from a [`FileSnapshot`].
fn restore_from_snapshot(path: &Path, snapshot: &FileSnapshot) -> ExecResult<()> {
    match snapshot {
        FileSnapshot::NonExistent => {
            if path.exists() {
                fs::remove_file(path)?;
            }
            Ok(())
        }
        FileSnapshot::Full { content, .. } => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, content)?;
            Ok(())
        }
        FileSnapshot::Incremental { .. } => {
            // We only have a hash — we cannot restore. Return an error so
            // callers know the rollback is incomplete.
            Err(ExecError::Snapshot(format!(
                "cannot restore {} from incremental snapshot (hash-only)",
                path.display()
            )))
        }
    }
}

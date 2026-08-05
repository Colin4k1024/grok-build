//! Default implementation of [`UnifiedExecutor`].

use std::collections::HashMap;
use std::env;
use std::fs;
use std::process::Command;
use std::sync::Arc;

use chrono::Utc;

use crate::diff::{compute_diff, compute_text_diff};
use crate::rollback::{FileLockManager, RollbackEngine};
use crate::types::{
    BashOutput, BashRequest, DiffSummary, EditOutput, EditRequest, ExecError, ExecResult,
    OperationId, OperationRecord, OperationType, PostState, PreState, UndoReport, WriteOutput,
    WriteRequest,
};
use crate::UnifiedExecutor;

// ---------------------------------------------------------------------------
// DefaultUnifiedExecutor
// ---------------------------------------------------------------------------

/// Concrete executor that runs real processes and performs real file I/O,
/// recording every operation for undo support.
pub struct DefaultUnifiedExecutor {
    rollback: RollbackEngine,
    lock_manager: Arc<FileLockManager>,
}

impl DefaultUnifiedExecutor {
    pub fn new() -> Self {
        let lock_manager = Arc::new(FileLockManager::new());
        Self {
            rollback: RollbackEngine::new(lock_manager.clone()),
            lock_manager,
        }
    }
}

impl Default for DefaultUnifiedExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl UnifiedExecutor for DefaultUnifiedExecutor {
    // -- bash ---------------------------------------------------------------

    fn exec_bash(&mut self, req: BashRequest) -> ExecResult<BashOutput> {
        let op_id = OperationId::new();

        // Capture environment snapshot.
        let pre_env: HashMap<String, String> = env::vars().collect();
        let cwd = req
            .cwd
            .clone()
            .unwrap_or_else(|| env::current_dir().unwrap_or_default());
        let pre_state = PreState::Bash {
            env: pre_env,
            cwd,
        };

        let mut cmd = Command::new(&req.command);
        cmd.args(&req.args);

        // Merge caller-supplied environment on top of the current one.
        for (k, v) in &req.env {
            cmd.env(k, v);
        }

        if let Some(cwd) = &req.cwd {
            cmd.current_dir(cwd);
        }

        // Optional timeout: we use the blocking `Command` API — if a timeout
        // is specified we spawn a thread so the async runtime isn't blocked
        // forever.  For simplicity in this first version we just run the
        // command synchronously and let the caller enforce timeouts externally.

        let output = cmd.output().map_err(ExecError::Io)?;

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let exit_code = output.status.code().unwrap_or(-1);

        // Record the operation.
        self.rollback.push_operation(OperationRecord {
            id: op_id,
            timestamp: Utc::now(),
            op_type: OperationType::Bash,
            pre_state,
            post_state: PostState::None,
            diff: None,
            success: output.status.success(),
        });

        Ok(BashOutput {
            exit_code,
            stdout,
            stderr,
        })
    }

    // -- edit (string replace) ----------------------------------------------

    fn exec_edit(&mut self, req: EditRequest) -> ExecResult<EditOutput> {
        let op_id = OperationId::new();

        if !req.file_path.exists() {
            return Err(ExecError::FileNotFound(req.file_path));
        }

        // All file-mutating work happens inside this block so the guard is
        // dropped before we call `push_operation` (which takes &mut self).
        let (pre_state, old_content, new_content, diff) = {
            let _guard = self.lock_manager.acquire(&req.file_path);

            // Capture pre-state.
            let pre_state = self.rollback.record_pre_state(&req.file_path)?;
            let old_content = fs::read_to_string(&req.file_path)?;

            // Perform the replacement.
            if !old_content.contains(&req.old_string) {
                return Err(ExecError::StringNotFound {
                    path: req.file_path,
                });
            }
            let new_content = old_content.replace(&req.old_string, &req.new_string);
            fs::write(&req.file_path, &new_content)?;

            // Compute diff.
            let diff = compute_text_diff(&req.file_path, &old_content, &new_content);

            (pre_state, old_content, new_content, diff)
            // _guard dropped here → lock released
        };

        self.rollback.push_operation(OperationRecord {
            id: op_id,
            timestamp: Utc::now(),
            op_type: OperationType::Edit,
            pre_state,
            post_state: PostState::File(
                crate::snapshot::SnapshotEngine::new()
                    .capture(&req.file_path)
                    .unwrap_or(crate::types::FileSnapshot::NonExistent),
            ),
            diff: Some(diff.clone()),
            success: true,
        });

        Ok(EditOutput {
            file_path: req.file_path,
            diff,
        })
    }

    // -- write (create/overwrite) -------------------------------------------

    fn exec_write(&mut self, req: WriteRequest) -> ExecResult<WriteOutput> {
        let op_id = OperationId::new();

        // All file-mutating work happens inside this block so the guard is
        // dropped before we call `push_operation` (which takes &mut self).
        let (pre_state, old_bytes, existed, diff) = {
            let _guard = self.lock_manager.acquire(&req.file_path);

            // Capture pre-state.
            let pre_state = self.rollback.record_pre_state(&req.file_path)?;
            let existed = req.file_path.exists();

            let old_bytes = if existed {
                fs::read(&req.file_path).unwrap_or_default()
            } else {
                Vec::new()
            };

            // Write new content.
            if let Some(parent) = req.file_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&req.file_path, &req.content)?;

            // Compute diff.
            let diff = compute_diff(&req.file_path, &old_bytes, &req.content);

            (pre_state, old_bytes, existed, diff)
            // _guard dropped here → lock released
        };

        self.rollback.push_operation(OperationRecord {
            id: op_id,
            timestamp: Utc::now(),
            op_type: OperationType::Write,
            pre_state,
            post_state: PostState::File(
                crate::snapshot::SnapshotEngine::new()
                    .capture(&req.file_path)
                    .unwrap_or(crate::types::FileSnapshot::NonExistent),
            ),
            diff: Some(diff.clone()),
            success: true,
        });

        Ok(WriteOutput {
            file_path: req.file_path,
            diff,
            created: !existed,
        })
    }

    // -- undo ---------------------------------------------------------------

    fn undo_last(&mut self) -> ExecResult<UndoReport> {
        self.rollback.rollback_last()
    }

    fn undo(&mut self, op_id: crate::types::OperationId) -> ExecResult<UndoReport> {
        self.rollback.rollback_to(&op_id)
    }

    // -- queries ------------------------------------------------------------

    fn diff_summary(&self) -> DiffSummary {
        self.rollback.diff_summary()
    }

    fn history(&self) -> &[OperationRecord] {
        self.rollback.history()
    }
}

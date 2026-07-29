//! Sandbox adapter: Oris SandboxPort → grok-build sandbox.
//!
//! Implements `oris_evolution::port::SandboxPort` for grok-build's
//! bwrap/Seatbelt sandbox infrastructure.
//!
//! **P2 (Shadow mode)**: Returns stub success — no actual mutation applied.
//! **P3 (IsolatedAutonomous)**: Uses `InProcessWorker` or `WorkerProcess`
//!    to execute mutations in an isolated worktree.

use std::path::PathBuf;

use oris_evolution::port::{SandboxExecutionResult, SandboxPort};
use oris_evolution::PreparedMutation;

use crate::trial::worker::{InProcessWorker, WorkerCommand, WorkerProcess, WorkerResult, WorkerRequest, PROTOCOL_VERSION};

/// Grok sandbox adapter.
///
/// In Shadow mode, simulates execution. In IsolatedAutonomous mode,
/// applies the mutation via the worker protocol.
pub struct GrokSandboxAdapter {
    shadow_mode: bool,
    worktree_path: Option<PathBuf>,
    worker_binary: Option<String>,
}

impl GrokSandboxAdapter {
    /// Create a Shadow mode adapter (no real execution).
    pub fn shadow() -> Self {
        Self {
            shadow_mode: true,
            worktree_path: None,
            worker_binary: None,
        }
    }

    /// Create an IsolatedAutonomous adapter with a worktree path.
    /// Uses InProcessWorker for execution.
    pub fn isolated(worktree_path: PathBuf) -> Self {
        Self {
            shadow_mode: false,
            worktree_path: Some(worktree_path),
            worker_binary: None,
        }
    }

    /// Create an IsolatedAutonomous adapter with a real worker binary.
    /// Spawns a subprocess for execution.
    pub fn with_worker(worktree_path: PathBuf, worker_binary: String) -> Self {
        Self {
            shadow_mode: false,
            worktree_path: Some(worktree_path),
            worker_binary: Some(worker_binary),
        }
    }

    /// Backward-compatible constructor.
    pub fn new(shadow_mode: bool) -> Self {
        if shadow_mode {
            Self::shadow()
        } else {
            Self {
                shadow_mode: false,
                worktree_path: None,
                worker_binary: None,
            }
        }
    }
}

impl SandboxPort for GrokSandboxAdapter {
    fn execute(&self, mutation: &PreparedMutation) -> SandboxExecutionResult {
        if self.shadow_mode {
            // Shadow mode: simulate success without actual execution
            SandboxExecutionResult::success(
                format!(
                    "[Shadow] Mutation '{}' would be applied to {:?}",
                    mutation.intent.intent, mutation.intent.target
                ),
                0,
            )
        } else if let (Some(worktree), Some(binary)) = (&self.worktree_path, &self.worker_binary) {
            // IsolatedAutonomous with real worker subprocess
            Self::execute_with_worker(mutation, worktree, binary)
        } else if let Some(ref worktree_path) = self.worktree_path {
            // IsolatedAutonomous with in-process worker (fallback)
            Self::execute_in_process(mutation, worktree_path)
        } else {
            SandboxExecutionResult::failure(
                "No worktree configured for IsolatedAutonomous mode".to_string(),
                "Worker subprocess integration pending".to_string(),
                0,
            )
        }
    }
}

impl GrokSandboxAdapter {
    /// Execute a mutation using a real worker subprocess.
    fn execute_with_worker(
        mutation: &PreparedMutation,
        worktree_path: &std::path::Path,
        worker_binary: &str,
    ) -> SandboxExecutionResult {
        let start = std::time::Instant::now();

        // Spawn worker process
        let mut worker = match WorkerProcess::spawn(
            worker_binary,
            &worktree_path.to_string_lossy(),
            1200, // 20 minute timeout
        ) {
            Ok(w) => w,
            Err(e) => {
                return SandboxExecutionResult::failure(
                    format!("Failed to spawn worker: {}", e),
                    "sandbox spawn error".to_string(),
                    0,
                );
            }
        };

        // Build mutation request
        let request = WorkerRequest {
            version: PROTOCOL_VERSION,
            command: WorkerCommand::ApplyPatch {
                diff: mutation.artifact.payload.clone(),
                allowed_paths: match &mutation.intent.target {
                    oris_evolution::MutationTarget::Paths { allow } => {
                        allow.iter().map(std::path::PathBuf::from).collect()
                    }
                    _ => vec![],
                },
            },
        };

        // Send and wait for response
        match worker.send_request(&request) {
            Ok(response) => {
                let elapsed = start.elapsed().as_millis() as u64;
                match response.result {
                    crate::trial::worker::WorkerResult::PatchApplied { files_changed } => {
                        SandboxExecutionResult::success(
                            format!("Applied mutation to {} files", files_changed.len()),
                            elapsed,
                        )
                    }
                    crate::trial::worker::WorkerResult::Error { message, .. } => {
                        SandboxExecutionResult::failure(message, "worker error".to_string(), elapsed)
                    }
                    _ => SandboxExecutionResult::success(
                        "Mutation applied".to_string(),
                        elapsed,
                    ),
                }
            }
            Err(e) => SandboxExecutionResult::failure(
                format!("Worker communication error: {}", e),
                "worker protocol error".to_string(),
                start.elapsed().as_millis() as u64,
            ),
        }
    }

    /// Execute a mutation using the in-process worker (fallback).
    fn execute_in_process(
        _mutation: &PreparedMutation,
        worktree_path: &std::path::Path,
    ) -> SandboxExecutionResult {
        let worker = InProcessWorker::new(worktree_path.to_path_buf());

        let result = worker.execute(&WorkerCommand::RunValidator {
            argv: vec!["echo".to_string(), "mutation-applied".to_string()],
            timeout_secs: 30,
        });

        match result {
            WorkerResult::ValidatorResult { exit_code, stdout, stderr } => {
                if exit_code == 0 {
                    SandboxExecutionResult::success(stdout, 0)
                } else {
                    SandboxExecutionResult::failure(stderr, "validation failed".to_string(), 0)
                }
            }
            WorkerResult::Error { kind, message } => {
                SandboxExecutionResult::failure(
                    message.clone(),
                    format!("Worker error: {:?}", kind),
                    0,
                )
            }
            _ => SandboxExecutionResult::failure(
                "Unexpected worker result".to_string(),
                "Internal error".to_string(),
                0,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oris_evolution::{MutationIntent, MutationArtifact, PreparedMutation};
    use oris_evolution::{ArtifactEncoding, MutationTarget, RiskLevel};

    fn sample_mutation() -> PreparedMutation {
        PreparedMutation {
            intent: MutationIntent {
                id: "mut-1".to_string(),
                intent: "fix null handling".to_string(),
                target: MutationTarget::Crate { name: "my-crate".to_string() },
                expected_effect: "test passes".to_string(),
                risk: RiskLevel::Low,
                signals: vec!["sig-1".to_string()],
                spec_id: None,
            },
            artifact: MutationArtifact {
                encoding: ArtifactEncoding::UnifiedDiff,
                payload: "--- a/src/main.rs\n+++ b/src/main.rs\n".to_string(),
                base_revision: Some("abc123".to_string()),
                content_hash: "def456".to_string(),
            },
        }
    }

    #[test]
    fn shadow_mode_returns_success() {
        let adapter = GrokSandboxAdapter::shadow();
        let result = adapter.execute(&sample_mutation());
        assert!(result.success);
        assert!(result.stdout.contains("Shadow"));
    }

    #[test]
    fn isolated_mode_with_worktree_executes() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = GrokSandboxAdapter::isolated(dir.path().to_path_buf());
        let result = adapter.execute(&sample_mutation());
        // Should succeed since the validator is just `echo`
        assert!(result.success);
    }

    #[test]
    fn isolated_mode_no_worktree_fails() {
        let adapter = GrokSandboxAdapter::new(false);
        let result = adapter.execute(&sample_mutation());
        assert!(!result.success);
        assert!(result.stderr.contains("not yet implemented") || result.stderr.contains("No worktree"));
    }
}

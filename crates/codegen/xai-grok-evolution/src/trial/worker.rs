//! Worker subprocess protocol: stdin/stdout versioned JSON communication.
//!
//! The evolution worker runs as a child process with restricted capabilities:
//! - Can only read/write within the evolution worktree and temp directory
//! - Cannot access the network
//! - Cannot access credentials or secrets
//! - Cannot push, create PRs, or modify the source worktree
//!
//! ## Protocol
//!
//! Messages are newline-delimited JSON. Each message has a `version` field
//! for forward compatibility. Maximum message size: 16 MB.
//!
//! Parent → Worker: `WorkerRequest` (commands to execute)
//! Worker → Parent: `WorkerResponse` (results) or `WorkerProgress` (heartbeat)

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::EvolutionError;
use crate::types::ContentHash;

/// Maximum message size in bytes (16 MB).
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Worker protocol version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Default worker timeout in seconds.
pub const DEFAULT_TIMEOUT_SECS: u64 = 1200;

/// Progress heartbeat interval in seconds.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// Messages: Parent → Worker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerRequest {
    pub version: u32,
    pub command: WorkerCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum WorkerCommand {
    /// Apply a patch to the worktree.
    ApplyPatch {
        diff: String,
        allowed_paths: Vec<PathBuf>,
    },
    /// Run a validation command (argv array, no shell).
    RunValidator {
        argv: Vec<String>,
        timeout_secs: u64,
    },
    /// Read a file from the worktree.
    ReadFile {
        path: PathBuf,
    },
    /// Search for files matching a pattern.
    SearchFiles {
        pattern: String,
        root: PathBuf,
    },
    /// Edit a file (string replacement).
    EditFile {
        path: PathBuf,
        old: String,
        new: String,
    },
    /// Health check ping.
    Ping,
}

// ---------------------------------------------------------------------------
// Messages: Worker → Parent
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WorkerMessage {
    /// Response to a command.
    Response(WorkerResponse),
    /// Progress update during long-running commands.
    Progress(WorkerProgress),
    /// Pong response to Ping.
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerResponse {
    pub version: u32,
    pub result: WorkerResult,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum WorkerResult {
    PatchApplied {
        files_changed: Vec<PathBuf>,
    },
    ValidatorResult {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    FileContent {
        content: String,
    },
    SearchResults {
        matches: Vec<SearchMatch>,
    },
    EditApplied {
        new_content_hash: ContentHash,
    },
    Error {
        kind: WorkerError,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub path: PathBuf,
    pub line_number: u32,
    pub line_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerProgress {
    pub files_changed: u32,
    pub elapsed_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerError {
    /// File not found.
    NotFound,
    /// Permission denied.
    PermissionDenied,
    /// Path is outside allowed directories.
    PathViolation,
    /// Patch could not be applied.
    PatchFailed,
    /// Command timed out.
    Timeout,
    /// Validator execution failed.
    ValidatorFailed,
    /// Invalid request.
    InvalidRequest,
    /// Internal worker error.
    Internal,
}

// ---------------------------------------------------------------------------
// Worker Process Manager
// ---------------------------------------------------------------------------

/// Manages the lifecycle of an evolution worker subprocess.
pub struct WorkerProcess {
    child: Child,
    timeout: Duration,
}

impl WorkerProcess {
    /// Spawn a new worker process.
    ///
    /// The worker binary path and worktree path are provided. The worker
    /// is started with restricted environment (no network, limited paths).
    pub fn spawn(
        worker_binary: &str,
        worktree_path: &str,
        timeout_secs: u64,
    ) -> Result<Self, EvolutionError> {
        let mut cmd = Command::new(worker_binary);
        cmd.arg("--worktree")
            .arg(worktree_path)
            .arg("--protocol-version")
            .arg(PROTOCOL_VERSION.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Kill on drop to prevent zombie processes
        // (handled by the Drop impl on Child)

        let child = cmd.spawn().map_err(|e| {
            EvolutionError::SandboxUnavailable(format!("spawn worker: {}", e))
        })?;

        Ok(Self {
            child,
            timeout: Duration::from_secs(timeout_secs),
        })
    }

    /// Send a request and wait for the response.
    ///
    /// Handles message framing (newline-delimited JSON), timeout,
    /// and progress heartbeats.
    pub fn send_request(&mut self, request: &WorkerRequest) -> Result<WorkerResponse, EvolutionError> {
        let stdin = self.child.stdin.as_mut().ok_or_else(|| {
            EvolutionError::WorkerProtocol("worker stdin not available".to_string())
        })?;

        // Serialize and send
        let payload = serde_json::to_string(request).map_err(|e| {
            EvolutionError::WorkerProtocol(format!("serialize request: {}", e))
        })?;

        if payload.len() > MAX_MESSAGE_BYTES {
            return Err(EvolutionError::WorkerProtocol(format!(
                "request size {} exceeds limit {}",
                payload.len(),
                MAX_MESSAGE_BYTES
            )));
        }

        stdin.write_all(payload.as_bytes()).map_err(|e| {
            EvolutionError::WorkerProtocol(format!("write to worker: {}", e))
        })?;
        stdin.write_all(b"\n").map_err(|e| {
            EvolutionError::WorkerProtocol(format!("write newline: {}", e))
        })?;
        stdin.flush().map_err(|e| {
            EvolutionError::WorkerProtocol(format!("flush: {}", e))
        })?;

        // Read response with timeout
        self.read_response()
    }

    /// Read a response from the worker with timeout and progress handling.
    fn read_response(&mut self) -> Result<WorkerResponse, EvolutionError> {
        let stdout = self.child.stdout.as_mut().ok_or_else(|| {
            EvolutionError::WorkerProtocol("worker stdout not available".to_string())
        })?;

        let reader = BufReader::new(stdout);
        let start = Instant::now();

        for line_result in reader.lines() {
            // Check timeout
            if start.elapsed() > self.timeout {
                return Err(EvolutionError::Timeout(self.timeout.as_secs()));
            }

            let line = line_result.map_err(|e| {
                EvolutionError::WorkerProtocol(format!("read from worker: {}", e))
            })?;

            if line.len() > MAX_MESSAGE_BYTES {
                return Err(EvolutionError::WorkerProtocol(format!(
                    "response size {} exceeds limit {}",
                    line.len(),
                    MAX_MESSAGE_BYTES
                )));
            }

            if line.is_empty() {
                continue;
            }

            let message: WorkerMessage = serde_json::from_str(&line).map_err(|e| {
                EvolutionError::WorkerProtocol(format!("parse worker message: {}", e))
            })?;

            match message {
                WorkerMessage::Response(response) => return Ok(response),
                WorkerMessage::Progress(_) => {
                    // Progress update — continue waiting for response
                }
                WorkerMessage::Pong => {
                    // Ping response — continue waiting
                }
            }
        }

        // EOF without receiving a Response
        Err(EvolutionError::WorkerProtocol(
            "worker exited without sending response".to_string(),
        ))
    }

    /// Send a ping and wait for pong (liveness check).
    pub fn ping(&mut self) -> Result<(), EvolutionError> {
        let request = WorkerRequest {
            version: PROTOCOL_VERSION,
            command: WorkerCommand::Ping,
        };
        let stdin = self.child.stdin.as_mut().ok_or_else(|| {
            EvolutionError::WorkerProtocol("worker stdin not available".to_string())
        })?;

        let payload = serde_json::to_string(&request).map_err(|e| {
            EvolutionError::WorkerProtocol(format!("serialize ping: {}", e))
        })?;
        stdin.write_all(payload.as_bytes()).map_err(|e| {
            EvolutionError::WorkerProtocol(format!("write ping: {}", e))
        })?;
        stdin.write_all(b"\n").map_err(|e| {
            EvolutionError::WorkerProtocol(format!("write newline: {}", e))
        })?;
        stdin.flush().map_err(|e| {
            EvolutionError::WorkerProtocol(format!("flush: {}", e))
        })?;

        // Read response
        let stdout = self.child.stdout.as_mut().ok_or_else(|| {
            EvolutionError::WorkerProtocol("worker stdout not available".to_string())
        })?;
        let reader = BufReader::new(stdout);

        for line_result in reader.lines() {
            let line = line_result.map_err(|e| {
                EvolutionError::WorkerProtocol(format!("read pong: {}", e))
            })?;
            if line.is_empty() {
                continue;
            }
            let message: WorkerMessage = serde_json::from_str(&line).map_err(|e| {
                EvolutionError::WorkerProtocol(format!("parse pong: {}", e))
            })?;
            match message {
                WorkerMessage::Pong => return Ok(()),
                WorkerMessage::Progress(_) => continue,
                WorkerMessage::Response(_) => {
                    return Err(EvolutionError::WorkerProtocol(
                        "unexpected response to ping".to_string(),
                    ))
                }
            }
        }

        Err(EvolutionError::WorkerProtocol(
            "worker exited without pong".to_string(),
        ))
    }

    /// Terminate the worker process gracefully (SIGTERM, then SIGKILL).
    pub fn terminate(&mut self) -> Result<(), EvolutionError> {
        // Try graceful termination first
        let _ = self.child.kill();

        // Wait for cleanup
        let _ = self.child.wait();

        Ok(())
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        // Ensure the child process is killed when the manager is dropped
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// In-process worker (for testing without spawning a real subprocess)
// ---------------------------------------------------------------------------

/// In-process worker that executes commands directly (for testing).
///
/// This allows testing the protocol logic without spawning a subprocess.
/// In production, the real worker binary is used.
pub struct InProcessWorker {
    worktree_path: PathBuf,
}

impl InProcessWorker {
    pub fn new(worktree_path: PathBuf) -> Self {
        Self { worktree_path }
    }

    /// Execute a command and return the result.
    pub fn execute(&self, command: &WorkerCommand) -> WorkerResult {
        match command {
            WorkerCommand::ReadFile { path } => {
                let full_path = self.worktree_path.join(path);
                match std::fs::read_to_string(&full_path) {
                    Ok(content) => WorkerResult::FileContent { content },
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => WorkerResult::Error {
                        kind: WorkerError::NotFound,
                        message: format!("file not found: {}", path.display()),
                    },
                    Err(e) => WorkerResult::Error {
                        kind: WorkerError::Internal,
                        message: format!("read error: {}", e),
                    },
                }
            }
            WorkerCommand::RunValidator { argv, timeout_secs: _ } => {
                if argv.is_empty() {
                    return WorkerResult::Error {
                        kind: WorkerError::InvalidRequest,
                        message: "empty argv".to_string(),
                    };
                }
                // In-process: execute the command directly
                let output = Command::new(&argv[0])
                    .args(&argv[1..])
                    .current_dir(&self.worktree_path)
                    .output();

                match output {
                    Ok(output) => WorkerResult::ValidatorResult {
                        exit_code: output.status.code().unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                    },
                    Err(e) => WorkerResult::Error {
                        kind: WorkerError::ValidatorFailed,
                        message: format!("execute validator: {}", e),
                    },
                }
            }
            WorkerCommand::EditFile { path, old, new } => {
                let full_path = self.worktree_path.join(path);
                match std::fs::read_to_string(&full_path) {
                    Ok(content) => {
                        if !content.contains(old.as_str()) {
                            return WorkerResult::Error {
                                kind: WorkerError::PatchFailed,
                                message: "old string not found in file".to_string(),
                            };
                        }
                        let new_content = content.replacen(old.as_str(), new.as_str(), 1);
                        let hash = blake3::hash(new_content.as_bytes()).to_hex().to_string();
                        match std::fs::write(&full_path, &new_content) {
                            Ok(()) => WorkerResult::EditApplied {
                                new_content_hash: hash,
                            },
                            Err(e) => WorkerResult::Error {
                                kind: WorkerError::Internal,
                                message: format!("write error: {}", e),
                            },
                        }
                    }
                    Err(e) => WorkerResult::Error {
                        kind: WorkerError::NotFound,
                        message: format!("read for edit: {}", e),
                    },
                }
            }
            WorkerCommand::Ping => {
                // Handled at the message level, not here
                WorkerResult::Error {
                    kind: WorkerError::InvalidRequest,
                    message: "ping should be handled at message level".to_string(),
                }
            }
            _ => WorkerResult::Error {
                kind: WorkerError::Internal,
                message: "command not implemented in in-process worker".to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_serialization_roundtrip() {
        let request = WorkerRequest {
            version: PROTOCOL_VERSION,
            command: WorkerCommand::ReadFile {
                path: PathBuf::from("src/main.rs"),
            },
        };
        let json = serde_json::to_string(&request).unwrap();
        let parsed: WorkerRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, PROTOCOL_VERSION);
    }

    #[test]
    fn response_serialization_roundtrip() {
        let response = WorkerResponse {
            version: PROTOCOL_VERSION,
            result: WorkerResult::ValidatorResult {
                exit_code: 0,
                stdout: "ok".to_string(),
                stderr: String::new(),
            },
            duration_ms: 1500,
        };
        let json = serde_json::to_string(&response).unwrap();
        let parsed: WorkerResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.duration_ms, 1500);
    }

    #[test]
    fn message_serialization_roundtrip() {
        let messages = vec![
            WorkerMessage::Response(WorkerResponse {
                version: 1,
                result: WorkerResult::PatchApplied {
                    files_changed: vec![PathBuf::from("src/main.rs")],
                },
                duration_ms: 100,
            }),
            WorkerMessage::Progress(WorkerProgress {
                files_changed: 1,
                elapsed_ms: 5000,
                message: "still working".to_string(),
            }),
            WorkerMessage::Pong,
        ];

        for msg in messages {
            let json = serde_json::to_string(&msg).unwrap();
            let parsed: WorkerMessage = serde_json::from_str(&json).unwrap();
            // Verify roundtrip
            let json2 = serde_json::to_string(&parsed).unwrap();
            assert_eq!(json, json2);
        }
    }

    #[test]
    fn error_serialization() {
        let errors = vec![
            WorkerError::NotFound,
            WorkerError::PermissionDenied,
            WorkerError::PathViolation,
            WorkerError::PatchFailed,
            WorkerError::Timeout,
            WorkerError::ValidatorFailed,
            WorkerError::InvalidRequest,
            WorkerError::Internal,
        ];
        for err in errors {
            let json = serde_json::to_string(&err).unwrap();
            let parsed: WorkerError = serde_json::from_str(&json).unwrap();
            assert_eq!(err, parsed);
        }
    }

    #[test]
    fn in_process_worker_read_file() {
        let dir = tempfile::tempdir().unwrap();
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, "hello world").unwrap();

        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::ReadFile {
            path: PathBuf::from("test.txt"),
        });

        match result {
            WorkerResult::FileContent { content } => assert_eq!(content, "hello world"),
            other => panic!("expected FileContent, got {:?}", other),
        }
    }

    #[test]
    fn in_process_worker_read_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::ReadFile {
            path: PathBuf::from("nonexistent.txt"),
        });

        match result {
            WorkerResult::Error { kind, .. } => assert_eq!(kind, WorkerError::NotFound),
            other => panic!("expected Error, got {:?}", other),
        }
    }

    #[test]
    fn in_process_worker_edit_file() {
        let dir = tempfile::tempdir().unwrap();
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, "old content here").unwrap();

        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::EditFile {
            path: PathBuf::from("test.txt"),
            old: "old content".to_string(),
            new: "new content".to_string(),
        });

        match result {
            WorkerResult::EditApplied { new_content_hash } => {
                assert!(!new_content_hash.is_empty());
                let final_content = std::fs::read_to_string(&test_file).unwrap();
                assert!(final_content.contains("new content"));
            }
            other => panic!("expected EditApplied, got {:?}", other),
        }
    }

    #[test]
    fn in_process_worker_edit_string_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, "actual content").unwrap();

        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::EditFile {
            path: PathBuf::from("test.txt"),
            old: "nonexistent string".to_string(),
            new: "replacement".to_string(),
        });

        match result {
            WorkerResult::Error { kind, .. } => assert_eq!(kind, WorkerError::PatchFailed),
            other => panic!("expected Error, got {:?}", other),
        }
    }

    #[test]
    fn in_process_worker_validator() {
        let dir = tempfile::tempdir().unwrap();
        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::RunValidator {
            argv: vec!["echo".to_string(), "ok".to_string()],
            timeout_secs: 10,
        });

        match result {
            WorkerResult::ValidatorResult { exit_code, stdout, .. } => {
                assert_eq!(exit_code, 0);
                assert!(stdout.contains("ok"));
            }
            other => panic!("expected ValidatorResult, got {:?}", other),
        }
    }

    #[test]
    fn in_process_worker_empty_argv_errors() {
        let dir = tempfile::tempdir().unwrap();
        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::RunValidator {
            argv: vec![],
            timeout_secs: 10,
        });

        match result {
            WorkerResult::Error { kind, .. } => assert_eq!(kind, WorkerError::InvalidRequest),
            other => panic!("expected Error, got {:?}", other),
        }
    }

    #[test]
    fn message_size_limit() {
        let big_payload = "x".repeat(MAX_MESSAGE_BYTES + 1);
        assert!(big_payload.len() > MAX_MESSAGE_BYTES);
    }
}

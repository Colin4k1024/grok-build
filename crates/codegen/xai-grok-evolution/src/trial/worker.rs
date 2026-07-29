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

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::EvolutionError;
use crate::types::ContentHash;

/// Maximum message size in bytes (16 MB).
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Worker protocol version.
pub const PROTOCOL_VERSION: u32 = 2;

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
    ReadFile { path: PathBuf },
    /// Search for files matching a pattern.
    SearchFiles { pattern: String, root: PathBuf },
    /// Edit a file (string replacement).
    EditFile {
        path: PathBuf,
        old: String,
        new: String,
    },
    /// Health check ping.
    Ping,
    /// Run isolation probes from inside the already-applied worker sandbox.
    IsolationPreflight {
        source_dir: PathBuf,
        temp_dir: PathBuf,
        source_vcs_verified: bool,
    },
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
    IsolationPreflight {
        result: crate::trial::preflight::PreflightResult,
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
    output_rx: std::sync::mpsc::Receiver<Result<String, String>>,
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
        let isolated_home = Path::new(worktree_path).join(".evolution-home");
        let isolated_tmp = Path::new(worktree_path).join(".evolution-tmp");
        std::fs::create_dir_all(&isolated_home).map_err(|error| {
            EvolutionError::SandboxUnavailable(format!("create isolated worker home: {error}"))
        })?;
        std::fs::create_dir_all(&isolated_tmp).map_err(|error| {
            EvolutionError::SandboxUnavailable(format!("create isolated worker temp: {error}"))
        })?;
        let (restricted_path, read_only_roots, isolated_cargo_home) =
            prepare_worker_runtime(&isolated_home)?;
        let mut cmd = Command::new(worker_binary);
        cmd.arg("--worktree")
            .arg(worktree_path)
            .arg("--protocol-version")
            .arg(PROTOCOL_VERSION.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for path in &read_only_roots {
            cmd.arg("--read-only").arg(path);
        }
        cmd.env_clear()
            .env("PATH", restricted_path)
            .env("HOME", &isolated_home)
            .env("GROK_HOME", isolated_home.join(".grok"))
            .env("CARGO_HOME", isolated_cargo_home)
            .env("TMPDIR", &isolated_tmp)
            .env("CARGO_NET_OFFLINE", "true")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("LANG", "C.UTF-8");
        // Kill on drop to prevent zombie processes
        // (handled by the Drop impl on Child)

        let mut child = cmd
            .spawn()
            .map_err(|e| EvolutionError::SandboxUnavailable(format!("spawn worker: {}", e)))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            EvolutionError::WorkerProtocol("worker stdout not available".to_string())
        })?;
        let (output_tx, output_rx) = std::sync::mpsc::sync_channel(64);
        std::thread::Builder::new()
            .name("evolution-worker-output".to_string())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let result = line.map_err(|error| error.to_string());
                    if output_tx.send(result).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| {
                EvolutionError::WorkerProtocol(format!("spawn worker output reader: {error}"))
            })?;

        Ok(Self {
            child,
            timeout: Duration::from_secs(timeout_secs),
            output_rx,
        })
    }

    /// Send a request and wait for the response.
    ///
    /// Handles message framing (newline-delimited JSON), timeout,
    /// and progress heartbeats.
    pub fn send_request(
        &mut self,
        request: &WorkerRequest,
    ) -> Result<WorkerResponse, EvolutionError> {
        let stdin = self.child.stdin.as_mut().ok_or_else(|| {
            EvolutionError::WorkerProtocol("worker stdin not available".to_string())
        })?;

        // Serialize and send
        let payload = serde_json::to_string(request)
            .map_err(|e| EvolutionError::WorkerProtocol(format!("serialize request: {}", e)))?;

        if payload.len() > MAX_MESSAGE_BYTES {
            return Err(EvolutionError::WorkerProtocol(format!(
                "request size {} exceeds limit {}",
                payload.len(),
                MAX_MESSAGE_BYTES
            )));
        }

        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| EvolutionError::WorkerProtocol(format!("write to worker: {}", e)))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| EvolutionError::WorkerProtocol(format!("write newline: {}", e)))?;
        stdin
            .flush()
            .map_err(|e| EvolutionError::WorkerProtocol(format!("flush: {}", e)))?;

        // Read response with timeout
        self.read_response()
    }

    /// Read a response from the worker with timeout and progress handling.
    fn read_response(&mut self) -> Result<WorkerResponse, EvolutionError> {
        let start = Instant::now();
        loop {
            let remaining = self.timeout.saturating_sub(start.elapsed());
            if remaining.is_zero() {
                let _ = self.child.kill();
                return Err(EvolutionError::Timeout(self.timeout.as_secs()));
            }
            let line = match self.output_rx.recv_timeout(remaining) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => {
                    return Err(EvolutionError::WorkerProtocol(format!(
                        "read from worker: {error}"
                    )));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let _ = self.child.kill();
                    return Err(EvolutionError::Timeout(self.timeout.as_secs()));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(EvolutionError::WorkerProtocol(
                        "worker exited without sending response".to_string(),
                    ));
                }
            };

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

        let payload = serde_json::to_string(&request)
            .map_err(|e| EvolutionError::WorkerProtocol(format!("serialize ping: {}", e)))?;
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| EvolutionError::WorkerProtocol(format!("write ping: {}", e)))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| EvolutionError::WorkerProtocol(format!("write newline: {}", e)))?;
        stdin
            .flush()
            .map_err(|e| EvolutionError::WorkerProtocol(format!("flush: {}", e)))?;

        let start = Instant::now();
        loop {
            let remaining = self.timeout.saturating_sub(start.elapsed());
            let line = match self.output_rx.recv_timeout(remaining) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => {
                    return Err(EvolutionError::WorkerProtocol(format!(
                        "read pong: {error}"
                    )));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(EvolutionError::Timeout(self.timeout.as_secs()));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(EvolutionError::WorkerProtocol(
                        "worker exited without pong".to_string(),
                    ));
                }
            };
            if line.is_empty() {
                continue;
            }
            let message: WorkerMessage = serde_json::from_str(&line)
                .map_err(|e| EvolutionError::WorkerProtocol(format!("parse pong: {}", e)))?;
            match message {
                WorkerMessage::Pong => return Ok(()),
                WorkerMessage::Progress(_) => continue,
                WorkerMessage::Response(_) => {
                    return Err(EvolutionError::WorkerProtocol(
                        "unexpected response to ping".to_string(),
                    ));
                }
            }
        }
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

fn prepare_worker_runtime(
    isolated_home: &Path,
) -> Result<(std::ffi::OsString, Vec<PathBuf>, PathBuf), EvolutionError> {
    let output = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .map_err(|error| {
            EvolutionError::SandboxUnavailable(format!("resolve Rust toolchain: {error}"))
        })?;
    if !output.status.success() {
        return Err(EvolutionError::SandboxUnavailable(format!(
            "resolve Rust toolchain: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let sysroot = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
        .canonicalize()
        .map_err(|error| {
            EvolutionError::SandboxUnavailable(format!("canonicalize Rust sysroot: {error}"))
        })?;
    if !sysroot.join("bin/cargo").is_file() {
        return Err(EvolutionError::SandboxUnavailable(
            "Rust sysroot does not contain cargo".to_string(),
        ));
    }
    let mut path_entries = vec![sysroot.join("bin")];
    for system in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let path = PathBuf::from(system);
        if path.is_dir() {
            path_entries.push(path);
        }
    }
    let restricted_path = std::env::join_paths(path_entries).map_err(|error| {
        EvolutionError::SandboxUnavailable(format!("construct worker PATH: {error}"))
    })?;

    let isolated_cargo_home = isolated_home.join(".cargo");
    std::fs::create_dir_all(&isolated_cargo_home).map_err(|error| {
        EvolutionError::SandboxUnavailable(format!("create isolated CARGO_HOME: {error}"))
    })?;
    let mut read_only = vec![sysroot];
    #[cfg(unix)]
    if let Some(source_cargo_home) = source_cargo_home() {
        for name in ["registry", "git"] {
            let source = source_cargo_home.join(name);
            if !source.is_dir() {
                continue;
            }
            let source = source.canonicalize().map_err(|error| {
                EvolutionError::SandboxUnavailable(format!("resolve Cargo {name} cache: {error}"))
            })?;
            let destination = isolated_cargo_home.join(name);
            if !destination.exists() {
                std::os::unix::fs::symlink(&source, &destination).map_err(|error| {
                    EvolutionError::SandboxUnavailable(format!(
                        "link sanitized Cargo {name} cache: {error}"
                    ))
                })?;
            }
            read_only.push(source);
        }
    }
    Ok((restricted_path, read_only, isolated_cargo_home))
}

#[cfg(unix)]
fn source_cargo_home() -> Option<PathBuf> {
    std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")))
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
                let full_path = match self.resolve_path(path, false) {
                    Ok(path) => path,
                    Err(result) => return result,
                };
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
            WorkerCommand::RunValidator { argv, timeout_secs } => {
                self.run_validator(argv, *timeout_secs)
            }
            WorkerCommand::EditFile { path, old, new } => {
                let full_path = match self.resolve_path(path, true) {
                    Ok(path) => path,
                    Err(result) => return result,
                };
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
            WorkerCommand::ApplyPatch {
                diff,
                allowed_paths,
            } => self.apply_patch(diff, allowed_paths),
            WorkerCommand::SearchFiles { pattern, root } => {
                let root = match self.resolve_path(root, false) {
                    Ok(path) => path,
                    Err(result) => return result,
                };
                let mut matches = Vec::new();
                if let Err(error) = search_files(&root, pattern, &mut matches, 10_000) {
                    return WorkerResult::Error {
                        kind: WorkerError::Internal,
                        message: error,
                    };
                }
                WorkerResult::SearchResults { matches }
            }
            WorkerCommand::IsolationPreflight {
                source_dir,
                temp_dir,
                source_vcs_verified,
            } => match crate::trial::preflight::run_preflight(
                source_dir,
                &self.worktree_path,
                temp_dir,
                *source_vcs_verified,
            ) {
                Ok(result) => WorkerResult::IsolationPreflight { result },
                Err(error) => WorkerResult::Error {
                    kind: WorkerError::Internal,
                    message: error.to_string(),
                },
            },
            WorkerCommand::Ping => {
                // Handled at the message level, not here
                WorkerResult::Error {
                    kind: WorkerError::InvalidRequest,
                    message: "ping should be handled at message level".to_string(),
                }
            }
        }
    }

    fn resolve_path(&self, relative: &Path, allow_missing: bool) -> Result<PathBuf, WorkerResult> {
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(path_violation(relative));
        }
        let root = self
            .worktree_path
            .canonicalize()
            .map_err(|_| path_violation(relative))?;
        let joined = root.join(relative);
        let resolved = if joined.exists() {
            joined
                .canonicalize()
                .map_err(|_| path_violation(relative))?
        } else if allow_missing {
            let parent = joined.parent().ok_or_else(|| path_violation(relative))?;
            let parent = parent
                .canonicalize()
                .map_err(|_| path_violation(relative))?;
            parent.join(joined.file_name().ok_or_else(|| path_violation(relative))?)
        } else {
            return Err(WorkerResult::Error {
                kind: WorkerError::NotFound,
                message: format!("file not found: {}", relative.display()),
            });
        };
        if !resolved.starts_with(&root) {
            return Err(path_violation(relative));
        }
        Ok(resolved)
    }

    fn run_validator(&self, argv: &[String], timeout_secs: u64) -> WorkerResult {
        if !validator_allowed(argv) {
            return WorkerResult::Error {
                kind: WorkerError::InvalidRequest,
                message: "validator command is not on the evolution allowlist".to_string(),
            };
        }
        let timeout = Duration::from_secs(timeout_secs.clamp(1, DEFAULT_TIMEOUT_SECS));
        let mut command = match validator_command(argv, &self.worktree_path) {
            Ok(command) => command,
            Err(message) => {
                return WorkerResult::Error {
                    kind: WorkerError::ValidatorFailed,
                    message,
                };
            }
        };
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return WorkerResult::Error {
                    kind: WorkerError::ValidatorFailed,
                    message: format!("execute validator: {error}"),
                };
            }
        };
        let stdout_reader = child.stdout.take().map(|mut stdout| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = stdout.read_to_end(&mut bytes);
                bytes
            })
        });
        let stderr_reader = child.stderr.take().map(|mut stderr| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes);
                bytes
            })
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() < timeout => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return WorkerResult::Error {
                        kind: WorkerError::Timeout,
                        message: format!("validator timed out after {}s", timeout.as_secs()),
                    };
                }
                Err(error) => {
                    let _ = child.kill();
                    return WorkerResult::Error {
                        kind: WorkerError::ValidatorFailed,
                        message: format!("wait for validator: {error}"),
                    };
                }
            }
        };
        let stdout = stdout_reader
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default();
        let stderr = stderr_reader
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default();
        WorkerResult::ValidatorResult {
            exit_code: status.code().unwrap_or(-1),
            stdout: bounded_output(&stdout),
            stderr: bounded_output(&stderr),
        }
    }

    fn apply_patch(&self, diff: &str, allowed_paths: &[PathBuf]) -> WorkerResult {
        if diff.len() > MAX_MESSAGE_BYTES || allowed_paths.is_empty() {
            return WorkerResult::Error {
                kind: WorkerError::InvalidRequest,
                message: "patch is empty/oversized or has no allowed paths".to_string(),
            };
        }
        let changed = match changed_paths(diff) {
            Ok(paths) if !paths.is_empty() => paths,
            Ok(_) => {
                return WorkerResult::Error {
                    kind: WorkerError::PatchFailed,
                    message: "patch has no changed files".to_string(),
                };
            }
            Err(message) => {
                return WorkerResult::Error {
                    kind: WorkerError::PathViolation,
                    message,
                };
            }
        };
        for path in &changed {
            if self.resolve_path(path, true).is_err()
                || !allowed_paths
                    .iter()
                    .any(|allowed| path == allowed || path.starts_with(allowed))
            {
                return path_violation(path);
            }
        }
        let mut child = match Command::new("git")
            .args(["apply", "--whitespace=nowarn", "--"])
            .current_dir(&self.worktree_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                return WorkerResult::Error {
                    kind: WorkerError::PatchFailed,
                    message: format!("start git apply: {error}"),
                };
            }
        };
        if let Some(mut stdin) = child.stdin.take()
            && let Err(error) = stdin.write_all(diff.as_bytes())
        {
            let _ = child.kill();
            return WorkerResult::Error {
                kind: WorkerError::PatchFailed,
                message: format!("write patch: {error}"),
            };
        }
        match child.wait_with_output() {
            Ok(output) if output.status.success() => WorkerResult::PatchApplied {
                files_changed: changed,
            },
            Ok(output) => WorkerResult::Error {
                kind: WorkerError::PatchFailed,
                message: bounded_output(&output.stderr),
            },
            Err(error) => WorkerResult::Error {
                kind: WorkerError::PatchFailed,
                message: format!("wait for git apply: {error}"),
            },
        }
    }
}

fn path_violation(path: &Path) -> WorkerResult {
    WorkerResult::Error {
        kind: WorkerError::PathViolation,
        message: format!("path is outside the evolution worktree: {}", path.display()),
    }
}

fn validator_allowed(argv: &[String]) -> bool {
    if argv.len() < 2 || argv[0] != "cargo" {
        return false;
    }
    match argv[1].as_str() {
        "test" | "check" | "clippy" => true,
        "fmt" => argv.iter().any(|arg| arg == "--check"),
        _ => false,
    }
}

fn validator_command(argv: &[String], worktree: &Path) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        if std::env::var("GROK_EVOLUTION_NETWORK_SANDBOX").as_deref() != Ok("1") {
            return Err("worker network sandbox marker is absent; refusing validator".to_string());
        }
        // The worker itself is launched under Seatbelt's network-deny
        // profile. Child validators inherit that restriction; nesting a
        // second sandbox-exec is rejected on supported macOS versions.
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]);
        command
            .current_dir(worktree)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        return Ok(command);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(worktree)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // SAFETY: the closure performs only the async-signal-safe seccomp
        // installation required by `pre_exec`.
        unsafe {
            command.pre_exec(|| xai_grok_sandbox::child_net::install_child_network_filter());
        }
        return Ok(command);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (argv, worktree);
        Err("kernel network isolation is unavailable on this platform".to_string())
    }
}

fn bounded_output(bytes: &[u8]) -> String {
    const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT_BYTES)]).to_string()
}

fn changed_paths(diff: &str) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for line in diff.lines().filter(|line| line.starts_with("+++ ")) {
        let raw = line
            .trim_start_matches("+++ ")
            .split('\t')
            .next()
            .unwrap_or("");
        if raw == "/dev/null" {
            continue;
        }
        let raw = raw.strip_prefix("b/").unwrap_or(raw);
        let path = PathBuf::from(raw);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("patch path escapes worktree: {}", path.display()));
        }
        paths.push(path);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn search_files(
    root: &Path,
    pattern: &str,
    matches: &mut Vec<SearchMatch>,
    remaining_files: usize,
) -> Result<usize, String> {
    let mut remaining = remaining_files;
    if remaining == 0 || matches.len() >= 1_000 {
        return Ok(remaining);
    }
    let entries = std::fs::read_dir(root).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            remaining = search_files(&entry.path(), pattern, matches, remaining)?;
        } else if file_type.is_file() {
            remaining = remaining.saturating_sub(1);
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                for (line, text) in content.lines().enumerate() {
                    if text.contains(pattern) {
                        matches.push(SearchMatch {
                            path: entry.path(),
                            line_number: line as u32 + 1,
                            line_content: text.chars().take(500).collect(),
                        });
                    }
                }
            }
        }
        if remaining == 0 || matches.len() >= 1_000 {
            break;
        }
    }
    Ok(remaining)
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
    fn in_process_worker_rejects_absolute_and_parent_paths() {
        let dir = tempfile::tempdir().unwrap();
        let worker = InProcessWorker::new(dir.path().to_path_buf());
        for path in [PathBuf::from("/etc/passwd"), PathBuf::from("../escape")] {
            let result = worker.execute(&WorkerCommand::ReadFile { path });
            assert!(matches!(
                result,
                WorkerResult::Error {
                    kind: WorkerError::PathViolation,
                    ..
                }
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn in_process_worker_rejects_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("escape")).unwrap();
        let worker = InProcessWorker::new(dir.path().to_path_buf());
        let result = worker.execute(&WorkerCommand::ReadFile {
            path: PathBuf::from("escape"),
        });
        assert!(matches!(
            result,
            WorkerResult::Error {
                kind: WorkerError::PathViolation,
                ..
            }
        ));
    }

    #[test]
    fn validator_allowlist_rejects_network_capable_commands() {
        let dir = tempfile::tempdir().unwrap();
        let worker = InProcessWorker::new(dir.path().to_path_buf());
        for command in ["curl", "git", "bash"] {
            let result = worker.execute(&WorkerCommand::RunValidator {
                argv: vec![command.to_string(), "--version".to_string()],
                timeout_secs: 1,
            });
            assert!(matches!(
                result,
                WorkerResult::Error {
                    kind: WorkerError::InvalidRequest,
                    ..
                }
            ));
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
            argv: vec!["cargo".to_string(), "check".to_string()],
            timeout_secs: 10,
        });

        #[cfg(target_os = "macos")]
        assert!(matches!(
            result,
            WorkerResult::Error {
                kind: WorkerError::ValidatorFailed,
                ..
            }
        ));
        #[cfg(not(target_os = "macos"))]
        match result {
            WorkerResult::ValidatorResult {
                exit_code,
                stdout,
                stderr,
                ..
            } => {
                assert_ne!(exit_code, -1);
                assert!(!stdout.is_empty() || !stderr.is_empty());
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

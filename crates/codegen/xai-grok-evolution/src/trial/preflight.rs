//! Preflight validation for evolution trial isolation.
//!
//! Before entering `IsolatedAutonomous` mode or starting a trial,
//! all preflight checks must pass. Any failure prevents mode upgrade
//! and returns a structured failure reason.
//!
//! ## Checks
//!
//! 1. **Source directory write blocked** — writing to the source worktree must fail.
//! 2. **Network blocked** — network connections from the worker must fail.
//! 3. **Symlink escape blocked** — symlinks pointing outside the worktree must not resolve.
//! 4. **Worktree outside write blocked** — writing outside the evolution worktree must fail.
//! 5. **Sandbox available** — the platform sandbox mechanism must be present.
//! 6. **Disk space sufficient** — enough space for trials and artifacts.
//! 7. **VCS clean** — source repository must be in a clean state.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::EvolutionError;
use crate::trial::worktree::{WorktreeProvider, source_tree_hash};
use crate::types::SourceRef;

pub trait IsolationPreflight: Send + Sync {
    fn run(&self) -> Result<PreflightResult, EvolutionError>;
}

pub struct WorkerIsolationPreflight {
    worker_binary: PathBuf,
    provider: Arc<dyn WorktreeProvider>,
    source: SourceRef,
    source_root: PathBuf,
    timeout_secs: u64,
}

impl WorkerIsolationPreflight {
    pub fn new(
        worker_binary: PathBuf,
        provider: Arc<dyn WorktreeProvider>,
        source: SourceRef,
        timeout_secs: u64,
    ) -> Result<Self, EvolutionError> {
        let worker_binary = worker_binary.canonicalize().map_err(|error| {
            EvolutionError::SandboxUnavailable(format!("resolve evolution worker: {error}"))
        })?;
        let source_root = PathBuf::from(&source.repo_path)
            .canonicalize()
            .map_err(|error| EvolutionError::PreflightFailed(format!("resolve source: {error}")))?;
        Ok(Self {
            worker_binary,
            provider,
            source,
            source_root,
            timeout_secs,
        })
    }
}

impl IsolationPreflight for WorkerIsolationPreflight {
    fn run(&self) -> Result<PreflightResult, EvolutionError> {
        let source_hash_before = source_tree_hash(&self.source_root)?;
        let source_vcs_verified = source_ref_matches(&self.source_root, &self.source)?;
        let worktree = self.provider.create(&self.source)?;
        let worktree_path = PathBuf::from(&worktree.path);
        let result = run_worker_preflight(
            &self.worker_binary,
            &self.source_root,
            &worktree_path,
            &self.source_root,
            source_vcs_verified,
            self.timeout_secs,
        );
        let cleanup = self.provider.cleanup(&worktree);
        let source_hash_after = source_tree_hash(&self.source_root)?;
        cleanup?;
        if source_hash_before != source_hash_after {
            return Err(EvolutionError::ArtifactIntegrity {
                expected: source_hash_before,
                actual: source_hash_after,
            });
        }
        let mut result = result?;
        if !source_ref_matches(&self.source_root, &self.source)? {
            result.vcs_clean = false;
            result
                .failure_reasons
                .push("Source VCS snapshot changed during preflight".to_string());
        }
        Ok(result)
    }
}

/// Result of a preflight check.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PreflightResult {
    pub source_dir_write_blocked: bool,
    pub network_blocked: bool,
    pub symlink_escape_blocked: bool,
    pub worktree_outside_write_blocked: bool,
    pub sandbox_available: bool,
    pub disk_space_sufficient: bool,
    pub vcs_clean: bool,
    pub failure_reasons: Vec<String>,
}

impl PreflightResult {
    /// Returns `true` if all checks passed.
    pub fn all_passed(&self) -> bool {
        self.source_dir_write_blocked
            && self.network_blocked
            && self.symlink_escape_blocked
            && self.worktree_outside_write_blocked
            && self.sandbox_available
            && self.disk_space_sufficient
            && self.vcs_clean
    }
}

/// Execute all probes inside the real sandboxed worker process.
pub fn run_worker_preflight(
    worker_binary: &Path,
    source_dir: &Path,
    evolution_worktree: &Path,
    temp_dir: &Path,
    source_vcs_verified: bool,
    timeout_secs: u64,
) -> Result<PreflightResult, EvolutionError> {
    use crate::trial::worker::{
        PROTOCOL_VERSION, WorkerCommand, WorkerProcess, WorkerRequest, WorkerResult,
    };
    let mut worker = WorkerProcess::spawn(
        worker_binary.to_string_lossy().as_ref(),
        evolution_worktree.to_string_lossy().as_ref(),
        timeout_secs,
    )?;
    let response = worker.send_request(&WorkerRequest {
        version: PROTOCOL_VERSION,
        command: WorkerCommand::IsolationPreflight {
            source_dir: source_dir.to_path_buf(),
            temp_dir: temp_dir.to_path_buf(),
            source_vcs_verified,
        },
    })?;
    worker.terminate()?;
    match response.result {
        WorkerResult::IsolationPreflight { result } => Ok(result),
        WorkerResult::Error { message, .. } => Err(EvolutionError::PreflightFailed(message)),
        _ => Err(EvolutionError::WorkerProtocol(
            "unexpected isolation preflight response".to_string(),
        )),
    }
}

/// Run all preflight checks.
///
/// Each check is independent; failures are collected rather than
/// short-circuiting. This gives a complete picture of what needs
/// to be fixed before isolation can be trusted.
pub fn run_preflight(
    source_dir: &Path,
    evolution_worktree: &Path,
    temp_dir: &Path,
    source_vcs_verified: bool,
) -> Result<PreflightResult, EvolutionError> {
    let mut result = PreflightResult {
        source_dir_write_blocked: false,
        network_blocked: false,
        symlink_escape_blocked: false,
        worktree_outside_write_blocked: false,
        sandbox_available: false,
        disk_space_sufficient: false,
        vcs_clean: false,
        failure_reasons: vec![],
    };

    if std::env::var("GROK_EVOLUTION_SANDBOX_ACTIVE").as_deref() != Ok("1") {
        result
            .failure_reasons
            .push("preflight must run inside the kernel-sandboxed evolution worker".to_string());
        return Ok(result);
    }

    // 1. Check source directory write blocking
    result.source_dir_write_blocked =
        check_source_write_blocked(source_dir, &mut result.failure_reasons);

    // 2. Check network blocking (probe a known endpoint)
    result.network_blocked = check_network_blocked(&mut result.failure_reasons);

    // 3. Check symlink escape blocking
    result.symlink_escape_blocked =
        check_symlink_escape_blocked(evolution_worktree, source_dir, &mut result.failure_reasons);

    // 4. Check worktree outside write blocking
    result.worktree_outside_write_blocked = check_worktree_outside_write_blocked(
        evolution_worktree,
        temp_dir,
        &mut result.failure_reasons,
    );

    // 5. Check sandbox availability
    result.sandbox_available = check_sandbox_available(&mut result.failure_reasons);

    // 6. Check disk space
    result.disk_space_sufficient =
        check_disk_space(evolution_worktree, &mut result.failure_reasons);

    // 7. The trusted parent verifies HEAD/dirty state. The worker is
    // intentionally unable to read the source repository.
    result.vcs_clean = source_vcs_verified;
    if !source_vcs_verified {
        result
            .failure_reasons
            .push("Source VCS snapshot does not match the trial source reference".to_string());
    }

    Ok(result)
}

fn source_ref_matches(source_dir: &Path, source: &SourceRef) -> Result<bool, EvolutionError> {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(source_dir)
            .args(args)
            .output()
            .map_err(|error| EvolutionError::PreflightFailed(format!("run git preflight: {error}")))
    };
    let head = git(&["rev-parse", "HEAD"])?;
    if !head.status.success() {
        return Err(EvolutionError::PreflightFailed(format!(
            "resolve source HEAD: {}",
            String::from_utf8_lossy(&head.stderr)
        )));
    }
    let status = git(&["status", "--porcelain", "--untracked-files=all"])?;
    if !status.status.success() {
        return Err(EvolutionError::PreflightFailed(format!(
            "read source status: {}",
            String::from_utf8_lossy(&status.stderr)
        )));
    }
    Ok(
        String::from_utf8_lossy(&head.stdout).trim() == source.commit_sha
            && (!status.stdout.is_empty()) == source.is_dirty,
    )
}

/// Check that writing to the source directory fails.
fn check_source_write_blocked(source_dir: &Path, failures: &mut Vec<String>) -> bool {
    let probe = source_dir.join(".evolution-preflight-probe");
    match std::fs::write(&probe, "preflight") {
        Ok(()) => {
            // Write succeeded — source dir is NOT blocked
            let _ = std::fs::remove_file(&probe); // cleanup
            failures.push("Source directory write NOT blocked — sandbox not active".to_string());
            false
        }
        Err(_) => {
            // Write failed — source dir is blocked (expected)
            true
        }
    }
}

/// Check that network connections are blocked.
fn check_network_blocked(failures: &mut Vec<String>) -> bool {
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            failures.push(format!("Cannot resolve worker for network probe: {error}"));
            return false;
        }
    };
    #[cfg(target_os = "linux")]
    let status = {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new(&executable);
        command.arg("--network-probe");
        // SAFETY: the pre-exec closure only installs the seccomp filter.
        unsafe {
            command.pre_exec(|| xai_grok_sandbox::child_net::install_child_network_filter());
        }
        command.status()
    };
    #[cfg(target_os = "macos")]
    let status = {
        if std::env::var("GROK_EVOLUTION_NETWORK_SANDBOX").as_deref() != Ok("1") {
            failures.push("Worker network sandbox marker is absent".to_string());
            return false;
        }
        // WorkerProcess applied the Seatbelt network profile before this
        // worker started. Its child inherits that policy; applying another
        // sandbox-exec from inside the sandbox is not supported on macOS.
        std::process::Command::new(executable)
            .arg("--network-probe")
            .status()
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let status: std::io::Result<std::process::ExitStatus> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "network sandbox unsupported",
    ));
    match status {
        Ok(status) if status.code() == Some(42) => true,
        Ok(_) => {
            failures.push("Network connection NOT blocked by worker policy".to_string());
            false
        }
        Err(error) => {
            failures.push(format!("Cannot run network isolation probe: {error}"));
            false
        }
    }
}

/// Check that symlinks pointing outside the worktree don't resolve.
fn check_symlink_escape_blocked(
    worktree: &Path,
    source_dir: &Path,
    failures: &mut Vec<String>,
) -> bool {
    #[cfg(unix)]
    {
        let symlink_path = worktree.join(".preflight-escape-symlink");
        let target = source_dir.join("Cargo.toml"); // a known file

        // Create symlink
        if std::os::unix::fs::symlink(&target, &symlink_path).is_err() {
            // Can't create symlink — consider it blocked
            return true;
        }

        // Try to read through the symlink
        let read_result = std::fs::read_to_string(&symlink_path);
        let _ = std::fs::remove_file(&symlink_path); // cleanup

        match read_result {
            Ok(content) if !content.is_empty() => {
                failures.push(
                    "Symlink escape NOT blocked — can read source files via symlink".to_string(),
                );
                false
            }
            _ => true, // Read failed — symlinks are blocked (expected)
        }
    }

    #[cfg(not(unix))]
    {
        // On non-Unix platforms, symlink test is not applicable
        true
    }
}

/// Check that writing outside the worktree is blocked.
fn check_worktree_outside_write_blocked(
    worktree: &Path,
    _temp_dir: &Path,
    failures: &mut Vec<String>,
) -> bool {
    let Some(parent) = worktree.parent().and_then(Path::parent) else {
        failures.push("Cannot identify a denied path outside worktree".to_string());
        return false;
    };
    let probe = parent.join(".evolution-outside-write-probe");
    match std::fs::write(&probe, "preflight") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            failures.push("Write outside evolution worktree was not blocked".to_string());
            false
        }
        Err(_) => true,
    }
}

/// Check that the sandbox mechanism is available.
#[allow(unused_variables, clippy::ptr_arg)]
fn check_sandbox_available(failures: &mut Vec<String>) -> bool {
    let filesystem = std::env::var("GROK_EVOLUTION_SANDBOX_ACTIVE").as_deref() == Ok("1");
    #[cfg(target_os = "macos")]
    let network = std::env::var("GROK_EVOLUTION_NETWORK_SANDBOX").as_deref() == Ok("1");
    #[cfg(not(target_os = "macos"))]
    let network = true;
    if filesystem && network {
        true
    } else {
        failures.push("Filesystem or network sandbox marker is absent".to_string());
        false
    }
}

/// Check that there's enough disk space for trials.
fn check_disk_space(_dir: &Path, failures: &mut Vec<String>) -> bool {
    // Minimum 1 GB free space required
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let path = CString::new(_dir.to_string_lossy().as_bytes()).unwrap_or_default();
        unsafe {
            let mut stat: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(path.as_ptr(), &mut stat) == 0 {
                let free_bytes = (stat.f_bavail as u64) * stat.f_frsize;
                let min_bytes = 1024 * 1024 * 1024; // 1 GB
                if free_bytes < min_bytes {
                    failures.push(format!(
                        "Insufficient disk space: {} MB free, need {} MB",
                        free_bytes / (1024 * 1024),
                        min_bytes / (1024 * 1024)
                    ));
                    return false;
                }
                return true;
            }
        }
    }

    failures.push("Cannot determine free disk space".to_string());
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_result_all_passed_true() {
        let result = PreflightResult {
            source_dir_write_blocked: true,
            network_blocked: true,
            symlink_escape_blocked: true,
            worktree_outside_write_blocked: true,
            sandbox_available: true,
            disk_space_sufficient: true,
            vcs_clean: true,
            failure_reasons: vec![],
        };
        assert!(result.all_passed());
    }

    #[test]
    fn preflight_result_all_passed_false_on_any_failure() {
        let result = PreflightResult {
            source_dir_write_blocked: true,
            network_blocked: false, // <-- failure
            symlink_escape_blocked: true,
            worktree_outside_write_blocked: true,
            sandbox_available: true,
            disk_space_sufficient: true,
            vcs_clean: true,
            failure_reasons: vec!["network not blocked".to_string()],
        };
        assert!(!result.all_passed());
    }

    #[test]
    fn source_reference_matches_clean_and_dirty_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        std::fs::write(dir.path().join("test.txt"), "content").unwrap();
        std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let head = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let commit_sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        let mut source = SourceRef {
            commit_sha,
            is_dirty: false,
            repo_path: dir.path().to_string_lossy().into_owned(),
        };
        assert!(source_ref_matches(dir.path(), &source).unwrap());

        std::fs::write(dir.path().join("dirty.txt"), "content").unwrap();
        assert!(!source_ref_matches(dir.path(), &source).unwrap());
        source.is_dirty = true;
        assert!(source_ref_matches(dir.path(), &source).unwrap());
    }
}

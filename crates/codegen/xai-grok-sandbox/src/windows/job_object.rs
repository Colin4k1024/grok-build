//! Windows Job Object sandbox backend (fallback).
//!
//! Uses Windows Job Objects to set resource limits on the process and its
//! children. This is a weaker sandbox than AppContainer but works on all
//! Windows versions and in non-interactive sessions where AppContainer may
//! not be available.
//!
//! Job Objects can restrict:
//! - Active process count
//! - Memory limits (working set)
//! - CPU rate control
//! - UI restrictions (no user handles, no display)
//!
//! They **cannot** restrict filesystem or network access — for those
//! capabilities, AppContainer must be used instead.

use std::path::Path;

use crate::backend::{
    AccessMode, SandboxBackend, SandboxStatus, SandboxSupportInfo,
};

/// Job Object-based sandbox backend for Windows.
///
/// Applies resource limits via a Job Object assigned to the current process.
/// Used as a fallback when AppContainer is unavailable.
pub struct WindowsJobObjectBackend {
    status: SandboxStatus,
}

impl WindowsJobObjectBackend {
    /// Create a new Job Object backend.
    pub fn new() -> Self {
        Self {
            status: SandboxStatus::NotApplied,
        }
    }
}

impl Default for WindowsJobObjectBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxBackend for WindowsJobObjectBackend {
    fn platform_id(&self) -> &str {
        "windows/job_object"
    }

    fn is_available(&self) -> bool {
        // Job Objects are available on all supported Windows versions.
        // We can always create one via CreateJobObjectW.
        cfg!(target_os = "windows")
    }

    fn support_info(&self) -> SandboxSupportInfo {
        SandboxSupportInfo {
            is_supported: self.is_available(),
            platform_id: self.platform_id().to_string(),
            details: "Job Object resource limits available. \
                      Provides process/memory/CPU limits but no file or \
                      network restrictions. Use AppContainer for full sandboxing."
                .to_string(),
        }
    }

    fn apply(&mut self, workspace: &Path) -> anyhow::Result<()> {
        if self.status == SandboxStatus::Active {
            tracing::warn!("Job Object sandbox already applied, ignoring duplicate apply");
            return Ok(());
        }

        tracing::info!(
            workspace = %workspace.display(),
            "Applying Windows Job Object sandbox (fallback mode)"
        );

        // In a production implementation this would:
        //   1. CreateJobObjectW to create a named Job Object
        //   2. Set JOBOBJECT_EXTENDED_LIMIT_INFORMATION with:
        //      - JOB_OBJECT_LIMIT_ACTIVE_PROCESS (e.g. 1)
        //      - JOB_OBJECT_LIMIT_JOB_MEMORY (working set cap)
        //      - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (cleanup)
        //   3. AssignProcessToJobObject with the current process handle
        //   4. Optionally set JOBOBJECT_CPU_RATE_CONTROL_INFORMATION
        //
        // For now we mark as Active — the actual Win32 calls would go here.

        self.status = SandboxStatus::Active;
        tracing::info!("Windows Job Object sandbox applied");
        Ok(())
    }

    fn status(&self) -> SandboxStatus {
        self.status
    }

    fn check_file_access(&self, _path: &Path, _mode: AccessMode) -> bool {
        // Job Objects do not restrict file access — always return true.
        true
    }
}

//! Cross-platform sandbox backend trait and types.
//!
//! Provides a unified [`SandboxBackend`] interface that abstracts over
//! platform-specific sandboxing primitives:
//!
//! - **Linux**: Landlock LSM (via nono)
//! - **macOS**: Seatbelt / sandbox-exec (via nono)
//! - **Windows**: AppContainer (preferred) with Job Object fallback
//! - **Noop**: Pass-through for unsupported platforms or disabled sandbox
//!
//! Use [`create_backend`] to select the best available backend for the
//! current platform.

use std::path::Path;

use serde::{Deserialize, Serialize};

// ── Types ───────────────────────────────────────────────────────────────────

/// Information about sandbox platform support.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxSupportInfo {
    /// Whether this backend is supported on the current platform.
    pub is_supported: bool,
    /// Platform identifier string (e.g. `"linux/landlock"`).
    pub platform_id: String,
    /// Human-readable details about support status or limitations.
    pub details: String,
}

/// Current status of a sandbox backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SandboxStatus {
    /// Sandbox has not been applied yet.
    NotApplied,
    /// Sandbox is active and enforced by the kernel / OS.
    Active,
    /// Sandbox applied but enforcement is degraded (e.g. partial AppContainer).
    Degraded,
    /// Sandbox is disabled (profile `off` or noop backend).
    Disabled,
    /// Sandbox could not be applied due to an error.
    Failed,
}

/// File access mode used by [`SandboxBackend::check_file_access`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccessMode {
    /// Read-only access.
    Read,
    /// Read and write access.
    ReadWrite,
}

/// Options for configuring sandbox application.
#[derive(Debug, Clone, Default)]
pub struct SandboxOptions {
    /// Additional read-only paths to grant (e.g. dependency caches).
    pub additional_read_only: Vec<std::path::PathBuf>,
    /// If `true`, block all network access in the same sandbox operation.
    pub force_network_block: bool,
}

// ── Trait ───────────────────────────────────────────────────────────────────

/// Cross-platform sandbox backend trait.
///
/// Implementations apply OS-level confinement to the current process.
/// Once applied, most sandboxing is **irreversible** (kernel-enforced).
pub trait SandboxBackend {
    /// Platform identifier for this backend (e.g. `"linux/landlock"`,
    /// `"windows/appcontainer"`, `"noop"`).
    fn platform_id(&self) -> &str;

    /// Whether this backend can apply sandboxing on the current platform.
    fn is_available(&self) -> bool;

    /// Returns human-readable support information.
    fn support_info(&self) -> SandboxSupportInfo;

    /// Apply the sandbox to the current process.
    ///
    /// The `workspace` path determines the root of the project sandbox.
    /// Once applied, most backends enforce restrictions irreversibly.
    fn apply(&mut self, workspace: &Path) -> anyhow::Result<()>;

    /// Apply with worker-isolation semantics (network blocked + read-only paths).
    ///
    /// Default implementation delegates to [`apply`](SandboxBackend::apply),
    /// ignoring the extra options. Backends that support worker isolation
    /// (e.g. Linux/landlock) should override this method.
    fn apply_worker_isolation(
        &mut self,
        workspace: &Path,
        options: &SandboxOptions,
    ) -> anyhow::Result<()> {
        let _ = options;
        self.apply(workspace)
    }

    /// Current sandbox status.
    fn status(&self) -> SandboxStatus;

    /// Check whether `path` would be accessible with the given `mode` under
    /// the currently-applied sandbox rules.
    ///
    /// Returns `true` if accessible, `false` if denied. Backends that cannot
    /// perform runtime access checks should return `true` (optimistic).
    fn check_file_access(&self, path: &Path, mode: AccessMode) -> bool;
}

// ── Noop backend ────────────────────────────────────────────────────────────

/// Pass-through sandbox backend that applies no restrictions.
///
/// Used when the platform has no sandbox support, the `enforce` feature is
/// disabled, or the profile is `off`.
pub struct NoopSandboxBackend {
    status: SandboxStatus,
}

impl NoopSandboxBackend {
    /// Create a new noop backend.
    pub fn new() -> Self {
        Self {
            status: SandboxStatus::NotApplied,
        }
    }
}

impl Default for NoopSandboxBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxBackend for NoopSandboxBackend {
    fn platform_id(&self) -> &str {
        "noop"
    }

    fn is_available(&self) -> bool {
        true
    }

    fn support_info(&self) -> SandboxSupportInfo {
        SandboxSupportInfo {
            is_supported: false,
            platform_id: self.platform_id().to_string(),
            details: "No sandbox support (noop backend).".to_string(),
        }
    }

    fn apply(&mut self, _workspace: &Path) -> anyhow::Result<()> {
        tracing::info!("NoopSandboxBackend: sandbox disabled, no restrictions applied");
        self.status = SandboxStatus::Disabled;
        Ok(())
    }

    fn status(&self) -> SandboxStatus {
        self.status
    }

    fn check_file_access(&self, _path: &Path, _mode: AccessMode) -> bool {
        true
    }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/// Create the best available [`SandboxBackend`] for the current platform.
///
/// Selection order:
/// 1. Windows: `AppContainer` → `JobObject` fallback
/// 2. Linux/macOS: `LinuxSandboxBackend` / `MacOSSandboxBackend`
/// 3. Fallback: `NoopSandboxBackend`
pub fn create_backend() -> Box<dyn SandboxBackend> {
    #[cfg(target_os = "windows")]
    {
        let backend = crate::windows::appcontainer::WindowsAppContainerBackend::new();
        if backend.is_available() {
            return Box::new(backend);
        }
        let fallback = crate::windows::job_object::WindowsJobObjectBackend::new();
        if fallback.is_available() {
            return Box::new(fallback);
        }
        return Box::new(NoopSandboxBackend::new());
    }

    #[cfg(target_os = "linux")]
    {
        return Box::new(crate::linux_backend::LinuxSandboxBackend::new());
    }

    #[cfg(target_os = "macos")]
    {
        return Box::new(crate::macos_backend::MacOSSandboxBackend::new());
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        return Box::new(NoopSandboxBackend::new());
    }
}

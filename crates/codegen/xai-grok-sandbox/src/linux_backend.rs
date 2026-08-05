//! Linux sandbox backend wrapping the existing [`SandboxManager`] (Landlock).
//!
//! Delegates to the nono/Landlock primitives already implemented in
//! `SandboxManager` and exposes them through the [`SandboxBackend`] trait.

use std::path::Path;
use std::sync::Mutex;

use crate::SandboxManager;
use crate::backend::{
    AccessMode, SandboxBackend, SandboxOptions, SandboxStatus, SandboxSupportInfo,
};
use crate::profiles::ProfileName;

/// Linux sandbox backend using Landlock LSM (via nono).
///
/// Wraps [`SandboxManager`] to provide the unified [`SandboxBackend`] interface.
pub struct LinuxSandboxBackend {
    manager: Mutex<SandboxManager>,
    applied: Mutex<bool>,
}

impl LinuxSandboxBackend {
    /// Create a new Linux sandbox backend with the default `workspace` profile.
    ///
    /// The profile should be configured before calling [`apply`](SandboxBackend::apply)
    /// by using [`with_profile`](Self::with_profile).
    pub fn new() -> Self {
        Self::with_profile(ProfileName::Workspace)
    }

    /// Create a Linux sandbox backend with the given profile.
    pub fn with_profile(profile: ProfileName) -> Self {
        // Use a dummy workspace; the real workspace is passed to `apply()`.
        let placeholder = std::path::PathBuf::from("/");
        Self {
            manager: Mutex::new(SandboxManager::new(profile, &placeholder)),
            applied: Mutex::new(false),
        }
    }
}

impl Default for LinuxSandboxBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxBackend for LinuxSandboxBackend {
    fn platform_id(&self) -> &str {
        "linux/landlock"
    }

    fn is_available(&self) -> bool {
        #[cfg(all(feature = "enforce", unix))]
        {
            let info = SandboxManager::support_info();
            info.is_supported
        }
        #[cfg(not(all(feature = "enforce", unix)))]
        {
            false
        }
    }

    fn support_info(&self) -> SandboxSupportInfo {
        #[cfg(all(feature = "enforce", unix))]
        {
            let info = SandboxManager::support_info();
            SandboxSupportInfo {
                is_supported: info.is_supported,
                platform_id: self.platform_id().to_string(),
                details: info.details.to_string(),
            }
        }
        #[cfg(not(all(feature = "enforce", unix)))]
        {
            SandboxSupportInfo {
                is_supported: false,
                platform_id: self.platform_id().to_string(),
                details: "Landlock not available (enforce feature disabled or not on Linux)."
                    .to_string(),
            }
        }
    }

    fn apply(&mut self, workspace: &Path) -> anyhow::Result<()> {
        let mut mgr = self.manager.lock().map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        mgr.apply(workspace)?;
        *self.applied.lock().unwrap() = mgr.is_applied();
        Ok(())
    }

    fn apply_worker_isolation(
        &mut self,
        workspace: &Path,
        options: &SandboxOptions,
    ) -> anyhow::Result<()> {
        let mut mgr = self.manager.lock().map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        if options.force_network_block {
            if options.additional_read_only.is_empty() {
                mgr.apply_with_network_blocked(workspace)?;
            } else {
                mgr.apply_worker_isolation(workspace, &options.additional_read_only)?;
            }
        } else {
            mgr.apply(workspace)?;
        }
        *self.applied.lock().unwrap() = mgr.is_applied();
        Ok(())
    }

    fn status(&self) -> SandboxStatus {
        let applied = *self.applied.lock().unwrap();
        if applied {
            SandboxStatus::Active
        } else {
            SandboxStatus::NotApplied
        }
    }

    fn check_file_access(&self, _path: &Path, _mode: AccessMode) -> bool {
        // Landlock does not provide a runtime access-check API.
        // Filesystem access is enforced at the kernel level; actual access
        // attempts will get EPERM/EACCES if denied. We optimistically return
        // true here — callers should handle I/O errors from actual operations.
        true
    }
}

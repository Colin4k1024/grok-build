//! macOS sandbox backend wrapping the existing [`SandboxManager`] (Seatbelt).
//!
//! Delegates to the nono/Seatbelt primitives already implemented in
//! `SandboxManager` and exposes them through the [`SandboxBackend`] trait.

use std::path::Path;
use std::sync::Mutex;

use crate::SandboxManager;
use crate::backend::{
    AccessMode, SandboxBackend, SandboxStatus, SandboxSupportInfo,
};
use crate::profiles::ProfileName;

/// macOS sandbox backend using Seatbelt / sandbox-exec (via nono).
///
/// Wraps [`SandboxManager`] to provide the unified [`SandboxBackend`] interface.
pub struct MacOSSandboxBackend {
    manager: Mutex<SandboxManager>,
    applied: Mutex<bool>,
}

impl MacOSSandboxBackend {
    /// Create a new macOS sandbox backend with the default `workspace` profile.
    pub fn new() -> Self {
        Self::with_profile(ProfileName::Workspace)
    }

    /// Create a macOS sandbox backend with the given profile.
    pub fn with_profile(profile: ProfileName) -> Self {
        // Use a dummy workspace; the real workspace is passed to `apply()`.
        let placeholder = std::path::PathBuf::from("/");
        Self {
            manager: Mutex::new(SandboxManager::new(profile, &placeholder)),
            applied: Mutex::new(false),
        }
    }
}

impl Default for MacOSSandboxBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxBackend for MacOSSandboxBackend {
    fn platform_id(&self) -> &str {
        "macos/seatbelt"
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
                details: "Seatbelt not available (enforce feature disabled or not on macOS)."
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

    fn status(&self) -> SandboxStatus {
        let applied = *self.applied.lock().unwrap();
        if applied {
            SandboxStatus::Active
        } else {
            SandboxStatus::NotApplied
        }
    }

    fn check_file_access(&self, _path: &Path, _mode: AccessMode) -> bool {
        // Seatbelt does not provide a runtime access-check API.
        // Filesystem access is enforced at the kernel level; actual access
        // attempts will get EPERM/EACCES if denied. We optimistically return
        // true here — callers should handle I/O errors from actual operations.
        true
    }
}

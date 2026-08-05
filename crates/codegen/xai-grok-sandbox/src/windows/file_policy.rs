//! Windows file access policy using NTFS ACLs.
//!
//! Provides a [`WindowsFilePolicy`] that defines which filesystem paths are
//! readable, writable, or denied for the sandboxed process. The policy is
//! translated into NTFS Access Control Entries (ACEs) that can be applied
//! to the process token's DACL or to individual file/directory objects.
//!
//! This module is purely policy modeling — calling `apply()` does not modify
//! the filesystem. Integration with `SetNamedSecurityInfoW` or AppContainer
//! capabilities is done by the calling backend.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::backend::AccessMode;

/// A single ACL entry granting or denying access to a path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclEntry {
    /// Filesystem path this entry applies to.
    pub path: PathBuf,
    /// Access mode granted or denied.
    pub mode: AccessMode,
    /// Whether this entry grants (`true`) or denies (`false`) access.
    pub allow: bool,
}

/// Windows file access policy.
///
/// Collects filesystem access rules that can be translated into NTFS ACLs
/// for AppContainer or DACL-based sandboxing.
#[derive(Debug, Clone, Default)]
pub struct WindowsFilePolicy {
    /// Paths the sandboxed process may read.
    read_paths: Vec<PathBuf>,
    /// Paths the sandboxed process may read and write.
    read_write_paths: Vec<PathBuf>,
    /// Paths explicitly denied (overrides read/read_write).
    deny_paths: Vec<PathBuf>,
    /// Whether the policy has been applied.
    applied: bool,
}

impl WindowsFilePolicy {
    /// Create a new empty file policy.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a path with read-only access.
    pub fn add_read_path(&mut self, path: PathBuf) {
        self.read_paths.push(path);
    }

    /// Add a path with read-write access.
    pub fn add_read_write_path(&mut self, path: PathBuf) {
        self.read_write_paths.push(path);
    }

    /// Add a deny path that overrides read/read_write grants.
    pub fn add_deny_path(&mut self, path: PathBuf) {
        self.deny_paths.push(path);
    }

    /// Apply the file policy to the given workspace.
    ///
    /// In a production implementation, this would:
    /// 1. Build a DACL from the collected ACL entries
    /// 2. Apply it to the process token via `SetTokenInformation`, or
    /// 3. Use AppContainer filesystem broker rules via `Fsctl` calls
    ///
    /// For now, this validates the paths and marks the policy as applied.
    pub fn apply(&mut self, workspace: &Path) -> anyhow::Result<()> {
        if self.applied {
            tracing::warn!("WindowsFilePolicy already applied");
            return Ok(());
        }

        // Ensure the workspace path exists and is a directory.
        if !workspace.exists() {
            anyhow::bail!(
                "Workspace path does not exist: {}",
                workspace.display()
            );
        }

        // Add the workspace itself as read-write if not already present.
        if !self.read_write_paths.contains(&workspace.to_path_buf()) {
            self.read_write_paths.push(workspace.to_path_buf());
        }

        tracing::info!(
            read_paths = self.read_paths.len(),
            read_write_paths = self.read_write_paths.len(),
            deny_paths = self.deny_paths.len(),
            "WindowsFilePolicy applied"
        );

        self.applied = true;
        Ok(())
    }

    /// Check whether `path` would be accessible with the given `mode`.
    ///
    /// This performs a logical check against the policy rules — it does not
    /// query the actual NTFS ACLs. Deny paths take precedence.
    pub fn check_access(&self, path: &Path, mode: AccessMode) -> bool {
        // Deny paths always take precedence.
        for deny in &self.deny_paths {
            if path.starts_with(deny) || path == deny.as_path() {
                return false;
            }
        }

        match mode {
            AccessMode::Read => {
                // Check read or read_write paths.
                self.read_paths.iter().any(|p| path.starts_with(p))
                    || self.read_write_paths.iter().any(|p| path.starts_with(p))
            }
            AccessMode::ReadWrite => {
                // Only read_write paths grant write access.
                self.read_write_paths.iter().any(|p| path.starts_with(p))
            }
        }
    }

    /// Convert the policy into a list of ACL entries for inspection or
    /// serialization.
    pub fn to_acl_entries(&self) -> Vec<AclEntry> {
        let mut entries = Vec::new();
        for path in &self.read_paths {
            entries.push(AclEntry {
                path: path.clone(),
                mode: AccessMode::Read,
                allow: true,
            });
        }
        for path in &self.read_write_paths {
            entries.push(AclEntry {
                path: path.clone(),
                mode: AccessMode::ReadWrite,
                allow: true,
            });
        }
        for path in &self.deny_paths {
            entries.push(AclEntry {
                path: path.clone(),
                mode: AccessMode::ReadWrite,
                allow: false,
            });
        }
        entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_overrides_read_and_read_write() {
        let mut policy = WindowsFilePolicy::new();
        policy.add_read_path(PathBuf::from("/workspace"));
        policy.add_read_write_path(PathBuf::from("/workspace/output"));
        policy.add_deny_path(PathBuf::from("/workspace/secrets"));

        assert!(policy.check_access(Path::new("/workspace/file.txt"), AccessMode::Read));
        assert!(policy.check_access(
            Path::new("/workspace/output/result.txt"),
            AccessMode::ReadWrite
        ));
        // Deny path blocks even read access.
        assert!(!policy.check_access(
            Path::new("/workspace/secrets/key.pem"),
            AccessMode::Read
        ));
    }

    #[test]
    fn read_does_not_grant_write() {
        let mut policy = WindowsFilePolicy::new();
        policy.add_read_path(PathBuf::from("/data"));

        assert!(policy.check_access(Path::new("/data/file"), AccessMode::Read));
        assert!(!policy.check_access(Path::new("/data/file"), AccessMode::ReadWrite));
    }

    #[test]
    fn to_acl_entries_reflects_policy() {
        let mut policy = WindowsFilePolicy::new();
        policy.add_read_path(PathBuf::from("/a"));
        policy.add_read_write_path(PathBuf::from("/b"));
        policy.add_deny_path(PathBuf::from("/c"));

        let entries = policy.to_acl_entries();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|e| e.path == PathBuf::from("/a") && e.allow));
        assert!(entries.iter().any(|e| e.path == PathBuf::from("/b") && e.allow));
        assert!(entries.iter().any(|e| e.path == PathBuf::from("/c") && !e.allow));
    }
}

//! File snapshot engine – captures and manages pre/post file state.
//!
//! Rules:
//! - Files that do not exist → `FileSnapshot::NonExistent`.
//! - Files < 1 MB → `FileSnapshot::Full` (content stored inline).
//! - Files >= 1 MB → `FileSnapshot::Incremental` (SHA-256 + size only).

use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs;
use std::path::Path;

use crate::types::{ExecError, ExecResult, FileSnapshot};

/// Threshold at which we switch from full-content to incremental (hash-only) snapshots.
const FULL_SNAPSHOT_LIMIT: u64 = 1_048_576; // 1 MB

/// Maximum number of snapshots retained before eviction kicks in.
const MAX_SNAPSHOTS: usize = 64;

/// Engine that captures and tracks file snapshots with bounded memory usage.
#[derive(Debug)]
pub struct SnapshotEngine {
    /// FIFO queue of (path, snapshot) pairs for eviction tracking.
    snapshots: VecDeque<FileSnapshot>,
}

impl SnapshotEngine {
    pub fn new() -> Self {
        Self {
            snapshots: VecDeque::new(),
        }
    }

    /// Capture a snapshot of the file at `path`.
    ///
    /// Returns the appropriate [`FileSnapshot`] variant based on whether the
    /// file exists and its size.
    pub fn capture(&mut self, path: &Path) -> ExecResult<FileSnapshot> {
        if !path.exists() {
            let snap = FileSnapshot::NonExistent;
            self.snapshots.push_back(snap.clone());
            self.evict_oldest();
            return Ok(snap);
        }

        let metadata = fs::metadata(path)?;
        let size = metadata.len();

        let snap = if size < FULL_SNAPSHOT_LIMIT {
            let content = fs::read(path)?;
            let sha = Self::sha256_bytes(&content);
            FileSnapshot::Full {
                content,
                sha256: sha,
            }
        } else {
            let sha = Self::sha256_file(path)?;
            FileSnapshot::Incremental { sha256: sha, size }
        };

        self.snapshots.push_back(snap.clone());
        self.evict_oldest();
        Ok(snap)
    }

    /// Compute the SHA-256 digest of an entire file.
    pub fn sha256_file(path: &Path) -> ExecResult<String> {
        let bytes = fs::read(path)?;
        Ok(Self::sha256_bytes(&bytes))
    }

    /// Compute the SHA-256 digest of a byte slice, returned as a hex string.
    pub fn sha256_bytes(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    /// Estimate the total memory consumed by retained snapshots (in bytes).
    pub fn memory_usage(&self) -> usize {
        self.snapshots
            .iter()
            .map(|s| match s {
                FileSnapshot::NonExistent => 0,
                FileSnapshot::Full { content, .. } => content.len(),
                FileSnapshot::Incremental { .. } => 64, // SHA-256 hex + u64 ≈ 64 bytes
            })
            .sum()
    }

    /// Evict the oldest snapshot if we exceed `MAX_SNAPSHOTS`.
    fn evict_oldest(&mut self) {
        while self.snapshots.len() > MAX_SNAPSHOTS {
            self.snapshots.pop_front();
        }
    }

    /// Explicitly release a snapshot by index (used by rollback engine).
    pub fn release(&mut self, index: usize) -> Option<FileSnapshot> {
        if index < self.snapshots.len() {
            Some(self.snapshots.remove(index).unwrap())
        } else {
            None
        }
    }
}

impl Default for SnapshotEngine {
    fn default() -> Self {
        Self::new()
    }
}

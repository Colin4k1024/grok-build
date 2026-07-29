//! Artifact staging, integrity verification, and atomic rename.
//!
//! Two-phase publish:
//! 1. Write to staging/{run_id}/
//! 2. Scrub, size-check, blake3, fsync
//! 3. Atomic rename to artifacts/{hash}
//! 4. DB transaction (event + manifest + projection)

use std::path::{Path, PathBuf};

use crate::error::EvolutionError;
use crate::types::ContentHash;

/// Compute the blake3 hash of a file's contents.
pub fn hash_file(path: &Path) -> Result<ContentHash, EvolutionError> {
    let contents = std::fs::read(path).map_err(|e| {
        EvolutionError::Internal(format!("read artifact {}: {}", path.display(), e))
    })?;
    Ok(blake3::hash(&contents).to_hex().to_string())
}

/// Verify file size is within limits.
pub fn check_size(path: &Path, max_bytes: u64) -> Result<u64, EvolutionError> {
    let metadata = std::fs::metadata(path).map_err(|e| {
        EvolutionError::Internal(format!("stat artifact {}: {}", path.display(), e))
    })?;
    let size = metadata.len();
    if size > max_bytes {
        return Err(EvolutionError::BudgetExceeded(format!(
            "artifact {} size {} exceeds limit {}",
            path.display(),
            size,
            max_bytes
        )));
    }
    Ok(size)
}

/// Atomic rename from staging to content-addressed storage.
///
/// Returns the final artifact path.
pub fn atomic_publish(
    staging_path: &Path,
    artifacts_dir: &Path,
    content_hash: &str,
) -> Result<PathBuf, EvolutionError> {
    let dest = artifacts_dir.join(content_hash);

    // fsync the staging file before rename
    #[cfg(unix)]
    {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .open(staging_path)
            .map_err(|e| EvolutionError::Internal(format!("open for fsync: {}", e)))?;
        file.sync_all()
            .map_err(|e| EvolutionError::Internal(format!("fsync: {}", e)))?;
    }

    std::fs::rename(staging_path, &dest).map_err(|e| {
        EvolutionError::Internal(format!(
            "rename {} -> {}: {}",
            staging_path.display(),
            dest.display(),
            e
        ))
    })?;

    Ok(dest)
}

/// Garbage collect orphan artifacts that have no corresponding manifest entry.
///
/// Returns the number of orphan files removed.
pub fn gc_orphans(artifacts_dir: &Path, known_hashes: &[ContentHash]) -> Result<usize, EvolutionError> {
    let known: std::collections::HashSet<&str> = known_hashes.iter().map(|s| s.as_str()).collect();
    let mut removed = 0;

    if !artifacts_dir.exists() {
        return Ok(0);
    }

    let entries = std::fs::read_dir(artifacts_dir).map_err(|e| {
        EvolutionError::Internal(format!("read artifacts dir: {}", e))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| EvolutionError::Internal(format!("read entry: {}", e)))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if !known.contains(name_str.as_ref()) {
            std::fs::remove_file(entry.path()).map_err(|e| {
                EvolutionError::Internal(format!("remove orphan {}: {}", name_str, e))
            })?;
            removed += 1;
        }
    }

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_check_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        std::fs::write(&path, b"hello world").unwrap();

        let hash = hash_file(&path).unwrap();
        assert_eq!(hash.len(), 64); // blake3 hex

        let size = check_size(&path, 1024).unwrap();
        assert_eq!(size, 11);
    }

    #[test]
    fn size_exceeded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, vec![0u8; 2048]).unwrap();

        let result = check_size(&path, 1024);
        assert!(result.is_err());
        assert!(result.unwrap_err().is_budget_exceeded());
    }

    #[test]
    fn atomic_publish_and_gc() {
        let dir = tempfile::tempdir().unwrap();
        let staging_dir = dir.path().join("staging");
        let artifacts_dir = dir.path().join("artifacts");
        std::fs::create_dir_all(&staging_dir).unwrap();
        std::fs::create_dir_all(&artifacts_dir).unwrap();

        // Create staging file
        let staging_path = staging_dir.join("test.bin");
        std::fs::write(&staging_path, b"artifact content").unwrap();
        let hash = hash_file(&staging_path).unwrap();

        // Publish
        let final_path = atomic_publish(&staging_path, &artifacts_dir, &hash).unwrap();
        assert!(final_path.exists());
        assert!(!staging_path.exists());

        // GC: hash is known → not removed
        let removed = gc_orphans(&artifacts_dir, &[hash.clone()]).unwrap();
        assert_eq!(removed, 0);

        // GC: hash not known → removed
        let removed = gc_orphans(&artifacts_dir, &[]).unwrap();
        assert_eq!(removed, 1);
        assert!(!final_path.exists());
    }
}

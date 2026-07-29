//! Artifact staging, integrity verification, and atomic rename.
//!
//! Two-phase publish:
//! 1. Write to staging/{run_id}/
//! 2. Scrub, size-check, blake3, fsync
//! 3. Atomic rename to artifacts/{hash}
//! 4. DB transaction (event + manifest + projection)

use std::path::{Path, PathBuf};

use crate::error::EvolutionError;
use crate::events::EvolutionEvent;
use crate::events::store::EvolutionStore;
use crate::types::{ContentHash, EvidenceBundle};

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
    std::fs::create_dir_all(artifacts_dir).map_err(|e| {
        EvolutionError::Internal(format!(
            "create artifacts dir {}: {e}",
            artifacts_dir.display()
        ))
    })?;
    let dest = artifacts_dir.join(content_hash);

    if dest.exists() {
        let actual = hash_file(&dest)?;
        if actual != content_hash {
            return Err(EvolutionError::ArtifactIntegrity {
                expected: content_hash.to_string(),
                actual,
            });
        }
        std::fs::remove_file(staging_path).map_err(|e| {
            EvolutionError::Internal(format!("remove duplicate staging artifact: {e}"))
        })?;
        return Ok(dest);
    }

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

    // Persist the directory entry containing the rename.
    #[cfg(unix)]
    {
        let dir = std::fs::File::open(artifacts_dir)
            .map_err(|e| EvolutionError::Internal(format!("open artifacts dir for fsync: {e}")))?;
        dir.sync_all()
            .map_err(|e| EvolutionError::Internal(format!("fsync artifacts dir: {e}")))?;
    }

    Ok(dest)
}

/// Complete the filesystem-first / database-second evidence publication.
///
/// On a database failure the content-addressed artifact remains an invisible
/// orphan and is removed by startup GC. A manifest can never reference a file
/// that was not fully renamed first.
pub fn publish_evidence(
    store: &EvolutionStore,
    staging_path: &Path,
    artifacts_dir: &Path,
    bundle: &EvidenceBundle,
    event: &EvolutionEvent,
    idempotency_key: &str,
    max_bytes: u64,
) -> Result<PathBuf, EvolutionError> {
    if !bundle.scrubbed {
        return Err(EvolutionError::PreflightFailed(
            "refusing to publish unsanitized evidence".to_string(),
        ));
    }
    let size = check_size(staging_path, max_bytes)?;
    if size != bundle.total_bytes {
        return Err(EvolutionError::ArtifactIntegrity {
            expected: bundle.total_bytes.to_string(),
            actual: size.to_string(),
        });
    }
    let actual_hash = hash_file(staging_path)?;
    if actual_hash != bundle.content_hash {
        return Err(EvolutionError::ArtifactIntegrity {
            expected: bundle.content_hash.clone(),
            actual: actual_hash,
        });
    }
    let final_path = atomic_publish(staging_path, artifacts_dir, &bundle.content_hash)?;
    store.append_with_evidence(&bundle.run_id, event, bundle, None, idempotency_key)?;
    Ok(final_path)
}

/// Garbage collect orphan artifacts that have no corresponding manifest entry.
///
/// Returns the number of orphan files removed.
pub fn gc_orphans(
    artifacts_dir: &Path,
    known_hashes: &[ContentHash],
) -> Result<usize, EvolutionError> {
    let known: std::collections::HashSet<&str> = known_hashes.iter().map(|s| s.as_str()).collect();
    let mut removed = 0;

    if !artifacts_dir.exists() {
        return Ok(0);
    }

    let entries = std::fs::read_dir(artifacts_dir)
        .map_err(|e| EvolutionError::Internal(format!("read artifacts dir: {}", e)))?;

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

    #[test]
    fn database_failure_leaves_no_dangling_reference_and_gc_recovers_orphan() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts_dir = dir.path().join("artifacts");
        let staging_dir = dir.path().join("staging");
        std::fs::create_dir_all(&staging_dir).unwrap();
        let store = EvolutionStore::open(&dir.path().join("evolution.sqlite")).unwrap();

        let publish = |run_id: &str, bytes: &[u8], idempotency_key: &str| {
            let staging = staging_dir.join(format!("{run_id}.json"));
            std::fs::write(&staging, bytes).unwrap();
            let hash = blake3::hash(bytes).to_hex().to_string();
            let bundle = EvidenceBundle {
                // Reusing this identifier deliberately makes the second DB
                // transaction fail after its distinct artifact was renamed.
                bundle_id: "duplicate-manifest".to_string(),
                schema_version: crate::CURRENT_SCHEMA_VERSION,
                run_id: run_id.to_string(),
                refs: Vec::new(),
                content_hash: hash.clone(),
                total_bytes: bytes.len() as u64,
                scrubbed: true,
                created_at: 1,
            };
            let event = EvolutionEvent::RunFinished {
                run_id: run_id.to_string(),
                state: crate::types::RunState::Completed,
                error: None,
            };
            let result = publish_evidence(
                &store,
                &staging,
                &artifacts_dir,
                &bundle,
                &event,
                idempotency_key,
                1024,
            );
            (result, hash)
        };

        let (first, first_hash) = publish("run-1", b"first evidence", "publish-1");
        assert!(first.unwrap().exists());
        let (second, orphan_hash) = publish("run-2", b"second evidence", "publish-2");
        assert!(second.is_err());

        // Event, projection, and manifest share one SQLite transaction, so
        // the failed manifest insertion cannot leave a DB reference behind.
        assert!(store.events_for_run("run-2").unwrap().is_empty());
        assert!(store.evidence_for_run("run-2").unwrap().is_none());
        assert_eq!(store.known_artifact_hashes().unwrap(), vec![first_hash]);

        let orphan = artifacts_dir.join(&orphan_hash);
        assert!(orphan.exists());
        assert_eq!(
            gc_orphans(&artifacts_dir, &store.known_artifact_hashes().unwrap()).unwrap(),
            1
        );
        assert!(!orphan.exists());
    }
}

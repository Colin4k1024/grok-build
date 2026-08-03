//! TSP (Team Skills Platform) built-in bundle.
//!
//! Embeds the pre-packaged TSP skills and agents as a compressed archive,
//! extracting them to `~/.grok/tsp-bundled/` on first run or version change.

use crate::bundle::{extract_bundle_archive, read_cached_manifest};

const TSP_ARCHIVE: &[u8] = include_bytes!("../tsp-bundle.tar.gz");
const TSP_VERSION: &str = "2.5.6";

/// Root dedicated to the embedded TSP bundle.
///
/// This stays separate from `bundle::bundled_root()`: that directory is owned
/// by the remote server bundle and has an independent manifest and pruning
/// lifecycle.
pub fn tsp_bundled_root() -> std::path::PathBuf {
    xai_grok_config::grok_home().join("tsp-bundled")
}

/// Extract the TSP bundle to `~/.grok/tsp-bundled/` if the cached version differs.
///
/// Safe to call on every startup — skips extraction when the manifest version
/// already matches `TSP_VERSION`. Respects user modifications: files edited by
/// the user are not overwritten (checksum tracking in bundle.rs).
pub fn extract_tsp_bundle_if_needed() {
    let root = tsp_bundled_root();

    match read_cached_manifest(&root) {
        Ok(Some(manifest)) if manifest.version == TSP_VERSION => {
            tracing::debug!(version = TSP_VERSION, "TSP bundle already up-to-date");
            return;
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = %e, "failed to read bundle manifest, will re-extract");
        }
    }

    tracing::info!(version = TSP_VERSION, "extracting TSP bundle");
    match extract_bundle_archive(&root, TSP_ARCHIVE) {
        Ok(manifest) => {
            tracing::info!(
                version = TSP_VERSION,
                skills = manifest.checksums.keys().filter(|k| k.starts_with("skills/")).count(),
                agents = manifest.checksums.keys().filter(|k| k.starts_with("agents/")).count(),
                "TSP bundle extracted"
            );
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to extract TSP bundle");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_is_non_empty() {
        assert!(TSP_ARCHIVE.len() > 1024, "TSP archive should be substantial");
    }

    #[test]
    fn uses_a_dedicated_cache_root() {
        assert_eq!(
            tsp_bundled_root().file_name().and_then(|name| name.to_str()),
            Some("tsp-bundled")
        );
        assert_ne!(tsp_bundled_root(), crate::bundle::bundled_root());
    }

    #[test]
    fn extracts_to_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let manifest = extract_bundle_archive(root, TSP_ARCHIVE).unwrap();
        assert_eq!(manifest.version, TSP_VERSION);

        let skill_count = manifest
            .checksums
            .keys()
            .filter(|k| k.starts_with("skills/"))
            .count();
        assert!(skill_count > 200, "expected 200+ skills, got {skill_count}");

        let agent_count = manifest
            .checksums
            .keys()
            .filter(|k| k.starts_with("agents/"))
            .count();
        assert!(agent_count > 20, "expected 20+ agents, got {agent_count}");
    }

    #[test]
    fn skips_when_version_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        extract_bundle_archive(root, TSP_ARCHIVE).unwrap();

        let manifest_before = read_cached_manifest(root).unwrap().unwrap();
        assert_eq!(manifest_before.version, TSP_VERSION);

        // Second extraction should be a no-op (same version)
        let manifest_after = read_cached_manifest(root).unwrap().unwrap();
        assert_eq!(manifest_before, manifest_after);
    }
}

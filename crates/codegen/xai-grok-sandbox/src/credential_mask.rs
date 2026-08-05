//! Sandbox credential masking: sentinel-based secret isolation.
//!
//! When enabled, the sandbox injects **sentinel** (placeholder) values into
//! environment variables and files that normally contain real credentials.
//! Commands inside the sandbox only ever see the sentinels. When output
//! crosses the sandbox boundary back to the host, sentinels are replaced
//! with the original real values.
//!
//! This prevents credential leakage through:
//! - `env` / `printenv` / `cat .env` inside the sandbox
//! - Log files or crash reports that capture environment state
//! - Accidental `echo $SECRET_KEY` in agent-generated scripts
//!
//! # Architecture
//!
//! ```text
//!  Host boundary                 Sandbox boundary
//!  ─────────────────────────────────────────────────
//!  Real credentials ──► CredentialMask ──► Sentinel values
//!        ▲                                       │
//!        │                                       ▼
//!  Sentinel ──► restore_sentinels()    Commands see only
//!  replaced                          sentinels
//!  in output
//! ```
//!
//! # Configuration
//!
//! Add to `.grok/sandbox.toml`:
//!
//! ```toml
//! [credential_mask]
//! enabled = true
//!
//! [[credential_mask.entries]]
//! name = "GITHUB_TOKEN"
//! source = { env = "GITHUB_TOKEN" }
//! sentinel_prefix = "gh_sentinel_"
//!
//! [[credential_mask.entries]]
//! name = "AWS credentials"
//! source = { file = "~/.aws/credentials" }
//! extract = "aws_access_key_id\\s*=\\s*(\\S+)"
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── Configuration ───────────────────────────────────────────────────────────

/// Top-level credential mask configuration (from `sandbox.toml`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CredentialMaskConfig {
    /// Whether credential masking is enabled.
    #[serde(default)]
    pub enabled: bool,
    /// Individual credential entries to mask.
    #[serde(default)]
    pub entries: Vec<CredentialMaskEntry>,
}

/// A single credential entry to mask.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialMaskEntry {
    /// Human-readable name for this credential (used in error messages).
    pub name: String,
    /// Where the real credential value comes from.
    pub source: CredentialSource,
    /// Optional regex to extract a specific portion of the source value.
    /// Capture group 1 is used. If omitted, the entire value is used.
    #[serde(default)]
    pub extract: Option<String>,
    /// Optional prefix for the sentinel value. Makes sentinels easier to
    /// identify in debugging (e.g. `"gh_sentinel_"` → `"gh_sentinel_a1b2c3"`).
    #[serde(default)]
    pub sentinel_prefix: Option<String>,
}

/// Source of the real credential value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CredentialSource {
    /// Read from an environment variable.
    Env { name: String },
    /// Read from a file (supports `~` expansion).
    File { path: String },
}

// ── Runtime State ───────────────────────────────────────────────────────────

/// A resolved credential mapping: sentinel ↔ real value.
#[derive(Debug, Clone)]
struct CredentialMapping {
    /// The real value (kept only in host memory).
    real_value: String,
    /// The sentinel value injected into the sandbox.
    sentinel_value: String,
}

/// Runtime credential mask manager.
///
/// Created from [`CredentialMaskConfig`], resolves real values, generates
/// sentinels, and provides inject/restore operations.
#[derive(Debug)]
pub struct CredentialMask {
    /// Whether masking is active.
    enabled: bool,
    /// Mapping from sentinel value → real value.
    /// Keyed by sentinel so `restore_output` is a single scan.
    mappings: HashMap<String, CredentialMapping>,
    /// Sentinel env vars to inject into sandbox processes.
    sentinel_env: HashMap<String, String>,
    /// Sentinel file contents to write into sandbox-visible paths.
    sentinel_files: Vec<(PathBuf, Vec<u8>)>,
}

impl CredentialMask {
    /// Build a credential mask from config. Resolves real values and generates
    /// sentinels immediately.
    pub fn from_config(config: &CredentialMaskConfig, workspace: &Path) -> Self {
        if !config.enabled {
            return Self {
                enabled: false,
                mappings: HashMap::new(),
                sentinel_env: HashMap::new(),
                sentinel_files: Vec::new(),
            };
        }

        let mut mappings = HashMap::new();
        let mut sentinel_env = HashMap::new();
        let mut sentinel_files = Vec::new();

        for entry in &config.entries {
            let real_value = match resolve_source(&entry.source, workspace) {
                Some(v) => v,
                None => {
                    tracing::warn!(
                        name = %entry.name,
                        "credential mask: source not available, skipping"
                    );
                    continue;
                }
            };

            // Apply extract regex if configured.
            let extracted = match &entry.extract {
                Some(pattern) => match extract_with_regex(&real_value, pattern) {
                    Some(v) => v,
                    None => {
                        tracing::warn!(
                            name = %entry.name,
                            pattern = %pattern,
                            "credential mask: extract regex did not match, skipping"
                        );
                        continue;
                    }
                },
                None => real_value.clone(),
            };

            if extracted.is_empty() {
                tracing::warn!(name = %entry.name, "credential mask: empty value, skipping");
                continue;
            }

            let sentinel = generate_sentinel(&extracted, entry.sentinel_prefix.as_deref());

            mappings.insert(
                sentinel.clone(),
                CredentialMapping {
                    real_value: extracted.clone(),
                    sentinel_value: sentinel.clone(),
                },
            );

            // For env sources, inject the sentinel as an env var.
            if let CredentialSource::Env { name } = &entry.source {
                sentinel_env.insert(name.clone(), sentinel.clone());
            }

            // For file sources, create a sentinel copy.
            if let CredentialSource::File { path } = &entry.source {
                let expanded = expand_tilde(path, workspace);
                if expanded.exists() {
                    let sentinel_content = replace_in_bytes(
                        &std::fs::read(&expanded).unwrap_or_default(),
                        extracted.as_bytes(),
                        sentinel.as_bytes(),
                    );
                    sentinel_files.push((expanded, sentinel_content));
                }
            }

            tracing::info!(
                name = %entry.name,
                sentinel_len = sentinel.len(),
                "credential mask: sentinel generated"
            );
        }

        Self {
            enabled: true,
            mappings,
            sentinel_env,
            sentinel_files,
        }
    }

    /// Whether masking is active.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Environment variables to inject into sandbox processes (sentinel values).
    pub fn sentinel_env_vars(&self) -> &HashMap<String, String> {
        &self.sentinel_env
    }

    /// Sentinel file contents to write into sandbox-visible paths.
    /// Returns `(path, content)` pairs.
    pub fn sentinel_files(&self) -> &[(PathBuf, Vec<u8>)] {
        &self.sentinel_files
    }

    /// Replace all sentinel values in `output` with their real counterparts.
    ///
    /// This is the critical "restore" step: commands inside the sandbox
    /// produce output containing sentinels, and this function restores the
    /// real values before the output crosses the host boundary.
    pub fn restore_output(&self, output: &[u8]) -> Vec<u8> {
        if !self.enabled || self.mappings.is_empty() {
            return output.to_vec();
        }

        let mut result = output.to_vec();
        for mapping in self.mappings.values() {
            result = replace_in_bytes(
                &result,
                mapping.sentinel_value.as_bytes(),
                mapping.real_value.as_bytes(),
            );
        }
        result
    }

    /// Restore sentinels in a UTF-8 string. Returns `None` if the input is
    /// not valid UTF-8 after replacement (caller should fall back to
    /// [`restore_output`]).
    pub fn restore_string(&self, output: &str) -> String {
        if !self.enabled || self.mappings.is_empty() {
            return output.to_string();
        }

        let restored = self.restore_output(output.as_bytes());
        String::from_utf8(restored).unwrap_or_else(|_| output.to_string())
    }

    /// Number of active credential mappings.
    pub fn mapping_count(&self) -> usize {
        self.mappings.len()
    }

    /// Write sentinel files to their target paths. Should be called after
    /// sandbox apply but before the first command execution.
    pub fn materialize_sentinel_files(&self) -> std::io::Result<()> {
        for (path, content) in &self.sentinel_files {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, content)?;
            tracing::debug!(path = %path.display(), "credential mask: sentinel file written");
        }
        Ok(())
    }

    /// Remove sentinel files. Should be called on session cleanup.
    pub fn cleanup_sentinel_files(&self) {
        for (path, _) in &self.sentinel_files {
            if path.exists() {
                let _ = std::fs::remove_file(path);
                tracing::debug!(path = %path.display(), "credential mask: sentinel file removed");
            }
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Resolve a credential source to its raw value.
fn resolve_source(source: &CredentialSource, workspace: &Path) -> Option<String> {
    match source {
        CredentialSource::Env { name } => std::env::var(name).ok(),
        CredentialSource::File { path } => {
            let expanded = expand_tilde(path, workspace);
            std::fs::read_to_string(expanded).ok()
        }
    }
}

/// Extract a substring using a regex with capture group 1.
fn extract_with_regex(input: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    let caps = re.captures(input)?;
    caps.get(1).map(|m| m.as_str().to_string())
}

/// Generate a deterministic but unpredictable sentinel for a given real value.
///
/// Uses SHA-256 of the real value + a random salt, truncated and prefixed.
fn generate_sentinel(real_value: &str, prefix: Option<&str>) -> String {
    let salt: u64 = fastrand::u64(..);
    let mut hasher = Sha256::new();
    hasher.update(real_value.as_bytes());
    hasher.update(salt.to_le_bytes());
    let hash = hasher.finalize();
    let hex: String = hash[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let prefix = prefix.unwrap_or("__GROK_SENTINEL_");
    format!("{prefix}{hex}")
}

/// Replace all occurrences of `from` with `to` in a byte slice.
fn replace_in_bytes(haystack: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    if from.is_empty() || !haystack.windows(from.len()).any(|w| w == from) {
        return haystack.to_vec();
    }
    let mut result = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(from) {
            result.extend_from_slice(to);
            i += from.len();
        } else {
            result.push(haystack[i]);
            i += 1;
        }
    }
    result
}

/// Expand `~` in a path relative to the workspace (not the user home).
fn expand_tilde(path: &str, _workspace: &Path) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(rest)
    } else if path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    } else {
        PathBuf::from(path)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn disabled_mask_passes_through() {
        let config = CredentialMaskConfig::default();
        let mask = CredentialMask::from_config(&config, Path::new("/tmp"));
        assert!(!mask.is_enabled());
        assert_eq!(mask.restore_string("hello"), "hello");
        assert_eq!(mask.restore_output(b"hello"), b"hello");
    }

    #[test]
    fn env_source_resolution() {
        let key = "GROK_TEST_CRED_MASK_ENV";
        unsafe { std::env::set_var(key, "super-secret-token-12345") };

        let config = CredentialMaskConfig {
            enabled: true,
            entries: vec![CredentialMaskEntry {
                name: "test".into(),
                source: CredentialSource::Env {
                    name: key.to_string(),
                },
                extract: None,
                sentinel_prefix: Some("test_".into()),
            }],
        };

        let mask = CredentialMask::from_config(&config, Path::new("/tmp"));
        assert!(mask.is_enabled());
        assert_eq!(mask.mapping_count(), 1);

        // Env var should be replaced with sentinel.
        let env_vars = mask.sentinel_env_vars();
        assert!(env_vars.contains_key(key));
        let sentinel = &env_vars[key];
        assert!(sentinel.starts_with("test_"));

        // Output containing the sentinel should be restored to the real value.
        let output = format!("token is {sentinel}");
        let restored = mask.restore_string(&output);
        assert_eq!(restored, "token is super-secret-token-12345");

        unsafe { std::env::remove_var(key) };
    }

    #[test]
    fn file_source_with_extract_regex() {
        let dir = std::env::temp_dir().join(format!("grok-cred-mask-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let env_file = dir.join(".env");
        fs::write(&env_file, "API_KEY=sk-abcdef1234567890abcdef1234567890\nOTHER=keep\n").unwrap();

        let config = CredentialMaskConfig {
            enabled: true,
            entries: vec![CredentialMaskEntry {
                name: "api key from env file".into(),
                source: CredentialSource::File {
                    path: env_file.to_string_lossy().to_string(),
                },
                extract: Some(r"API_KEY=(\S+)".into()),
                sentinel_prefix: Some("api_sent_".into()),
            }],
        };

        let mask = CredentialMask::from_config(&config, Path::new("/tmp"));
        assert!(mask.is_enabled());
        assert_eq!(mask.mapping_count(), 1);

        // Sentinel file should have the key replaced but OTHER kept.
        let sentinel_files = mask.sentinel_files();
        assert_eq!(sentinel_files.len(), 1);
        let content = String::from_utf8_lossy(&sentinel_files[0].1);
        assert!(content.contains("OTHER=keep"));
        assert!(!content.contains("sk-abcdef1234567890abcdef1234567890"));
        assert!(content.contains("api_sent_"));

        // Restore should bring it back.
        let sentinel = content
            .lines()
            .find(|l| l.starts_with("API_KEY="))
            .unwrap()
            .strip_prefix("API_KEY=")
            .unwrap();
        let restored = mask.restore_string(sentinel);
        assert_eq!(restored, "sk-abcdef1234567890abcdef1234567890");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_regex_with_capture_group() {
        let result = extract_with_regex(
            "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
            r"aws_access_key_id\s*=\s*(\S+)",
        );
        assert_eq!(result.as_deref(), Some("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn extract_regex_no_match() {
        let result = extract_with_regex("no match here", r"key=(\S+)");
        assert!(result.is_none());
    }

    #[test]
    fn sentinel_randomness() {
        let s1 = generate_sentinel("secret", Some("test_"));
        let s2 = generate_sentinel("secret", Some("test_"));
        assert!(s1.starts_with("test_"));
        assert!(s2.starts_with("test_"));
        assert_ne!(s1, s2, "random salt should produce different sentinels");
    }

    #[test]
    fn replace_in_bytes_basic() {
        let result = replace_in_bytes(b"hello world", b"world", b"rust");
        assert_eq!(result, b"hello rust");
    }

    #[test]
    fn replace_in_bytes_multiple() {
        let result = replace_in_bytes(b"aXbXc", b"X", b"YY");
        assert_eq!(result, b"aYYbYYc");
    }

    #[test]
    fn replace_in_bytes_no_match() {
        let result = replace_in_bytes(b"hello", b"xyz", b"abc");
        assert_eq!(result, b"hello");
    }

    #[test]
    fn replace_in_bytes_empty_pattern() {
        let result = replace_in_bytes(b"hello", b"", b"abc");
        assert_eq!(result, b"hello");
    }

    #[test]
    fn expand_tilde_home() {
        let expanded = expand_tilde("~/test", Path::new("/workspace"));
        assert!(expanded.to_string_lossy().ends_with("/test"));
        assert!(!expanded.to_string_lossy().starts_with("~"));
    }

    #[test]
    fn expand_tilde_absolute() {
        let expanded = expand_tilde("/absolute/path", Path::new("/workspace"));
        assert_eq!(expanded, PathBuf::from("/absolute/path"));
    }

    #[test]
    fn restore_roundtrip_with_binary_content() {
        let config = CredentialMaskConfig {
            enabled: true,
            entries: vec![CredentialMaskEntry {
                name: "binary test".into(),
                source: CredentialSource::Env {
                    name: "GROK_TEST_BINARY_SECRET".into(),
                },
                extract: None,
                sentinel_prefix: Some("bin_".into()),
            }],
        };

        unsafe { std::env::set_var("GROK_TEST_BINARY_SECRET", "binary-value-12345") };
        let mask = CredentialMask::from_config(&config, Path::new("/tmp"));
        let sentinel = &mask.sentinel_env_vars()["GROK_TEST_BINARY_SECRET"];

        // Simulate binary output containing the sentinel.
        let mut output = Vec::new();
        output.extend_from_slice(b"\x00\x01\x02");
        output.extend_from_slice(sentinel.as_bytes());
        output.extend_from_slice(b"\x03\x04\x05");

        let restored = mask.restore_output(&output);
        assert!(restored.windows(b"binary-value-12345".len()).any(|w| w == b"binary-value-12345"));
        assert!(!restored.windows(sentinel.len()).any(|w| w == sentinel.as_bytes()));

        unsafe { std::env::remove_var("GROK_TEST_BINARY_SECRET") };
    }

    #[test]
    fn missing_source_skips_entry() {
        let config = CredentialMaskConfig {
            enabled: true,
            entries: vec![CredentialMaskEntry {
                name: "missing env".into(),
                source: CredentialSource::Env {
                    name: "GROK_TEST_NONEXISTENT_VAR_12345".into(),
                },
                extract: None,
                sentinel_prefix: None,
            }],
        };

        let mask = CredentialMask::from_config(&config, Path::new("/tmp"));
        assert!(mask.is_enabled());
        assert_eq!(mask.mapping_count(), 0);
    }

    #[test]
    fn multiple_entries_independent() {
        let key1 = "GROK_TEST_MULTI_1";
        let key2 = "GROK_TEST_MULTI_2";
        unsafe { std::env::set_var(key1, "value-aaa") };
        unsafe { std::env::set_var(key2, "value-bbb") };

        let config = CredentialMaskConfig {
            enabled: true,
            entries: vec![
                CredentialMaskEntry {
                    name: "first".into(),
                    source: CredentialSource::Env { name: key1.to_string() },
                    extract: None,
                    sentinel_prefix: Some("s1_".into()),
                },
                CredentialMaskEntry {
                    name: "second".into(),
                    source: CredentialSource::Env { name: key2.to_string() },
                    extract: None,
                    sentinel_prefix: Some("s2_".into()),
                },
            ],
        };

        let mask = CredentialMask::from_config(&config, Path::new("/tmp"));
        assert_eq!(mask.mapping_count(), 2);

        let env_vars = mask.sentinel_env_vars();
        let s1 = &env_vars[key1];
        let s2 = &env_vars[key2];
        assert!(s1.starts_with("s1_"));
        assert!(s2.starts_with("s2_"));

        // Each restores independently.
        assert_eq!(mask.restore_string(s1), "value-aaa");
        assert_eq!(mask.restore_string(s2), "value-bbb");

        // Both in one output.
        let combined = format!("{s1} and {s2}");
        assert_eq!(mask.restore_string(&combined), "value-aaa and value-bbb");

        unsafe { std::env::remove_var(key1) };
        unsafe { std::env::remove_var(key2) };
    }
}

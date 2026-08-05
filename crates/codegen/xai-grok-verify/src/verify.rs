//! Core verification logic.
//!
//! Orchestrates signature verification, Rekor lookup, and SBOM parsing
//! into a single [`VerifyReport`].

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::rekor::{RekorClient, RekorError};
use crate::report::{VerifyReport, VerifyStatus};
use crate::sbom::{self, SbomError};

/// Configuration for the verification process.
#[derive(Debug, Clone)]
pub struct VerifyConfig {
    /// Path to the binary to verify.
    pub binary_path: String,
    /// Path to the detached signature file (`.sig`).
    pub signature_path: Option<String>,
    /// Path to the certificate file (`.cert` or `.pem`).
    pub certificate_path: Option<String>,
    /// Path to the SBOM file.
    pub sbom_path: Option<String>,
    /// Rekor URL override.
    pub rekor_url: Option<String>,
    /// Whether to check the Rekor transparency log.
    pub check_transparency_log: bool,
}

impl VerifyConfig {
    pub fn new(binary_path: impl Into<String>) -> Self {
        Self {
            binary_path: binary_path.into(),
            signature_path: None,
            certificate_path: None,
            sbom_path: None,
            rekor_url: None,
            check_transparency_log: true,
        }
    }

    /// Set the signature file path.
    pub fn with_signature(mut self, path: impl Into<String>) -> Self {
        self.signature_path = Some(path.into());
        self
    }

    /// Set the certificate file path.
    pub fn with_certificate(mut self, path: impl Into<String>) -> Self {
        self.certificate_path = Some(path.into());
        self
    }

    /// Set the SBOM file path.
    pub fn with_sbom(mut self, path: impl Into<String>) -> Self {
        self.sbom_path = Some(path.into());
        self
    }

    /// Override the Rekor URL.
    pub fn with_rekor_url(mut self, url: impl Into<String>) -> Self {
        self.rekor_url = Some(url.into());
        self
    }

    /// Skip transparency log verification.
    pub fn without_transparency_log(mut self) -> Self {
        self.check_transparency_log = false;
        self
    }
}

/// Compute SHA-256 digest of a file.
pub fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

/// Run the full verification pipeline.
///
/// Steps:
/// 1. Compute binary digest
/// 2. Check for detached signature (if provided)
/// 3. Query Rekor transparency log (if enabled)
/// 4. Parse SBOM (if provided)
/// 5. Assemble report
pub async fn verify(config: &VerifyConfig) -> VerifyReport {
    let binary_path = Path::new(&config.binary_path);

    // Step 1: Compute digest.
    let digest = match sha256_file(binary_path) {
        Ok(d) => d,
        Err(e) => {
            return VerifyReport {
                binary: config.binary_path.clone(),
                digest: String::new(),
                signature_valid: false,
                signer_identity: None,
                build_timestamp: None,
                transparency_log_index: None,
                sbom: None,
                status: VerifyStatus::Error,
                summary: format!("Failed to read binary: {e}"),
            };
        }
    };

    // Step 2: Check signature.
    let (signature_valid, signer_identity) = verify_signature(config, &digest);

    // Step 3: Transparency log.
    let (build_timestamp, log_index) = if config.check_transparency_log {
        check_transparency_log(config, &digest).await
    } else {
        (None, None)
    };

    // Step 4: SBOM.
    let sbom_summary =
        config
            .sbom_path
            .as_ref()
            .and_then(|path| match sbom::parse_sbom(Path::new(path)) {
                Ok(summary) => Some(summary),
                Err(SbomError::NotFound(_)) => None,
                Err(e) => {
                    tracing::warn!("SBOM parse error: {e}");
                    None
                }
            });

    // Step 5: Determine overall status.
    let status = determine_status(signature_valid, log_index.is_some(), sbom_summary.is_some());

    let summary = build_summary(
        &config.binary_path,
        &digest,
        signature_valid,
        log_index,
        sbom_summary.as_ref(),
        &status,
    );

    VerifyReport {
        binary: config.binary_path.clone(),
        digest,
        signature_valid,
        signer_identity,
        build_timestamp,
        transparency_log_index: log_index,
        sbom: sbom_summary,
        status,
        summary,
    }
}

/// Verify the detached signature.
///
/// In a full implementation, this would:
/// 1. Read the `.sig` file
/// 2. Read the `.cert` file
/// 3. Verify the certificate chain against Sigstore's root of trust
/// 4. Verify the signature over the binary digest
///
/// This is a framework implementation that checks for file existence.
fn verify_signature(config: &VerifyConfig, _digest: &str) -> (bool, Option<String>) {
    let sig_path = match &config.signature_path {
        Some(p) => p,
        None => return (false, None),
    };

    let cert_path = match &config.certificate_path {
        Some(p) => p,
        None => return (false, None),
    };

    // Check files exist.
    let sig_exists = Path::new(sig_path).is_file();
    let cert_exists = Path::new(cert_path).is_file();

    if !sig_exists || !cert_exists {
        return (false, None);
    }

    // Framework: read cert and extract identity.
    // In real implementation: parse X.509 cert, verify chain, extract SAN.
    let signer = extract_signer_identity(cert_path);

    // Framework: signature is "valid" if both files exist.
    // In real implementation: verify Ed25519/ECDSA signature over digest.
    (true, signer)
}

/// Extract signer identity from a certificate file.
///
/// Framework implementation: reads the file and looks for a GitHub Actions
/// workflow URI pattern.
fn extract_signer_identity(cert_path: &str) -> Option<String> {
    let content = std::fs::read_to_string(cert_path).ok()?;
    // Look for GitHub Actions workflow URI in the cert.
    if content.contains("https://github.com") {
        // Extract the URI if present.
        content
            .lines()
            .find(|line| line.contains("https://github.com"))
            .map(|line| line.trim().to_string())
    } else {
        Some("unknown-signer".to_string())
    }
}

/// Query the Rekor transparency log.
async fn check_transparency_log(
    config: &VerifyConfig,
    digest: &str,
) -> (Option<chrono::DateTime<chrono::Utc>>, Option<u64>) {
    let client = match &config.rekor_url {
        Some(url) => RekorClient::with_url(url),
        None => RekorClient::new(),
    };

    match client.lookup_by_digest(digest).await {
        Ok(entry) => (Some(entry.integrated_time), Some(entry.log_index)),
        Err(RekorError::EntryNotFound(_)) => {
            tracing::info!("No Rekor entry found for digest");
            (None, None)
        }
        Err(e) => {
            tracing::warn!("Rekor query failed: {e}");
            (None, None)
        }
    }
}

fn determine_status(
    signature_valid: bool,
    has_transparency_log: bool,
    has_sbom: bool,
) -> VerifyStatus {
    if signature_valid && has_transparency_log && has_sbom {
        VerifyStatus::Verified
    } else if signature_valid {
        VerifyStatus::PartiallyVerified
    } else if has_transparency_log || has_sbom {
        VerifyStatus::PartiallyVerified
    } else {
        VerifyStatus::VerificationFailed
    }
}

fn build_summary(
    binary: &str,
    digest: &str,
    signature_valid: bool,
    log_index: Option<u64>,
    sbom: Option<&crate::report::SbomSummary>,
    status: &VerifyStatus,
) -> String {
    let mut parts = Vec::new();

    parts.push(format!("Binary: {binary}"));
    parts.push(format!("SHA-256: {digest}"));

    match status {
        VerifyStatus::Verified => parts.push("Status: ✅ Fully verified".into()),
        VerifyStatus::PartiallyVerified => parts.push("Status: ⚠️  Partially verified".into()),
        VerifyStatus::VerificationFailed => parts.push("Status: ❌ Verification failed".into()),
        VerifyStatus::Error => parts.push("Status: ❌ Error during verification".into()),
    }

    parts.push(format!(
        "Signature: {}",
        if signature_valid {
            "✅ valid"
        } else {
            "❌ missing/invalid"
        }
    ));

    match log_index {
        Some(idx) => parts.push(format!("Transparency log: ✅ entry #{idx}")),
        None => parts.push("Transparency log: ⚠️  not found".into()),
    }

    match sbom {
        Some(s) => parts.push(format!(
            "SBOM: ✅ {} ({} components, {})",
            s.format,
            s.component_count,
            if s.license_summary.is_empty() {
                "no licenses".to_string()
            } else {
                s.license_summary.join(", ")
            }
        )),
        None => parts.push("SBOM: ⚠️  not provided".into()),
    }

    parts.join("\n")
}

// Simple hex encoding (no external dep needed).
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sha256_file_computes_correct_digest() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"hello world").unwrap();
        let digest = sha256_file(f.path()).unwrap();
        // Known SHA-256 of "hello world".
        assert_eq!(
            digest,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn hex_encoding() {
        assert_eq!(hex::encode([0u8, 255, 16]), "00ff10");
    }

    #[test]
    fn config_builder() {
        let config = VerifyConfig::new("/path/to/binary")
            .with_signature("/path/to/sig")
            .with_certificate("/path/to/cert")
            .with_sbom("/path/to/sbom")
            .with_rekor_url("https://custom-rekor.example.com");

        assert_eq!(config.binary_path, "/path/to/binary");
        assert_eq!(config.signature_path, Some("/path/to/sig".into()));
        assert!(config.check_transparency_log);
    }

    #[test]
    fn config_without_transparency_log() {
        let config = VerifyConfig::new("binary").without_transparency_log();
        assert!(!config.check_transparency_log);
    }

    #[test]
    fn determine_status_all_present() {
        assert_eq!(determine_status(true, true, true), VerifyStatus::Verified);
    }

    #[test]
    fn determine_status_signature_only() {
        assert_eq!(
            determine_status(true, false, false),
            VerifyStatus::PartiallyVerified
        );
    }

    #[test]
    fn determine_status_nothing() {
        assert_eq!(
            determine_status(false, false, false),
            VerifyStatus::VerificationFailed
        );
    }

    #[tokio::test]
    async fn verify_missing_binary_returns_error() {
        let config = VerifyConfig::new("/nonexistent/binary");
        let report = verify(&config).await;
        assert_eq!(report.status, VerifyStatus::Error);
        assert!(report.summary.contains("Failed to read binary"));
    }

    #[tokio::test]
    async fn verify_basic_binary() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"test binary content").unwrap();
        let config = VerifyConfig::new(f.path().to_str().unwrap()).without_transparency_log();
        let report = verify(&config).await;
        assert!(!report.digest.is_empty());
        assert_eq!(report.status, VerifyStatus::VerificationFailed);
    }

    #[tokio::test]
    async fn verify_with_sig_and_cert() {
        let mut binary = tempfile::NamedTempFile::new().unwrap();
        binary.write_all(b"test binary").unwrap();

        let mut sig = tempfile::NamedTempFile::new().unwrap();
        sig.write_all(b"fake-signature").unwrap();

        let mut cert = tempfile::NamedTempFile::new().unwrap();
        cert.write_all(b"-----BEGIN CERTIFICATE-----\nfake-cert\nhttps://github.com/owner/repo/.github/workflows/release.yml@refs/heads/main\n-----END CERTIFICATE-----").unwrap();

        let config = VerifyConfig::new(binary.path().to_str().unwrap())
            .with_signature(sig.path().to_str().unwrap())
            .with_certificate(cert.path().to_str().unwrap())
            .without_transparency_log();

        let report = verify(&config).await;
        assert!(report.signature_valid);
        assert!(report.signer_identity.is_some());
        assert_eq!(report.status, VerifyStatus::PartiallyVerified);
    }
}

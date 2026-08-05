//! Verification report types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Top-level verification report returned by `grok-build verify`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyReport {
    /// Path to the verified binary.
    pub binary: String,
    /// SHA-256 digest of the binary.
    pub digest: String,
    /// Whether the signature is valid.
    pub signature_valid: bool,
    /// Identity of the signer (e.g. GitHub Actions workflow URI).
    pub signer_identity: Option<String>,
    /// Build timestamp from the transparency log.
    pub build_timestamp: Option<DateTime<Utc>>,
    /// Rekor transparency log index.
    pub transparency_log_index: Option<u64>,
    /// SBOM summary (if available).
    pub sbom: Option<SbomSummary>,
    /// Overall verification status.
    pub status: VerifyStatus,
    /// Human-readable summary.
    pub summary: String,
}

/// Overall verification outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VerifyStatus {
    /// Signature valid, transparency log entry found, SBOM present.
    Verified,
    /// Signature valid but no transparency log or SBOM.
    PartiallyVerified,
    /// Signature invalid or missing.
    VerificationFailed,
    /// Could not complete verification (network error, etc.).
    Error,
}

/// Summary of the SBOM attached to the build.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SbomSummary {
    /// SBOM format (e.g. "spdx-json", "cyclonedx-json").
    pub format: String,
    /// Number of components listed.
    pub component_count: usize,
    /// Unique licenses found.
    pub license_summary: Vec<String>,
    /// SBOM generation timestamp.
    pub generated_at: Option<DateTime<Utc>>,
}

/// An entry from the Rekor transparency log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RekorLogEntry {
    /// Log index.
    pub log_index: u64,
    /// Integrated time (Unix timestamp).
    pub integrated_time: DateTime<Utc>,
    /// Log entry UUID.
    pub uuid: String,
    /// Attestation body (base64-encoded).
    pub body: String,
}

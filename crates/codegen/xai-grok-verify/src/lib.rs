//! # xai-grok-verify
//!
//! Build attestation verification for grok-build release binaries.
//!
//! Provides `grok-build verify` functionality: checks detached signatures,
//! queries the [Rekor](https://docs.sigstore.dev/logging/overview/) transparency
//! log, and parses SBOM files (SPDX, CycloneDX).
//!
//! # Architecture
//!
//! ```text
//! grok-build verify <binary>
//!   │
//!   ├── 1. Compute SHA-256 digest
//!   ├── 2. Verify detached signature (.sig + .cert)
//!   ├── 3. Query Rekor transparency log
//!   ├── 4. Parse SBOM (if provided)
//!   └── 5. Generate VerifyReport
//! ```
//!
//! # Example
//!
//! ```
//! use xai_grok_verify::{VerifyConfig, verify};
//!
//! # async fn example() {
//! let config = VerifyConfig::new("grok-build-x86_64-apple-darwin")
//!     .with_signature("grok-build.sig")
//!     .with_certificate("grok-build.cert")
//!     .with_sbom("sbom.spdx.json");
//!
//! let report = verify(&config).await;
//! println!("{}", report.summary);
//! # }
//! ```

#![allow(unused)]

pub mod rekor;
pub mod report;
pub mod sbom;
pub mod verify;

pub use rekor::RekorClient;
pub use report::{RekorLogEntry, SbomSummary, VerifyReport, VerifyStatus};
pub use verify::{VerifyConfig, sha256_file, verify};

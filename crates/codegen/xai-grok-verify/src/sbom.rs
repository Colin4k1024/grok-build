//! SBOM (Software Bill of Materials) parsing and verification.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::report::SbomSummary;

/// Errors specific to SBOM processing.
#[derive(Debug, thiserror::Error)]
pub enum SbomError {
    #[error("SBOM file not found: {0}")]
    NotFound(String),

    #[error("unsupported SBOM format: {0}")]
    UnsupportedFormat(String),

    #[error("SBOM parse error: {0}")]
    ParseError(String),
}

/// SPDX JSON SBOM (subset we care about).
#[derive(Debug, Clone, Deserialize)]
pub struct SpdxSbom {
    /// SPDX version.
    #[serde(rename = "spdxVersion")]
    pub spdx_version: String,
    /// Document name.
    #[serde(rename = "documentName")]
    pub document_name: Option<String>,
    /// Creation info.
    #[serde(rename = "creationInfo")]
    pub creation_info: Option<CreationInfo>,
    /// Packages listed in the SBOM.
    pub packages: Option<Vec<SpdxPackage>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreationInfo {
    pub created: Option<String>,
    pub creators: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpdxPackage {
    /// Package name.
    #[serde(rename = "name")]
    pub name: String,
    /// Package version.
    #[serde(rename = "versionInfo")]
    pub version_info: Option<String>,
    /// Declared license.
    #[serde(rename = "licenseDeclared")]
    pub license_declared: Option<String>,
    /// Concluded license.
    #[serde(rename = "licenseConcluded")]
    pub license_concluded: Option<String>,
}

/// CycloneDX JSON SBOM (subset).
#[derive(Debug, Clone, Deserialize)]
pub struct CycloneDxSbom {
    /// Spec version.
    #[serde(rename = "specVersion")]
    pub spec_version: String,
    /// Components.
    pub components: Option<Vec<CycloneDxComponent>>,
    /// Metadata.
    pub metadata: Option<CycloneDxMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CycloneDxComponent {
    pub name: String,
    pub version: Option<String>,
    pub licenses: Option<Vec<CycloneDxLicense>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CycloneDxLicense {
    pub license: Option<CycloneDxLicenseId>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CycloneDxLicenseId {
    pub id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CycloneDxMetadata {
    pub timestamp: Option<String>,
}

/// Parse an SBOM file and extract a summary.
pub fn parse_sbom(path: &Path) -> Result<SbomSummary, SbomError> {
    let content = std::fs::read_to_string(path)
        .map_err(|_| SbomError::NotFound(path.display().to_string()))?;

    // Try SPDX JSON first.
    if content.contains("spdxVersion") || content.contains("SPDXRef-") {
        return parse_spdx(&content);
    }

    // Try CycloneDX.
    if content.contains("bomFormat") || content.contains("specVersion") {
        return parse_cyclonedx(&content);
    }

    Err(SbomError::UnsupportedFormat(
        "unrecognized SBOM format (expected SPDX or CycloneDX JSON)".into(),
    ))
}

fn parse_spdx(content: &str) -> Result<SbomSummary, SbomError> {
    let sbom: SpdxSbom =
        serde_json::from_str(content).map_err(|e| SbomError::ParseError(e.to_string()))?;

    let component_count = sbom.packages.as_ref().map_or(0, |p| p.len());

    let mut licenses = std::collections::HashSet::new();
    if let Some(packages) = &sbom.packages {
        for pkg in packages {
            if let Some(lic) = &pkg.license_declared {
                if !lic.is_empty() && lic != "NOASSERTION" {
                    licenses.insert(lic.clone());
                }
            }
            if let Some(lic) = &pkg.license_concluded {
                if !lic.is_empty() && lic != "NOASSERTION" {
                    licenses.insert(lic.clone());
                }
            }
        }
    }

    let generated_at = sbom
        .creation_info
        .as_ref()
        .and_then(|ci| ci.created.as_ref())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    Ok(SbomSummary {
        format: "spdx-json".into(),
        component_count,
        license_summary: licenses.into_iter().collect(),
        generated_at,
    })
}

fn parse_cyclonedx(content: &str) -> Result<SbomSummary, SbomError> {
    let sbom: CycloneDxSbom =
        serde_json::from_str(content).map_err(|e| SbomError::ParseError(e.to_string()))?;

    let component_count = sbom.components.as_ref().map_or(0, |c| c.len());

    let mut licenses = std::collections::HashSet::<String>::new();
    if let Some(components) = &sbom.components {
        for comp in components {
            if let Some(lics) = &comp.licenses {
                for lic in lics {
                    if let Some(id) = lic.license.as_ref().and_then(|l| l.id.clone()) {
                        licenses.insert(id);
                    }
                    if let Some(name) = lic.license.as_ref().and_then(|l| l.name.clone()) {
                        licenses.insert(name);
                    }
                }
            }
        }
    }

    let generated_at = sbom
        .metadata
        .as_ref()
        .and_then(|m| m.timestamp.as_ref())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    Ok(SbomSummary {
        format: "cyclonedx-json".into(),
        component_count,
        license_summary: licenses.into_iter().collect(),
        generated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_sbom(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parse_spdx_sbom() {
        let json = r#"{
            "spdxVersion": "SPDX-2.3",
            "documentName": "grok-build",
            "creationInfo": {
                "created": "2026-08-05T12:00:00Z",
                "creators": ["Tool: anchore/sbom-action"]
            },
            "packages": [
                {"name": "tokio", "versionInfo": "1.0", "licenseDeclared": "MIT"},
                {"name": "serde", "versionInfo": "1.0", "licenseDeclared": "MIT OR Apache-2.0"},
                {"name": "ring", "versionInfo": "0.17", "licenseConcluded": "ISC"}
            ]
        }"#;
        let f = temp_sbom(json);
        let summary = parse_sbom(f.path()).unwrap();
        assert_eq!(summary.format, "spdx-json");
        assert_eq!(summary.component_count, 3);
        assert!(summary.license_summary.contains(&"MIT".to_string()));
        assert!(summary.generated_at.is_some());
    }

    #[test]
    fn parse_cyclonedx_sbom() {
        let json = r#"{
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "metadata": {"timestamp": "2026-08-05T12:00:00Z"},
            "components": [
                {
                    "name": "tokio",
                    "version": "1.0",
                    "licenses": [{"license": {"id": "MIT"}}]
                }
            ]
        }"#;
        let f = temp_sbom(json);
        let summary = parse_sbom(f.path()).unwrap();
        assert_eq!(summary.format, "cyclonedx-json");
        assert_eq!(summary.component_count, 1);
    }

    #[test]
    fn missing_file_returns_error() {
        assert!(parse_sbom(Path::new("/nonexistent/sbom.json")).is_err());
    }

    #[test]
    fn unknown_format_returns_error() {
        let f = temp_sbom(r#"{"unknown": true}"#);
        assert!(parse_sbom(f.path()).is_err());
    }
}

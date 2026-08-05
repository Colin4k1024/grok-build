//! Rekor transparency log client.
//!
//! Queries the [Rekor](https://docs.sigstore.dev/logging/overview/) public
//! transparency log to verify that a given artifact digest was logged.

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::report::RekorLogEntry;

/// Default Rekor server URL.
pub const DEFAULT_REKOR_URL: &str = "https://rekor.sigstore.dev";

/// Errors from Rekor queries.
#[derive(Debug, thiserror::Error)]
pub enum RekorError {
    #[error("HTTP error: {0}")]
    Http(String),

    #[error("entry not found for digest {0}")]
    EntryNotFound(String),

    #[error("parse error: {0}")]
    Parse(String),
}

/// A Rekor transparency log client.
#[derive(Debug, Clone)]
pub struct RekorClient {
    base_url: String,
    http: reqwest::Client,
}

impl RekorClient {
    /// Create a new client pointing at the default public Rekor instance.
    pub fn new() -> Self {
        Self {
            base_url: DEFAULT_REKOR_URL.into(),
            http: reqwest::Client::new(),
        }
    }

    /// Create a client with a custom Rekor URL (for enterprise deployments).
    pub fn with_url(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }

    /// Look up a log entry by SHA-256 digest.
    ///
    /// The digest should be the hex-encoded SHA-256 of the artifact.
    pub async fn lookup_by_digest(&self, sha256_digest: &str) -> Result<RekorLogEntry, RekorError> {
        let url = format!("{}/api/v1/log/entries/retrieve", self.base_url);

        let body = serde_json::json!({
            "hash": format!("sha256:{sha256_digest}")
        });

        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| RekorError::Http(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(RekorError::EntryNotFound(sha256_digest.into()));
        }

        if !resp.status().is_success() {
            return Err(RekorError::Http(format!(
                "Rekor returned {}",
                resp.status()
            )));
        }

        let entries: Vec<RekorEntryResponse> = resp
            .json()
            .await
            .map_err(|e| RekorError::Parse(e.to_string()))?;

        let entry = entries
            .into_iter()
            .next()
            .ok_or_else(|| RekorError::EntryNotFound(sha256_digest.into()))?;

        Ok(RekorLogEntry {
            log_index: entry.log_index,
            integrated_time: DateTime::from_timestamp(entry.integrated_time, 0).unwrap_or_default(),
            uuid: entry.uuid,
            body: entry.body,
        })
    }
}

impl Default for RekorClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Rekor API response for a log entry.
#[derive(Debug, Clone, Deserialize)]
struct RekorEntryResponse {
    #[serde(rename = "logIndex")]
    log_index: u64,
    #[serde(rename = "integratedTime")]
    integrated_time: i64,
    uuid: String,
    body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_url() {
        let client = RekorClient::new();
        assert_eq!(client.base_url, "https://rekor.sigstore.dev");
    }

    #[test]
    fn custom_url() {
        let client = RekorClient::with_url("https://private-rekor.example.com");
        assert_eq!(client.base_url, "https://private-rekor.example.com");
    }
}

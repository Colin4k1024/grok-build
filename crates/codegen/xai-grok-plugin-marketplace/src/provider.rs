//! Multi-marketplace provider abstraction.
//!
//! Each provider can search, fetch manifests, and download plugins from a
//! specific marketplace backend (xAI official, Bedrock, Claude Code compat,
//! or local workspace).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::MarketplaceEntry;

/// Summary returned by a marketplace search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    pub downloads: Option<u64>,
}

/// Full plugin manifest from a marketplace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    pub marketplace: String,
    pub tools: Vec<ToolDefinition>,
    pub permissions: Vec<String>,
    pub min_grok_version: Option<String>,
}

/// A tool declared in a plugin manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Errors specific to marketplace provider operations.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("plugin not found: {0}")]
    NotFound(String),
    #[error("manifest parse error: {0}")]
    ManifestParse(String),
    #[error("download failed: {0}")]
    Download(String),
    #[error("provider unavailable: {0}")]
    Unavailable(String),
}

/// Trait for marketplace backends. Each implementation knows how to talk to
/// one kind of plugin registry (git-based, HTTP API, local FS).
pub trait MarketplaceProvider: Send + Sync {
    fn name(&self) -> &str;
    fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<PluginSummary>, ProviderError>> + Send + '_>,
    >;
    fn get_manifest(
        &self,
        plugin_id: &str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<PluginManifest, ProviderError>> + Send + '_,
        >,
    >;
    fn download(
        &self,
        plugin_id: &str,
        dest: &Path,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), ProviderError>> + Send + '_>,
    >;
}

/// The xAI official marketplace (git-backed, uses the local clone).
#[derive(Debug)]
pub struct XaiMarketplaceProvider {
    pub cache_dir: std::path::PathBuf,
}

impl MarketplaceProvider for XaiMarketplaceProvider {
    fn name(&self) -> &str {
        "xAI Official"
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<PluginSummary>, ProviderError>> + Send + '_>,
    > {
        let query = query.to_lowercase();
        let limit = limit;
        Box::pin(async move {
            let scan = crate::scan_marketplace(&self.cache_dir);
            let results: Vec<PluginSummary> = scan
                .entries
                .into_iter()
                .filter(|e| {
                    e.name.to_lowercase().contains(&query)
                        || e.description
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&query)
                        || e.tags.iter().any(|t| t.to_lowercase().contains(&query))
                })
                .take(limit)
                .map(|e| entry_to_summary(&e))
                .collect();
            Ok(results)
        })
    }

    fn get_manifest(
        &self,
        plugin_id: &str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<PluginManifest, ProviderError>> + Send + '_>,
    > {
        let plugin_id = plugin_id.to_string();
        Box::pin(async move {
            let scan = crate::scan_marketplace(&self.cache_dir);
            let entry = scan
                .entries
                .into_iter()
                .find(|e| e.name == plugin_id)
                .ok_or_else(|| ProviderError::NotFound(plugin_id.clone()))?;
            Ok(entry_to_manifest(&entry))
        })
    }

    fn download(
        &self,
        plugin_id: &str,
        dest: &Path,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), ProviderError>> + Send + '_>,
    > {
        let plugin_id = plugin_id.to_string();
        let dest = dest.to_path_buf();
        Box::pin(async move {
            let scan = crate::scan_marketplace(&self.cache_dir);
            let entry = scan
                .entries
                .into_iter()
                .find(|e| e.name == plugin_id)
                .ok_or_else(|| ProviderError::NotFound(plugin_id.clone()))?;
            let src = self.cache_dir.join(&entry.relative_path);
            copy_dir_recursive(&src, &dest)
                .map_err(|e| ProviderError::Download(format!("copy failed: {e}")))?;
            Ok(())
        })
    }
}

/// Local workspace plugins (discovered from `.grok/plugins/` or similar).
#[derive(Debug)]
pub struct LocalMarketplaceProvider {
    pub workspace_root: std::path::PathBuf,
}

impl MarketplaceProvider for LocalMarketplaceProvider {
    fn name(&self) -> &str {
        "Local Workspace"
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<PluginSummary>, ProviderError>> + Send + '_>,
    > {
        let query = query.to_lowercase();
        let limit = limit;
        Box::pin(async move {
            let plugins_dir = self.workspace_root.join(".grok").join("plugins");
            if !plugins_dir.exists() {
                return Ok(Vec::new());
            }
            let scan = crate::scan_marketplace(&plugins_dir);
            let results: Vec<PluginSummary> = scan
                .entries
                .into_iter()
                .filter(|e| e.name.to_lowercase().contains(&query))
                .take(limit)
                .map(|e| entry_to_summary(&e))
                .collect();
            Ok(results)
        })
    }

    fn get_manifest(
        &self,
        plugin_id: &str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<PluginManifest, ProviderError>> + Send + '_>,
    > {
        let plugin_id = plugin_id.to_string();
        Box::pin(async move {
            let plugins_dir = self.workspace_root.join(".grok").join("plugins");
            let scan = crate::scan_marketplace(&plugins_dir);
            let entry = scan
                .entries
                .into_iter()
                .find(|e| e.name == plugin_id)
                .ok_or_else(|| ProviderError::NotFound(plugin_id.clone()))?;
            Ok(entry_to_manifest(&entry))
        })
    }

    fn download(
        &self,
        _plugin_id: &str,
        _dest: &Path,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), ProviderError>> + Send + '_>,
    > {
        Box::pin(async move {
            Err(ProviderError::Unavailable(
                "local plugins are already on-disk, no download needed".into(),
            ))
        })
    }
}

/// Registry that aggregates multiple marketplace providers and searches across
/// all of them.
#[derive(Default)]
pub struct ProviderRegistry {
    providers: Vec<Box<dyn MarketplaceProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, provider: Box<dyn MarketplaceProvider>) {
        self.providers.push(provider);
    }

    pub fn provider_names(&self) -> Vec<&str> {
        self.providers.iter().map(|p| p.name()).collect()
    }

    pub async fn search_all(
        &self,
        query: &str,
        limit_per_provider: usize,
    ) -> Vec<(String, Result<Vec<PluginSummary>, ProviderError>)> {
        let mut results = Vec::new();
        for provider in &self.providers {
            let result = provider.search(query, limit_per_provider).await;
            results.push((provider.name().to_string(), result));
        }
        results
    }
}

impl std::fmt::Debug for ProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderRegistry")
            .field("provider_count", &self.providers.len())
            .field("providers", &self.provider_names())
            .finish()
    }
}

fn entry_to_summary(entry: &MarketplaceEntry) -> PluginSummary {
    PluginSummary {
        id: entry.name.clone(),
        name: entry.name.clone(),
        version: entry.version.clone().unwrap_or_else(|| "0.0.0".into()),
        description: entry.description.clone().unwrap_or_default(),
        author: entry.author.clone(),
        downloads: None,
    }
}

fn entry_to_manifest(entry: &MarketplaceEntry) -> PluginManifest {
    PluginManifest {
        name: entry.name.clone(),
        version: entry.version.clone().unwrap_or_else(|| "0.0.0".into()),
        description: entry.description.clone().unwrap_or_default(),
        author: entry.author.clone(),
        marketplace: "xai".into(),
        tools: Vec::new(),
        permissions: Vec::new(),
        min_grok_version: None,
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_registry_empty_by_default() {
        let registry = ProviderRegistry::new();
        assert!(registry.provider_names().is_empty());
    }

    #[test]
    fn provider_registry_tracks_registered_names() {
        let mut registry = ProviderRegistry::new();
        registry.register(Box::new(LocalMarketplaceProvider {
            workspace_root: std::path::PathBuf::from("/tmp/test"),
        }));
        assert_eq!(registry.provider_names(), vec!["Local Workspace"]);
    }

    #[test]
    fn plugin_summary_serde_roundtrip() {
        let summary = PluginSummary {
            id: "test-plugin".into(),
            name: "test-plugin".into(),
            version: "1.0.0".into(),
            description: "A test plugin".into(),
            author: Some("dev".into()),
            downloads: Some(42),
        };
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: PluginSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "test-plugin");
        assert_eq!(parsed.downloads, Some(42));
    }

    #[test]
    fn plugin_manifest_serde_roundtrip() {
        let manifest = PluginManifest {
            name: "my-plugin".into(),
            version: "2.0.0".into(),
            description: "Does things".into(),
            author: None,
            marketplace: "xai".into(),
            tools: vec![ToolDefinition {
                name: "my_tool".into(),
                description: "useful".into(),
                parameters: serde_json::json!({"type": "object"}),
            }],
            permissions: vec!["network".into()],
            min_grok_version: Some("0.147.0".into()),
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tools.len(), 1);
        assert_eq!(parsed.tools[0].name, "my_tool");
        assert_eq!(parsed.permissions, vec!["network"]);
    }

    #[tokio::test]
    async fn local_provider_returns_empty_for_missing_dir() {
        let provider = LocalMarketplaceProvider {
            workspace_root: std::path::PathBuf::from("/nonexistent/path"),
        };
        let result = provider.search("test", 10).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn local_provider_download_is_unavailable() {
        let provider = LocalMarketplaceProvider {
            workspace_root: std::path::PathBuf::from("/tmp"),
        };
        let result = provider
            .download("test", std::path::Path::new("/tmp/dest"))
            .await;
        assert!(matches!(result, Err(ProviderError::Unavailable(_))));
    }

    #[test]
    fn entry_to_summary_fills_defaults() {
        let entry = MarketplaceEntry {
            name: "foo".into(),
            version: None,
            description: None,
            category: None,
            author: None,
            tags: Vec::new(),
            keywords: Vec::new(),
            domains: Vec::new(),
            homepage: None,
            relative_path: "plugins/foo".into(),
            skill_count: 0,
            has_hooks: false,
            has_agents: false,
            has_mcp: false,
            remote_url: None,
            remote_ref: None,
            remote_sha: None,
            remote_subdir: None,
            components: None,
        };
        let summary = super::entry_to_summary(&entry);
        assert_eq!(summary.version, "0.0.0");
        assert_eq!(summary.description, "");
    }

    #[test]
    fn provider_registry_debug_output() {
        let registry = ProviderRegistry::new();
        let debug = format!("{registry:?}");
        assert!(debug.contains("ProviderRegistry"));
        assert!(debug.contains("provider_count: 0"));
    }
}

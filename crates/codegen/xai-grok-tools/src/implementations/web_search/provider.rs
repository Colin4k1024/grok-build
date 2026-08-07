//! Multi-provider web search abstraction.
//!
//! Each provider implements the `WebSearchProvider` trait, enabling the
//! web_search tool to dispatch to different backends (xAI Responses API,
//! DuckDuckGo, Exa neural search, etc.) based on configuration.

use serde::{Deserialize, Serialize};

/// A single search result from any provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Errors from search provider operations.
#[derive(Debug, thiserror::Error)]
pub enum SearchProviderError {
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("request failed: {0}")]
    RequestFailed(String),
    #[error("rate limited")]
    RateLimited,
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),
}

/// Trait for web search backends. Implementations handle provider-specific
/// auth, request formatting, and response parsing.
pub trait WebSearchProvider: Send + Sync {
    fn name(&self) -> &str;
    fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Vec<SearchResult>, SearchProviderError>>
                + Send
                + '_,
        >,
    >;
}

/// xAI Responses API provider (the current default).
#[derive(Debug)]
pub struct XaiSearchProvider {
    pub base_url: String,
    pub model: String,
}

impl WebSearchProvider for XaiSearchProvider {
    fn name(&self) -> &str {
        "xAI"
    }

    fn search(
        &self,
        _query: &str,
        _limit: usize,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Vec<SearchResult>, SearchProviderError>>
                + Send
                + '_,
        >,
    > {
        // Delegates to the existing WebSearchClient internally.
        // This provider is a thin adapter; the real implementation lives in client.rs.
        Box::pin(async move {
            Err(SearchProviderError::Unavailable(
                "use WebSearchClient directly for xAI provider".into(),
            ))
        })
    }
}

/// DuckDuckGo provider (privacy-focused, no API key required).
#[derive(Debug, Default)]
pub struct DuckDuckGoProvider;

impl WebSearchProvider for DuckDuckGoProvider {
    fn name(&self) -> &str {
        "DuckDuckGo"
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Vec<SearchResult>, SearchProviderError>>
                + Send
                + '_,
        >,
    > {
        let query = query.to_string();
        let limit = limit;
        Box::pin(async move {
            let url = format!(
                "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
                urlencoding::encode(&query)
            );
            let resp = reqwest::get(&url)
                .await
                .map_err(|e| SearchProviderError::RequestFailed(e.to_string()))?;
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| SearchProviderError::RequestFailed(e.to_string()))?;

            let mut results = Vec::new();

            // DDG instant answer API returns RelatedTopics
            if let Some(topics) = body.get("RelatedTopics").and_then(|v| v.as_array()) {
                for topic in topics.iter().take(limit) {
                    if let (Some(text), Some(url)) = (
                        topic.get("Text").and_then(|v| v.as_str()),
                        topic.get("FirstURL").and_then(|v| v.as_str()),
                    ) {
                        results.push(SearchResult {
                            title: text.chars().take(80).collect(),
                            url: url.to_string(),
                            snippet: text.to_string(),
                        });
                    }
                }
            }

            Ok(results)
        })
    }
}

/// Exa neural search provider (requires MCP connection or API key).
#[derive(Debug)]
pub struct ExaProvider {
    pub api_key: String,
}

impl WebSearchProvider for ExaProvider {
    fn name(&self) -> &str {
        "Exa"
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Vec<SearchResult>, SearchProviderError>>
                + Send
                + '_,
        >,
    > {
        let query = query.to_string();
        let limit = limit;
        let api_key = self.api_key.clone();
        Box::pin(async move {
            let client = reqwest::Client::new();
            let resp = client
                .post("https://api.exa.ai/search")
                .header("x-api-key", &api_key)
                .json(&serde_json::json!({
                    "query": query,
                    "numResults": limit,
                    "type": "neural",
                }))
                .send()
                .await
                .map_err(|e| SearchProviderError::RequestFailed(e.to_string()))?;

            if resp.status() == 429 {
                return Err(SearchProviderError::RateLimited);
            }

            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| SearchProviderError::RequestFailed(e.to_string()))?;

            let mut results = Vec::new();
            if let Some(items) = body.get("results").and_then(|v| v.as_array()) {
                for item in items.iter().take(limit) {
                    let title = item
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let url = item
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let snippet = item
                        .get("text")
                        .or_else(|| item.get("highlights"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    results.push(SearchResult {
                        title,
                        url,
                        snippet,
                    });
                }
            }

            Ok(results)
        })
    }
}

/// Registry that selects the active search provider based on configuration.
pub struct SearchProviderRegistry {
    providers: Vec<Box<dyn WebSearchProvider>>,
    active_index: usize,
}

impl SearchProviderRegistry {
    pub fn new(providers: Vec<Box<dyn WebSearchProvider>>) -> Self {
        Self {
            providers,
            active_index: 0,
        }
    }

    pub fn active_provider(&self) -> Option<&dyn WebSearchProvider> {
        self.providers.get(self.active_index).map(|p| p.as_ref())
    }

    pub fn set_active(&mut self, name: &str) -> bool {
        if let Some(idx) = self.providers.iter().position(|p| p.name() == name) {
            self.active_index = idx;
            true
        } else {
            false
        }
    }

    pub fn provider_names(&self) -> Vec<&str> {
        self.providers.iter().map(|p| p.name()).collect()
    }
}

impl std::fmt::Debug for SearchProviderRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchProviderRegistry")
            .field("active", &self.active_provider().map(|p| p.name()))
            .field("providers", &self.provider_names())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_result_serde_roundtrip() {
        let result = SearchResult {
            title: "Rust programming".into(),
            url: "https://rust-lang.org".into(),
            snippet: "A systems programming language".into(),
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: SearchResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.title, "Rust programming");
        assert_eq!(parsed.url, "https://rust-lang.org");
    }

    #[test]
    fn registry_selects_active_provider() {
        let providers: Vec<Box<dyn WebSearchProvider>> = vec![
            Box::new(DuckDuckGoProvider),
            Box::new(ExaProvider {
                api_key: "test".into(),
            }),
        ];
        let mut registry = SearchProviderRegistry::new(providers);
        assert_eq!(registry.active_provider().unwrap().name(), "DuckDuckGo");

        assert!(registry.set_active("Exa"));
        assert_eq!(registry.active_provider().unwrap().name(), "Exa");

        assert!(!registry.set_active("Nonexistent"));
        assert_eq!(registry.active_provider().unwrap().name(), "Exa");
    }

    #[test]
    fn registry_lists_provider_names() {
        let providers: Vec<Box<dyn WebSearchProvider>> = vec![
            Box::new(DuckDuckGoProvider),
            Box::new(XaiSearchProvider {
                base_url: "https://api.x.ai".into(),
                model: "grok-3".into(),
            }),
        ];
        let registry = SearchProviderRegistry::new(providers);
        assert_eq!(registry.provider_names(), vec!["DuckDuckGo", "xAI"]);
    }

    #[test]
    fn empty_registry_has_no_active() {
        let registry = SearchProviderRegistry::new(Vec::new());
        assert!(registry.active_provider().is_none());
    }

    #[test]
    fn xai_provider_name() {
        let p = XaiSearchProvider {
            base_url: "https://api.x.ai".into(),
            model: "grok-3".into(),
        };
        assert_eq!(p.name(), "xAI");
    }

    #[test]
    fn ddg_provider_name() {
        let p = DuckDuckGoProvider;
        assert_eq!(p.name(), "DuckDuckGo");
    }

    #[test]
    fn exa_provider_name() {
        let p = ExaProvider {
            api_key: "key".into(),
        };
        assert_eq!(p.name(), "Exa");
    }

    #[test]
    fn registry_debug_output() {
        let providers: Vec<Box<dyn WebSearchProvider>> =
            vec![Box::new(DuckDuckGoProvider)];
        let registry = SearchProviderRegistry::new(providers);
        let debug = format!("{registry:?}");
        assert!(debug.contains("DuckDuckGo"));
    }
}

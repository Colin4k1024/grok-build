pub mod client;
pub mod provider;
mod tool;
mod types;

pub use provider::{
    DuckDuckGoProvider, ExaProvider, SearchProviderError, SearchProviderRegistry, SearchResult,
    WebSearchProvider, XaiSearchProvider,
};
pub use types::WebSearchConfig;

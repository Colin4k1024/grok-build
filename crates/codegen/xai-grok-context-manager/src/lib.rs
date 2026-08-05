//! # xai-grok-context-manager
//!
//! Unified context management for multi-turn LLM conversations.
//!
//! Provides a `ContextManager` trait and a default implementation
//! (`DefaultContextManager`) that handles:
//!
//! - Message history with incremental token counting
//! - Pluggable compaction strategies (full, tail-keep, chunked)
//! - Context normalization (dedup, merge tool results, clean empty)
//! - Forking child contexts for sub-agents
//! - Merging child summaries back into the parent
//! - Thread-safe token caching

#![allow(unused)]

pub mod budget_allocator;
pub mod context_window;
pub mod engine;
pub mod manager;
pub mod token_cache;
pub mod types;

// Re-export the trait and key public types for convenience.
pub use manager::{CompactionAdapter, DefaultCompactionAdapter, DefaultContextManager};
pub use types::{
    CompactionReport, CompactionState, CompactionStrategy, ContentPart, ContextError,
    ContextMessage, ContextResult, ForkConfig, InheritPolicy, MessageContent, MessageId,
    MessageMetadata, MessageRole, MessageSource, NormalizeReport, SubBudgetAllocation,
    TokenBudget, TokenUsage, TurnId,
};
pub use budget_allocator::BudgetAllocator;
pub use context_window::{ContextWindow, ContextWindowManager, WindowCloseResult, WindowId};
pub use engine::{ContextPatch, IncrementalEngine, SimpleTokenEstimator, TokenEstimator};
pub use token_cache::TokenCache;

use std::ops::Range;

/// The core trait for context management.
///
/// Implementations manage a linear history of [`ContextMessage`]s with
/// budget-aware compaction, normalization, and sub-context lifecycle.
pub trait ContextManager: std::fmt::Debug + Send + Sync {
    /// Return the full message history as a read-only slice.
    fn history(&self) -> &[ContextMessage];

    /// Append a single message to the history.
    fn push(&mut self, msg: ContextMessage) -> ContextResult<()>;

    /// Replace messages in the given range with the provided messages.
    fn patch(&mut self, range: Range<usize>, msgs: Vec<ContextMessage>) -> ContextResult<()>;

    /// Return the current token usage (triggers a recount of dirty ranges).
    fn token_usage(&self) -> TokenUsage;

    /// Return the configured token budget.
    fn token_budget(&self) -> &TokenBudget;

    /// Compact the history using the given strategy, returning a report.
    fn compact(&mut self, strategy: CompactionStrategy) -> ContextResult<CompactionReport>;

    /// Normalize the history: dedup consecutive messages, merge tool results,
    /// and clean empty messages.
    fn normalize(&mut self) -> ContextResult<NormalizeReport>;

    /// Fork a child context from this one.
    fn fork(&self, config: ForkConfig) -> ContextResult<Box<dyn ContextManager>>;

    /// Merge a child context's summary into this context.
    ///
    /// `max_tokens` is the maximum tokens allowed for the summary injection.
    fn merge_summary(
        &mut self,
        child: &dyn ContextManager,
        max_tokens: usize,
    ) -> ContextResult<()>;
}

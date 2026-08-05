//! Default implementation of the `ContextManager` trait.

use std::ops::Range;

use tracing::debug;

use crate::engine::{ContextPatch, IncrementalEngine, SimpleTokenEstimator, TokenEstimator};
use crate::types::{
    CompactionReport, CompactionState, CompactionStrategy, ContextError,
    ContextMessage, ContextResult, ForkConfig, InheritPolicy, MessageContent, MessageId,
    MessageMetadata, MessageRole, MessageSource, NormalizeReport, TokenBudget, TokenUsage,
};
use crate::ContextManager;

// ---------------------------------------------------------------------------
// Compaction adapter
// ---------------------------------------------------------------------------

/// Trait for pluggable compaction backends.
///
/// The default implementation uses a simple text concatenation strategy;
/// users can provide a custom adapter that calls an LLM to produce summaries.
pub trait CompactionAdapter: std::fmt::Debug + Send + Sync {
    /// Produce a summary for the given messages.
    fn compact_messages(&self, messages: &[ContextMessage]) -> ContextResult<ContextMessage>;
}

/// Default compaction adapter: concatenates text content and wraps in a single
/// Compaction message.
#[derive(Debug, Clone)]
pub struct DefaultCompactionAdapter;

impl CompactionAdapter for DefaultCompactionAdapter {
    fn compact_messages(&self, messages: &[ContextMessage]) -> ContextResult<ContextMessage> {
        let mut parts = Vec::new();
        for msg in messages {
            let text = extract_text(&msg.content);
            if !text.is_empty() {
                parts.push(format!("[{:?}] {}", msg.role, text));
            }
        }
        let summary = if parts.is_empty() {
            "(empty context)".to_string()
        } else {
            parts.join("\n")
        };
        Ok(ContextMessage {
            id: MessageId::new(),
            role: MessageRole::Compaction,
            content: MessageContent::Text(summary),
            token_count: None,
            metadata: MessageMetadata {
                source: MessageSource::Compaction,
                is_compacted: true,
                ..MessageMetadata::default()
            },
            compaction_state: CompactionState::Uncompacted,
        })
    }
}

// ---------------------------------------------------------------------------
// DefaultContextManager
// ---------------------------------------------------------------------------

/// The default implementation of [`ContextManager`].
#[derive(Debug)]
pub struct DefaultContextManager {
    history: Vec<ContextMessage>,
    engine: IncrementalEngine,
    budget: TokenBudget,
    compaction_adapter: Box<dyn CompactionAdapter>,
}

impl DefaultContextManager {
    /// Create a new manager with the default budget and compaction adapter.
    pub fn new(budget: TokenBudget) -> Self {
        Self {
            history: Vec::new(),
            engine: IncrementalEngine::new(SimpleTokenEstimator),
            budget,
            compaction_adapter: Box::new(DefaultCompactionAdapter),
        }
    }

    /// Create a new manager with a custom compaction adapter.
    pub fn with_adapter(
        budget: TokenBudget,
        adapter: impl CompactionAdapter + 'static,
    ) -> Self {
        Self {
            history: Vec::new(),
            engine: IncrementalEngine::new(SimpleTokenEstimator),
            budget,
            compaction_adapter: Box::new(adapter),
        }
    }

    /// The number of messages in the history.
    pub fn len(&self) -> usize {
        self.history.len()
    }

    /// Whether the history is empty.
    pub fn is_empty(&self) -> bool {
        self.history.is_empty()
    }

    /// Compute token usage with a full recount.
    fn compute_usage(&mut self) -> TokenUsage {
        let total = self.engine.recount_dirty(&self.history);
        let mut by_role = std::collections::HashMap::new();
        for msg in &self.history {
            let role_key = format!("{:?}", msg.role);
            let tokens = self
                .engine
                .token_cache
                .get(&msg.id)
                .unwrap_or(0);
            *by_role.entry(role_key).or_insert(0usize) += tokens;
        }
        let compacted_tokens: usize = self
            .history
            .iter()
            .filter(|m| matches!(m.compaction_state, CompactionState::Compacted { .. }))
            .filter_map(|m| self.engine.token_cache.get(&m.id))
            .sum();
        let summary_tokens: usize = self
            .history
            .iter()
            .filter(|m| matches!(m.role, MessageRole::Compaction))
            .filter_map(|m| self.engine.token_cache.get(&m.id))
            .sum();
        TokenUsage {
            total,
            by_role,
            compacted_tokens,
            summary_tokens,
        }
    }
}

impl ContextManager for DefaultContextManager {
    fn history(&self) -> &[ContextMessage] {
        &self.history
    }

    fn push(&mut self, msg: ContextMessage) -> ContextResult<()> {
        self.engine
            .apply_patch(&ContextPatch::Append(vec![msg]), &mut self.history)?;
        Ok(())
    }

    fn patch(&mut self, range: Range<usize>, msgs: Vec<ContextMessage>) -> ContextResult<()> {
        let len = self.history.len();
        if range.end > len {
            return Err(ContextError::PatchRangeExceeded {
                start: range.start,
                end: range.end,
                len,
            });
        }
        self.engine.apply_patch(
            &ContextPatch::Replace {
                range,
                messages: msgs,
            },
            &mut self.history,
        )?;
        Ok(())
    }

    fn token_usage(&self) -> TokenUsage {
        // Compute usage without mutating self: read from the cache or
        // estimate on the fly.  The mutable methods (push, patch, compact,
        // normalize) are responsible for keeping the cache up to date.
        let mut total = 0usize;
        let mut by_role = std::collections::HashMap::new();
        for msg in &self.history {
            let role_key = format!("{:?}", msg.role);
            let tokens = self
                .engine
                .token_cache
                .get(&msg.id)
                .unwrap_or_else(|| self.engine.token_estimator.estimate_message(msg));
            total += tokens;
            *by_role.entry(role_key).or_insert(0usize) += tokens;
        }
        let compacted_tokens: usize = self
            .history
            .iter()
            .filter(|m| matches!(m.compaction_state, CompactionState::Compacted { .. }))
            .filter_map(|m| self.engine.token_cache.get(&m.id))
            .sum();
        let summary_tokens: usize = self
            .history
            .iter()
            .filter(|m| matches!(m.role, MessageRole::Compaction))
            .filter_map(|m| self.engine.token_cache.get(&m.id))
            .sum();
        TokenUsage {
            total,
            by_role,
            compacted_tokens,
            summary_tokens,
        }
    }

    fn token_budget(&self) -> &TokenBudget {
        &self.budget
    }

    fn compact(&mut self, strategy: CompactionStrategy) -> ContextResult<CompactionReport> {
        let messages_before = self.history.len();
        let tokens_before = self.engine.total_tokens(&self.history);

        match strategy {
            CompactionStrategy::FullReplace => {
                if self.history.is_empty() {
                    return Ok(CompactionReport {
                        messages_before: 0,
                        messages_after: 0,
                        tokens_freed: 0,
                        compacted_count: 0,
                    });
                }
                let range = 0..self.history.len();
                let count = range.len();
                let summary = self.compaction_adapter.compact_messages(&self.history)?;
                self.engine.apply_patch(
                    &ContextPatch::Compact {
                        range,
                        summary_message: summary,
                    },
                    &mut self.history,
                )?;
                let tokens_after = self.engine.total_tokens(&self.history);
                Ok(CompactionReport {
                    messages_before,
                    messages_after: self.history.len(),
                    tokens_freed: tokens_before.saturating_sub(tokens_after),
                    compacted_count: count,
                })
            }
            CompactionStrategy::TailKeep { keep_n } => {
                if self.history.len() <= keep_n {
                    // Nothing to compact.
                    return Ok(CompactionReport {
                        messages_before,
                        messages_after: messages_before,
                        tokens_freed: 0,
                        compacted_count: 0,
                    });
                }
                let split = self.history.len() - keep_n;
                let range = 0..split;
                let count = range.len();
                let to_compact = &self.history[range.clone()];
                let summary = self.compaction_adapter.compact_messages(to_compact)?;
                self.engine.apply_patch(
                    &ContextPatch::Compact {
                        range,
                        summary_message: summary,
                    },
                    &mut self.history,
                )?;
                let tokens_after = self.engine.total_tokens(&self.history);
                Ok(CompactionReport {
                    messages_before,
                    messages_after: self.history.len(),
                    tokens_freed: tokens_before.saturating_sub(tokens_after),
                    compacted_count: count,
                })
            }
            CompactionStrategy::Chunked { chunk_size } => {
                if self.history.is_empty() || chunk_size == 0 {
                    return Ok(CompactionReport {
                        messages_before,
                        messages_after: messages_before,
                        tokens_freed: 0,
                        compacted_count: 0,
                    });
                }
                let mut total_compacted = 0usize;
                // Process chunks from the end backwards to keep indices stable.
                let mut end = self.history.len();
                while end >= chunk_size {
                    let start = end - chunk_size;
                    let range = start..end;
                    let summary = self.compaction_adapter.compact_messages(&self.history[range.clone()])?;
                    self.engine.apply_patch(
                        &ContextPatch::Compact {
                            range,
                            summary_message: summary,
                        },
                        &mut self.history,
                    )?;
                    total_compacted += chunk_size;
                    // After compaction, the history shrank.
                    end = self.history.len();
                }
                let tokens_after = self.engine.total_tokens(&self.history);
                Ok(CompactionReport {
                    messages_before,
                    messages_after: self.history.len(),
                    tokens_freed: tokens_before.saturating_sub(tokens_after),
                    compacted_count: total_compacted,
                })
            }
        }
    }

    fn normalize(&mut self) -> ContextResult<NormalizeReport> {
        let mut report = NormalizeReport::default();

        // Pass 1: Remove empty messages.
        let original_len = self.history.len();
        self.history.retain(|msg| match &msg.content {
            MessageContent::Text(s) => !s.is_empty(),
            MessageContent::Structured(v) => !v.is_null(),
            MessageContent::Multipart(parts) => !parts.is_empty(),
        });
        report.empties_cleaned = original_len - self.history.len();

        // Pass 2: Dedup consecutive identical messages.
        let mut deduped = Vec::with_capacity(self.history.len());
        for msg in self.history.drain(..) {
            if let Some(last) = deduped.last() {
                if messages_content_equal(last, &msg) {
                    report.duplicates_removed += 1;
                    continue;
                }
            }
            deduped.push(msg);
        }
        self.history = deduped;

        // Pass 3: Merge consecutive tool result messages with the same call_id.
        let mut merged: Vec<ContextMessage> = Vec::with_capacity(self.history.len());
        for msg in self.history.drain(..) {
            if let MessageRole::Tool { call_id } = &msg.role {
                if let Some(last) = merged.last_mut() {
                    if let MessageRole::Tool {
                        call_id: last_call_id,
                    } = &last.role
                    {
                        if *last_call_id == *call_id {
                            // Merge the content.
                            let combined = merge_tool_content(&last.content, &msg.content);
                            last.content = combined;
                            report.tool_results_merged += 1;
                            continue;
                        }
                    }
                }
            }
            merged.push(msg);
        }
        self.history = merged;

        // Rebuild index after normalize.
        self.engine.rebuild_index(&self.history);
        self.engine.token_cache.clear();
        self.engine.mark_dirty(0..self.history.len());

        Ok(report)
    }

    fn fork(&self, config: ForkConfig) -> ContextResult<Box<dyn ContextManager>> {
        let mut child = DefaultContextManager::new(TokenBudget {
            max_total: config
                .max_tokens
                .unwrap_or(self.budget.sub_budget.child_max_ratio as usize * self.budget.max_total),
            ..self.budget.clone()
        });

        let messages = match &config.inherit_policy {
            InheritPolicy::Full => self.history.clone(),
            InheritPolicy::TailOnly { n } => {
                let start = self.history.len().saturating_sub(*n);
                self.history[start..].to_vec()
            }
            InheritPolicy::None => Vec::new(),
        };

        for mut msg in messages {
            if let Some(ref turn_id) = config.turn_id {
                msg.metadata.turn_id = Some(turn_id.clone());
            }
            child.history.push(msg);
        }

        child.engine.rebuild_index(&child.history);
        child.engine.mark_dirty(0..child.history.len());

        debug!(
            parent_len = self.history.len(),
            child_len = child.history.len(),
            "forked context"
        );

        Ok(Box::new(child))
    }

    fn merge_summary(
        &mut self,
        child: &dyn ContextManager,
        max_tokens: usize,
    ) -> ContextResult<()> {
        let child_history = child.history();
        if child_history.is_empty() {
            return Ok(());
        }

        // Estimate tokens for the child summary.
        let child_tokens = child.token_usage().total;
        if child_tokens > max_tokens {
            return Err(ContextError::TokenBudgetExceeded {
                used: child_tokens,
                max: max_tokens,
            });
        }

        // Create a summary message from the child's history.
        let summary_text = child_history
            .iter()
            .filter_map(|msg| {
                let text = extract_text(&msg.content);
                if text.is_empty() {
                    None
                } else {
                    Some(format!("[{:?}] {}", msg.role, text))
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        let summary_msg = ContextMessage {
            id: MessageId::new(),
            role: MessageRole::Compaction,
            content: MessageContent::Text(summary_text),
            token_count: None,
            metadata: MessageMetadata {
                source: MessageSource::Subagent,
                is_compacted: true,
                ..MessageMetadata::default()
            },
            compaction_state: CompactionState::Uncompacted,
        };

        self.engine
            .apply_patch(&ContextPatch::Append(vec![summary_msg]), &mut self.history)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract plain text from a content variant.
fn extract_text(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(s) => s.clone(),
        MessageContent::Structured(v) => serde_json::to_string(v).unwrap_or_default(),
        MessageContent::Multipart(parts) => parts
            .iter()
            .filter_map(|p| match p {
                crate::types::ContentPart::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

/// Check if two messages have identical content.
fn messages_content_equal(a: &ContextMessage, b: &ContextMessage) -> bool {
    a.role == b.role && a.content == b.content
}

/// Merge two tool content payloads.
fn merge_tool_content(a: &MessageContent, b: &MessageContent) -> MessageContent {
    let a_text = extract_text(a);
    let b_text = extract_text(b);
    MessageContent::Text(format!("{a_text}\n{b_text}"))
}

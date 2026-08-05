//! Incremental indexing engine and token estimation.

use std::collections::HashMap;

use crate::token_cache::TokenCache;
use crate::types::{ContextMessage, ContextResult, MessageContent, MessageId};

// ---------------------------------------------------------------------------
// Token estimator
// ---------------------------------------------------------------------------

/// Trait for pluggable token estimation strategies.
pub trait TokenEstimator: std::fmt::Debug + Send + Sync {
    /// Estimate the token count for a piece of text.
    fn estimate_text(&self, text: &str) -> usize;

    /// Estimate the token count for a JSON value.
    fn estimate_json(&self, value: &serde_json::Value) -> usize {
        self.estimate_text(&value.to_string())
    }

    /// Estimate the token count for a context message.
    fn estimate_message(&self, msg: &ContextMessage) -> usize {
        match &msg.content {
            MessageContent::Text(text) => self.estimate_text(text),
            MessageContent::Structured(val) => self.estimate_json(val),
            MessageContent::Multipart(parts) => parts
                .iter()
                .map(|part| match part {
                    crate::types::ContentPart::Text { content } => self.estimate_text(content),
                    crate::types::ContentPart::Image { data, .. } => {
                        // Rough heuristic: 1 token per 4 bytes of image data.
                        data.len() / 4
                    }
                })
                .sum(),
        }
    }
}

/// A simple token estimator: `text.len() / 4` (approximation for English text).
#[derive(Debug, Clone, Copy)]
pub struct SimpleTokenEstimator;

impl TokenEstimator for SimpleTokenEstimator {
    fn estimate_text(&self, text: &str) -> usize {
        // Minimum 1 token for non-empty text.
        let raw = text.len() / 4;
        if text.is_empty() { 0 } else { raw.max(1) }
    }
}

// ---------------------------------------------------------------------------
// Context patch
// ---------------------------------------------------------------------------

/// Describes a mutation to apply to the context history.
#[derive(Debug, Clone)]
pub enum ContextPatch {
    /// Append new messages to the end.
    Append(Vec<ContextMessage>),
    /// Replace messages in the given range with the provided messages.
    Replace {
        range: std::ops::Range<usize>,
        messages: Vec<ContextMessage>,
    },
    /// Remove messages in the given range.
    Remove(std::ops::Range<usize>),
    /// Mark messages in the given range as compacted.
    Compact {
        range: std::ops::Range<usize>,
        summary_message: ContextMessage,
    },
}

// ---------------------------------------------------------------------------
// Incremental engine
// ---------------------------------------------------------------------------

/// Maintains an index from `MessageId` → position in the history vector,
/// a set of dirty ranges, and a token cache.
#[derive(Debug)]
pub struct IncrementalEngine {
    /// Reverse index: message ID → current position in the history.
    pub(crate) index: HashMap<MessageId, usize>,
    /// Ranges that need token re-counting.
    pub(crate) dirty_ranges: Vec<std::ops::Range<usize>>,
    /// Token estimation cache.
    pub(crate) token_cache: TokenCache,
    /// The token estimator in use.
    pub(crate) token_estimator: Box<dyn TokenEstimator>,
}

impl IncrementalEngine {
    /// Create a new engine with the given token estimator.
    pub fn new(estimator: impl TokenEstimator + 'static) -> Self {
        Self {
            index: HashMap::new(),
            dirty_ranges: Vec::new(),
            token_cache: TokenCache::new(),
            token_estimator: Box::new(estimator),
        }
    }

    /// Rebuild the entire index from the current history slice.
    pub fn rebuild_index(&mut self, messages: &[ContextMessage]) {
        self.index.clear();
        for (i, msg) in messages.iter().enumerate() {
            self.index.insert(msg.id.clone(), i);
        }
        self.dirty_ranges.clear();
    }

    /// Mark a range as dirty so that its token counts will be re-estimated.
    pub fn mark_dirty(&mut self, range: std::ops::Range<usize>) {
        self.dirty_ranges.push(range);
    }

    /// Apply a patch to the history, updating the index and dirty tracking.
    ///
    /// Returns the new messages (if any) that were inserted, so the caller
    /// can splice them into the history vector.
    pub fn apply_patch(
        &mut self,
        patch: &ContextPatch,
        history: &mut Vec<ContextMessage>,
    ) -> ContextResult<()> {
        match patch {
            ContextPatch::Append(msgs) => {
                let start = history.len();
                for (offset, msg) in msgs.iter().enumerate() {
                    self.index.insert(msg.id.clone(), start + offset);
                }
                history.extend(msgs.iter().cloned());
                self.mark_dirty(start..history.len());
            }
            ContextPatch::Replace { range, messages } => {
                let len = history.len();
                if range.end > len {
                    return Err(crate::types::ContextError::PatchRangeExceeded {
                        start: range.start,
                        end: range.end,
                        len,
                    });
                }
                // Remove old entries from the index.
                for i in range.clone() {
                    self.index.remove(&history[i].id);
                }
                // Replace in the history.
                let replacement: Vec<ContextMessage> = messages.iter().cloned().collect();
                history.splice(range.clone(), replacement.iter().cloned());
                // Re-index everything from range.start onward.
                for i in range.start..history.len() {
                    self.index.insert(history[i].id.clone(), i);
                }
                self.mark_dirty(range.start..history.len());
            }
            ContextPatch::Remove(range) => {
                let len = history.len();
                if range.end > len {
                    return Err(crate::types::ContextError::PatchRangeExceeded {
                        start: range.start,
                        end: range.end,
                        len,
                    });
                }
                // Remove old entries from the index.
                for i in range.clone() {
                    self.index.remove(&history[i].id);
                }
                history.drain(range.clone());
                // Re-index from range.start onward.
                for i in range.start..history.len() {
                    self.index.insert(history[i].id.clone(), i);
                }
                // Invalidate cache entries in the removed range.
                self.token_cache.clear();
                if range.start < history.len() {
                    self.mark_dirty(range.start..history.len());
                }
            }
            ContextPatch::Compact {
                range,
                summary_message,
            } => {
                let len = history.len();
                if range.end > len {
                    return Err(crate::types::ContextError::PatchRangeExceeded {
                        start: range.start,
                        end: range.end,
                        len,
                    });
                }
                // Remove old entries from the index.
                for i in range.clone() {
                    self.index.remove(&history[i].id);
                }
                // Replace the range with the summary message.
                let replacement = std::iter::once(summary_message.clone());
                history.splice(range.clone(), replacement);
                // Re-index from range.start onward.
                for i in range.start..history.len() {
                    self.index.insert(history[i].id.clone(), i);
                }
                // Invalidate and re-count.
                self.token_cache.clear();
                self.mark_dirty(range.start..history.len());
            }
        }
        Ok(())
    }

    /// Recount tokens for all dirty ranges.
    ///
    /// Returns the total token count across the entire history.
    pub fn recount_dirty(&mut self, messages: &[ContextMessage]) -> usize {
        let estimator = &self.token_estimator;
        for range in self.dirty_ranges.drain(..) {
            for i in range {
                if i < messages.len() {
                    let msg = &messages[i];
                    let tokens = match msg.token_count {
                        Some(t) => t,
                        None => estimator.estimate_message(msg),
                    };
                    self.token_cache
                        .insert(msg.id.clone(), tokens, estimate_content_bytes(msg));
                }
            }
        }
        self.total_tokens(messages)
    }

    /// Calculate the total tokens across all messages using the cache.
    pub fn total_tokens(&self, messages: &[ContextMessage]) -> usize {
        let estimator = &self.token_estimator;
        let mut total = 0usize;
        for msg in messages {
            let tokens = self.token_cache.get(&msg.id).unwrap_or_else(|| {
                // Cache miss — estimate on the fly (caller should call recount_dirty first).
                estimator.estimate_message(msg)
            });
            total += tokens;
        }
        total
    }

    /// Look up the position of a message by ID.
    pub fn position_of(&self, id: &MessageId) -> Option<usize> {
        self.index.get(id).copied()
    }
}

/// Estimate the byte size of a message's content for cache memory tracking.
fn estimate_content_bytes(msg: &ContextMessage) -> usize {
    match &msg.content {
        MessageContent::Text(s) => s.len(),
        MessageContent::Structured(v) => v.to_string().len(),
        MessageContent::Multipart(parts) => parts
            .iter()
            .map(|p| match p {
                crate::types::ContentPart::Text { content } => content.len(),
                crate::types::ContentPart::Image { data, .. } => data.len(),
            })
            .sum(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MessageMetadata, MessageRole, MessageSource};

    fn make_msg(text: &str) -> ContextMessage {
        ContextMessage {
            id: MessageId::new(),
            role: MessageRole::User,
            content: MessageContent::Text(text.to_string()),
            token_count: None,
            metadata: MessageMetadata {
                source: MessageSource::UserInput,
                ..MessageMetadata::default()
            },
            compaction_state: crate::types::CompactionState::Uncompacted,
        }
    }

    #[test]
    fn test_engine_append_and_total() {
        let mut engine = IncrementalEngine::new(SimpleTokenEstimator);
        let mut history = Vec::new();

        let msgs = vec![make_msg("hello"), make_msg("world")];
        engine
            .apply_patch(&ContextPatch::Append(msgs), &mut history)
            .unwrap();
        assert_eq!(history.len(), 2);
        let total = engine.recount_dirty(&history);
        assert!(total > 0);
    }

    #[test]
    fn test_engine_replace() {
        let mut engine = IncrementalEngine::new(SimpleTokenEstimator);
        let mut history = Vec::new();

        let msgs = vec![make_msg("a"), make_msg("b"), make_msg("c")];
        engine
            .apply_patch(&ContextPatch::Append(msgs), &mut history)
            .unwrap();

        let replace_patch = ContextPatch::Replace {
            range: 1..3,
            messages: vec![make_msg("x")],
        };
        engine
            .apply_patch(&replace_patch, &mut history)
            .unwrap();
        assert_eq!(history.len(), 2);
    }

    #[test]
    fn test_engine_remove() {
        let mut engine = IncrementalEngine::new(SimpleTokenEstimator);
        let mut history = Vec::new();

        let msgs = vec![make_msg("a"), make_msg("b"), make_msg("c")];
        engine
            .apply_patch(&ContextPatch::Append(msgs), &mut history)
            .unwrap();

        engine
            .apply_patch(&ContextPatch::Remove(0..2), &mut history)
            .unwrap();
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn test_position_of() {
        let mut engine = IncrementalEngine::new(SimpleTokenEstimator);
        let mut history = Vec::new();
        let msg = make_msg("hello");
        let id = msg.id.clone();
        engine
            .apply_patch(&ContextPatch::Append(vec![msg]), &mut history)
            .unwrap();
        assert_eq!(engine.position_of(&id), Some(0));
    }

    #[test]
    fn test_simple_estimator() {
        let est = SimpleTokenEstimator;
        assert_eq!(est.estimate_text(""), 0);
        assert_eq!(est.estimate_text("hi"), 1); // 2 bytes / 4 = 0, min 1
        assert_eq!(est.estimate_text("hello world test"), 4); // 16 bytes / 4 = 4
    }
}

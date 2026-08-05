//! Core type definitions for the context manager.

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Result alias used throughout the context manager.
pub type ContextResult<T> = Result<T, ContextError>;

/// Errors that can occur during context management operations.
#[derive(Debug, Error)]
pub enum ContextError {
    #[error("index out of bounds: {index} (len {len})")]
    IndexOutOfBounds { index: usize, len: usize },

    #[error("invalid range: start {start} > end {end}")]
    InvalidRange { start: usize, end: usize },

    #[error("patch range {start}..{end} exceeds history length {len}")]
    PatchRangeExceeded { start: usize, end: usize, len: usize },

    #[error("compaction failed: {reason}")]
    CompactionFailed { reason: String },

    #[error("normalization failed: {reason}")]
    NormalizeFailed { reason: String },

    #[error("fork failed: {reason}")]
    ForkFailed { reason: String },

    #[error("merge failed: {reason}")]
    MergeFailed { reason: String },

    #[error("token budget exceeded: used {used}, max {max}")]
    TokenBudgetExceeded { used: usize, max: usize },

    #[error("internal error: {0}")]
    Internal(String),
}

// ---------------------------------------------------------------------------
// Message ID
// ---------------------------------------------------------------------------

/// Unique identifier for a context message.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MessageId(pub Uuid);

impl MessageId {
    /// Create a new random message ID.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for MessageId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for MessageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ---------------------------------------------------------------------------
// Turn ID
// ---------------------------------------------------------------------------

/// Identifies a logical turn in the conversation (may span multiple messages).
pub type TurnId = String;

// ---------------------------------------------------------------------------
// Message role
// ---------------------------------------------------------------------------

/// The role of a message in the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool { call_id: String },
    Compaction,
}

// ---------------------------------------------------------------------------
// Message content
// ---------------------------------------------------------------------------

/// A single part of multipart content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ContentPart {
    Text { content: String },
    Image { data: Vec<u8>, media_type: String },
}

/// The content payload of a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MessageContent {
    Text(String),
    Structured(serde_json::Value),
    Multipart(Vec<ContentPart>),
}

// ---------------------------------------------------------------------------
// Message source
// ---------------------------------------------------------------------------

/// Where the message originated from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageSource {
    UserInput,
    ToolResult,
    Compaction,
    Subagent,
    SystemInjection,
}

// ---------------------------------------------------------------------------
// Compaction state
// ---------------------------------------------------------------------------

/// Tracks whether a message has been compacted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CompactionState {
    Uncompacted,
    Compacted {
        summary_tokens: usize,
        original_range: Range<usize>,
    },
}

// ---------------------------------------------------------------------------
// Message metadata
// ---------------------------------------------------------------------------

/// Metadata attached to a context message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageMetadata {
    /// The turn this message belongs to.
    pub turn_id: Option<TurnId>,
    /// Where the message came from.
    pub source: MessageSource,
    /// Whether this message is the result of compaction.
    pub is_compacted: bool,
    /// If compacted, the original range of messages that were merged.
    pub original_range: Option<Range<usize>>,
    /// Signal for evolution / learning.
    pub evolution_signal: Option<String>,
}

impl Default for MessageMetadata {
    fn default() -> Self {
        Self {
            turn_id: None,
            source: MessageSource::UserInput,
            is_compacted: false,
            original_range: None,
            evolution_signal: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Context message
// ---------------------------------------------------------------------------

/// A single message in the context window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMessage {
    pub id: MessageId,
    pub role: MessageRole,
    pub content: MessageContent,
    /// Pre-computed token count. `None` means it needs to be estimated.
    pub token_count: Option<usize>,
    pub metadata: MessageMetadata,
    pub compaction_state: CompactionState,
}

impl ContextMessage {
    /// Convenience constructor for a simple text message.
    pub fn text(role: MessageRole, text: impl Into<String>) -> Self {
        Self {
            id: MessageId::new(),
            role,
            content: MessageContent::Text(text.into()),
            token_count: None,
            metadata: MessageMetadata::default(),
            compaction_state: CompactionState::Uncompacted,
        }
    }
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

/// Aggregated token usage across the context.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Total tokens across all messages.
    pub total: usize,
    /// Breakdown of tokens by role.
    pub by_role: HashMap<String, usize>,
    /// Tokens reclaimed by compaction.
    pub compacted_tokens: usize,
    /// Tokens added by summary injection.
    pub summary_tokens: usize,
}

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/// Budget allocation for sub-agents / child contexts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubBudgetAllocation {
    /// Maximum ratio of parent budget a child may consume.
    pub child_max_ratio: f64,
    /// Maximum tokens allowed for summary injection.
    pub summary_injection_max: usize,
}

impl Default for SubBudgetAllocation {
    fn default() -> Self {
        Self {
            child_max_ratio: 0.5,
            summary_injection_max: 1024,
        }
    }
}

/// Controls when compaction triggers and how the budget is split.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBudget {
    /// Hard upper bound on total tokens.
    pub max_total: usize,
    /// When usage / max_total exceeds this ratio, auto-compact triggers.
    pub auto_compact_threshold: f64,
    /// Tokens reserved for the assistant's response.
    pub reserve_for_response: usize,
    /// Budget for sub-contexts.
    pub sub_budget: SubBudgetAllocation,
}

impl Default for TokenBudget {
    fn default() -> Self {
        Self {
            max_total: 128_000,
            auto_compact_threshold: 0.85,
            reserve_for_response: 4_096,
            sub_budget: SubBudgetAllocation::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/// Strategy for compacting the context history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CompactionStrategy {
    /// Replace the entire history with a single summary.
    FullReplace,
    /// Keep the last N messages and compact the rest.
    TailKeep { keep_n: usize },
    /// Compact in chunks of the given size.
    Chunked { chunk_size: usize },
}

/// Report generated after a compaction operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompactionReport {
    /// Number of messages before compaction.
    pub messages_before: usize,
    /// Number of messages after compaction.
    pub messages_after: usize,
    /// Tokens freed.
    pub tokens_freed: usize,
    /// Messages that were compacted.
    pub compacted_count: usize,
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/// Report generated after normalization.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NormalizeReport {
    /// Duplicate messages removed.
    pub duplicates_removed: usize,
    /// Empty messages cleaned.
    pub empties_cleaned: usize,
    /// Tool results merged.
    pub tool_results_merged: usize,
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

/// Policy for what a forked context inherits from its parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InheritPolicy {
    /// Copy the full history.
    Full,
    /// Copy only the last N messages.
    TailOnly { n: usize },
    /// Copy nothing; start fresh.
    None,
}

/// Configuration for forking a child context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForkConfig {
    /// What to inherit from the parent.
    pub inherit_policy: InheritPolicy,
    /// Maximum tokens the child may use (absolute).
    pub max_tokens: Option<usize>,
    /// Optional turn ID to assign to all inherited messages.
    pub turn_id: Option<TurnId>,
}

impl Default for ForkConfig {
    fn default() -> Self {
        Self {
            inherit_policy: InheritPolicy::Full,
            max_tokens: None,
            turn_id: None,
        }
    }
}

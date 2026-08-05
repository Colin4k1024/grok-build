//! Agent-initiated context window management.
//!
//! A [`ContextWindow`] is an isolated child context that an agent can open
//! to handle an independent subtask.  When the child completes, its results
//! are summarised and injected back into the parent as a single
//! [`MessageRole::Compaction`] message.
//!
//! # Lifecycle
//!
//! ```text
//! Parent context
//!   │
//!   ├── Agent decides: "I need a subtask"
//!   │
//!   ▼
//! ContextWindowManager::open(task_description, inherit_policy)
//!   │
//!   ▼
//! ┌─────────────────────────────────┐
//! │  Child Context (isolated)       │
//! │  - Inherits per policy          │
//! │  - Independent token budget     │
//! │  - Agent works in child         │
//! │  - Produces result              │
//! └──────────────┬──────────────────┘
//!                │
//!                ▼
//! ContextWindowManager::close(child_id)
//!   → summary ≤ 500 tokens injected into parent
//! ```

use std::collections::HashMap;

use crate::budget_allocator::BudgetAllocator;
use crate::types::{
    ContextError, ContextMessage, ContextResult, ForkConfig, InheritPolicy, MessageContent,
    MessageId, MessageMetadata, MessageRole, MessageSource, SubBudgetAllocation, TokenBudget,
};
use crate::ContextManager;

/// Maximum tokens for a summary injected back into the parent.
const DEFAULT_SUMMARY_MAX_TOKENS: usize = 500;

/// Unique identifier for a child context window.
pub type WindowId = String;

/// Status of a context window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowStatus {
    /// The window is open and the agent is working in it.
    Active,
    /// The window has been closed and its summary injected.
    Closed,
}

/// A managed child context window.
#[derive(Debug)]
pub struct ContextWindow {
    /// Unique ID for this window.
    pub id: WindowId,
    /// The task description given by the agent.
    pub task_description: String,
    /// The child context manager.
    pub child: Box<dyn ContextManager>,
    /// Token budget allocated to this window.
    pub budget: TokenBudget,
    /// Current status.
    pub status: WindowStatus,
}

/// Result of closing a context window.
#[derive(Debug, Clone)]
pub struct WindowCloseResult {
    /// The window ID that was closed.
    pub window_id: WindowId,
    /// Number of messages in the child context at close time.
    pub child_message_count: usize,
    /// Token usage of the child context at close time.
    pub child_token_usage: usize,
    /// Whether the summary was successfully injected into the parent.
    pub summary_injected: bool,
    /// The summary text (truncated to budget).
    pub summary_text: String,
}

/// Manages the lifecycle of agent-initiated context windows.
///
/// # Example
///
/// ```
/// use xai_grok_context_manager::context_window::ContextWindowManager;
/// use xai_grok_context_manager::types::*;
/// use xai_grok_context_manager::DefaultContextManager;
///
/// let parent_budget = TokenBudget::default();
/// let parent = DefaultContextManager::new(parent_budget.clone());
/// let mut mgr = ContextWindowManager::new(parent_budget);
///
/// // Open a child context.
/// let window_id = mgr.open(
///     "Search for error handling patterns".to_string(),
///     InheritPolicy::TailOnly { n: 5 },
///     None, // use default budget
///     &parent,
/// ).unwrap();
///
/// // ... agent works in the child context ...
///
/// // Close the window — summary is injected into parent.
/// // (In real usage, `parent` would be mutable.)
/// ```
#[derive(Debug)]
pub struct ContextWindowManager {
    /// Budget allocator for parent ↔ children.
    allocator: BudgetAllocator,
    /// Active and recently closed windows.
    windows: HashMap<WindowId, ContextWindow>,
    /// Counter for generating unique window IDs.
    next_id: u64,
    /// Maximum tokens for summary injection.
    summary_max_tokens: usize,
}

impl ContextWindowManager {
    /// Create a new window manager with the parent's token budget.
    pub fn new(parent_budget: TokenBudget) -> Self {
        let summary_max = parent_budget.sub_budget.summary_injection_max;
        Self {
            allocator: BudgetAllocator::new(parent_budget),
            windows: HashMap::new(),
            next_id: 1,
            summary_max_tokens: if summary_max > 0 {
                summary_max
            } else {
                DEFAULT_SUMMARY_MAX_TOKENS
            },
        }
    }

    /// Create a new window manager with a custom summary token limit.
    pub fn with_summary_limit(parent_budget: TokenBudget, summary_max_tokens: usize) -> Self {
        Self {
            allocator: BudgetAllocator::new(parent_budget),
            windows: HashMap::new(),
            next_id: 1,
            summary_max_tokens,
        }
    }

    /// Open a new child context window.
    ///
    /// The child inherits messages from the parent according to
    /// `inherit_policy` and receives an independent token budget.
    ///
    /// Returns the window ID on success.
    pub fn open(
        &mut self,
        task_description: String,
        inherit_policy: InheritPolicy,
        max_tokens: Option<usize>,
        parent: &dyn ContextManager,
    ) -> ContextResult<WindowId> {
        let child_budget = self.allocator.allocate(max_tokens)?;

        let fork_config = ForkConfig {
            inherit_policy,
            max_tokens: Some(child_budget.max_total),
            turn_id: None,
        };

        let child = parent.fork(fork_config)?;

        let id = format!("win-{}", self.next_id);
        self.next_id += 1;

        let window = ContextWindow {
            id: id.clone(),
            task_description,
            child,
            budget: child_budget,
            status: WindowStatus::Active,
        };

        self.windows.insert(id.clone(), window);
        Ok(id)
    }

    /// Close a context window and inject its summary into the parent.
    ///
    /// The child's history is summarised into a single
    /// [`MessageRole::Compaction`] message and appended to the parent.
    /// The summary is truncated to `summary_max_tokens`.
    ///
    /// Returns a [`WindowCloseResult`] with details about the closure.
    pub fn close(
        &mut self,
        window_id: &str,
        parent: &mut dyn ContextManager,
    ) -> ContextResult<WindowCloseResult> {
        let window = self
            .windows
            .get_mut(window_id)
            .ok_or_else(|| ContextError::Internal(format!("unknown window: {window_id}")))?;

        if window.status == WindowStatus::Closed {
            return Err(ContextError::Internal(format!(
                "window {window_id} already closed"
            )));
        }

        let child = &*window.child;
        let child_message_count = child.history().len();
        let child_token_usage = child.token_usage().total;

        // Generate summary text from child history.
        let summary_text = generate_summary(child, self.summary_max_tokens);
        let summary_injected = !summary_text.is_empty();

        if summary_injected {
            // Inject into parent.
            parent.merge_summary(child, self.summary_max_tokens)?;
        }

        // Reclaim budget.
        self.allocator.reclaim(&window.budget, child_token_usage);

        window.status = WindowStatus::Closed;

        Ok(WindowCloseResult {
            window_id: window_id.to_string(),
            child_message_count,
            child_token_usage,
            summary_injected,
            summary_text,
        })
    }

    /// Get a reference to an active window.
    pub fn window(&self, window_id: &str) -> Option<&ContextWindow> {
        self.windows.get(window_id)
    }

    /// Get a mutable reference to a window's child context.
    ///
    /// This allows the agent to push messages, run tools, etc. in the
    /// child context.
    pub fn child_mut(&mut self, window_id: &str) -> Option<&mut (dyn ContextManager + '_)> {
        let window = self.windows.get_mut(window_id)?;
        if window.status != WindowStatus::Active {
            return None;
        }
        Some(window.child.as_mut())
    }

    /// List all active window IDs.
    pub fn active_windows(&self) -> Vec<&str> {
        self.windows
            .values()
            .filter(|w| w.status == WindowStatus::Active)
            .map(|w| w.id.as_str())
            .collect()
    }

    /// The budget allocator (for inspection).
    pub fn allocator(&self) -> &BudgetAllocator {
        &self.allocator
    }

    /// The budget allocator (mutable).
    pub fn allocator_mut(&mut self) -> &mut BudgetAllocator {
        &mut self.allocator
    }
}

/// Generate a summary text from a child context's history.
///
/// The summary is a condensed representation of the child's messages,
/// truncated to approximately `max_tokens` (estimated at 4 chars/token).
fn generate_summary(child: &dyn ContextManager, max_tokens: usize) -> String {
    let max_chars = max_tokens * 4; // bytes/4 heuristic
    let mut parts = Vec::new();
    let mut total_chars = 0;

    for msg in child.history() {
        let text = match &msg.content {
            MessageContent::Text(s) => s.clone(),
            MessageContent::Structured(v) => {
                let s = serde_json::to_string(v).unwrap_or_default();
                if s.len() > 200 {
                    format!("{}...", &s[..200])
                } else {
                    s
                }
            }
            MessageContent::Multipart(parts_inner) => {
                let texts: Vec<&str> = parts_inner
                    .iter()
                    .filter_map(|p| match p {
                        crate::types::ContentPart::Text { content } => Some(content.as_str()),
                        _ => None,
                    })
                    .collect();
                texts.join("")
            }
        };

        if text.is_empty() {
            continue;
        }

        let line = format!("[{:?}] {}", msg.role, text);
        if total_chars + line.len() > max_chars {
            // Truncate and stop.
            let remaining = max_chars.saturating_sub(total_chars);
            if remaining > 20 {
                parts.push(format!("{}...", &line[..remaining.min(line.len())]));
            }
            break;
        }
        total_chars += line.len();
        parts.push(line);
    }

    if parts.is_empty() {
        "(empty subtask context)".to_string()
    } else {
        parts.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DefaultContextManager;

    fn test_budget() -> TokenBudget {
        TokenBudget {
            max_total: 100_000,
            auto_compact_threshold: 0.85,
            reserve_for_response: 4_096,
            sub_budget: SubBudgetAllocation {
                child_max_ratio: 0.5,
                summary_injection_max: 500,
            },
        }
    }

    fn make_parent() -> DefaultContextManager {
        let mut parent = DefaultContextManager::new(test_budget());
        // Add some messages.
        parent
            .push(ContextMessage::text(
                MessageRole::System,
                "You are a helpful assistant.",
            ))
            .unwrap();
        parent
            .push(ContextMessage::text(
                MessageRole::User,
                "Find all TODO comments in the codebase.",
            ))
            .unwrap();
        parent
            .push(ContextMessage::text(
                MessageRole::Assistant,
                "I'll search for TODO comments.",
            ))
            .unwrap();
        parent
    }

    #[test]
    fn open_and_close_window() {
        let parent = make_parent();
        let mut mgr = ContextWindowManager::new(test_budget());

        let win_id = mgr
            .open(
                "Search for TODOs".to_string(),
                InheritPolicy::TailOnly { n: 2 },
                None,
                &parent,
            )
            .unwrap();

        assert!(win_id.starts_with("win-"));
        assert_eq!(mgr.active_windows().len(), 1);

        // Push messages into child.
        {
            let child = mgr.child_mut(&win_id).unwrap();
            child
                .push(ContextMessage::text(
                    MessageRole::User,
                    "grep -r TODO src/",
                ))
                .unwrap();
            child
                .push(ContextMessage::text(
                    MessageRole::Assistant,
                    "Found 5 TODO comments.",
                ))
                .unwrap();
        }

        // Close the window.
        let mut parent = make_parent();
        let result = mgr.close(&win_id, &mut parent).unwrap();

        assert!(result.summary_injected);
        assert_eq!(result.child_message_count, 4); // 2 inherited + 2 new
        assert!(result.summary_text.contains("Found 5 TODO"));
        assert_eq!(mgr.active_windows().len(), 0);

        // Parent should now have the summary injected.
        let last = parent.history().last().unwrap();
        assert_eq!(last.role, MessageRole::Compaction);
    }

    #[test]
    fn close_unknown_window_fails() {
        let mut parent = make_parent();
        let mut mgr = ContextWindowManager::new(test_budget());
        assert!(mgr.close("win-999", &mut parent).is_err());
    }

    #[test]
    fn close_twice_fails() {
        let parent = make_parent();
        let mut mgr = ContextWindowManager::new(test_budget());
        let win_id = mgr
            .open("task".to_string(), InheritPolicy::None, None, &parent)
            .unwrap();

        let mut parent = make_parent();
        mgr.close(&win_id, &mut parent).unwrap();
        assert!(mgr.close(&win_id, &mut parent).is_err());
    }

    #[test]
    fn child_mut_not_available_after_close() {
        let parent = make_parent();
        let mut mgr = ContextWindowManager::new(test_budget());
        let win_id = mgr
            .open("task".to_string(), InheritPolicy::None, None, &parent)
            .unwrap();

        let mut parent = make_parent();
        mgr.close(&win_id, &mut parent).unwrap();
        assert!(mgr.child_mut(&win_id).is_none());
    }

    #[test]
    fn budget_allocation_and_reclaim() {
        let parent = make_parent();
        let mut mgr = ContextWindowManager::new(test_budget());

        let _win_id = mgr
            .open(
                "task".to_string(),
                InheritPolicy::None,
                Some(20_000),
                &parent,
            )
            .unwrap();

        assert_eq!(mgr.allocator().allocated(), 20_000);

        let mut parent = make_parent();
        let result = mgr.close(&_win_id, &mut parent).unwrap();
        // After close, budget should be reclaimed (child used 0 tokens since
        // InheritPolicy::None + no messages pushed).
        assert_eq!(result.child_token_usage, 0);
        assert_eq!(mgr.allocator().allocated(), 0);
    }

    #[test]
    fn generate_summary_respects_token_limit() {
        let mut child = DefaultContextManager::new(test_budget());
        for i in 0..100 {
            child
                .push(ContextMessage::text(
                    MessageRole::Assistant,
                    format!("Line {i}: This is a test message with some content."),
                ))
                .unwrap();
        }

        let summary = generate_summary(&child, 50); // ~200 chars
        assert!(summary.len() <= 220); // some slack for prefix
        assert!(summary.contains("Line 0"));
    }
}

//! Integration tests for xai-grok-context-manager.

use serde_json;
use xai_grok_context_manager::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_text(role: MessageRole, text: &str) -> ContextMessage {
    ContextMessage::text(role, text)
}

fn user_msg(text: &str) -> ContextMessage {
    make_text(MessageRole::User, text)
}

fn assistant_msg(text: &str) -> ContextMessage {
    make_text(MessageRole::Assistant, text)
}

fn system_msg(text: &str) -> ContextMessage {
    make_text(MessageRole::System, text)
}

fn tool_msg(call_id: &str, text: &str) -> ContextMessage {
    ContextMessage {
        id: MessageId::new(),
        role: MessageRole::Tool {
            call_id: call_id.to_string(),
        },
        content: MessageContent::Text(text.to_string()),
        token_count: None,
        metadata: MessageMetadata {
            source: MessageSource::ToolResult,
            ..MessageMetadata::default()
        },
        compaction_state: CompactionState::Uncompacted,
    }
}

fn default_budget() -> TokenBudget {
    TokenBudget::default()
}

fn small_budget() -> TokenBudget {
    TokenBudget {
        max_total: 100,
        auto_compact_threshold: 0.8,
        reserve_for_response: 20,
        ..TokenBudget::default()
    }
}

// ---------------------------------------------------------------------------
// Serde roundtrip
// ---------------------------------------------------------------------------

#[test]
fn serde_roundtrip_context_message() {
    let msg = ContextMessage {
        id: MessageId::new(),
        role: MessageRole::Assistant,
        content: MessageContent::Text("hello world".to_string()),
        token_count: Some(42),
        metadata: MessageMetadata {
            turn_id: Some("turn-1".to_string()),
            source: MessageSource::UserInput,
            is_compacted: false,
            original_range: None,
            evolution_signal: None,
        },
        compaction_state: CompactionState::Uncompacted,
    };

    let json = serde_json::to_string(&msg).expect("serialize");
    let decoded: ContextMessage = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(decoded.role, MessageRole::Assistant);
    assert_eq!(decoded.content, MessageContent::Text("hello world".to_string()));
    assert_eq!(decoded.token_count, Some(42));
    assert_eq!(decoded.metadata.turn_id, Some("turn-1".to_string()));
}

#[test]
fn serde_roundtrip_compaction_state() {
    let state = CompactionState::Compacted {
        summary_tokens: 100,
        original_range: 0..5,
    };
    let json = serde_json::to_string(&state).expect("serialize");
    let decoded: CompactionState = serde_json::from_str(&json).expect("deserialize");
    match decoded {
        CompactionState::Compacted {
            summary_tokens,
            original_range,
        } => {
            assert_eq!(summary_tokens, 100);
            assert_eq!(original_range, 0..5);
        }
        _ => panic!("expected Compacted"),
    }
}

#[test]
fn serde_roundtrip_token_budget() {
    let budget = TokenBudget::default();
    let json = serde_json::to_string(&budget).expect("serialize");
    let decoded: TokenBudget = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(decoded.max_total, 128_000);
    assert_eq!(decoded.auto_compact_threshold, 0.85);
    assert_eq!(decoded.reserve_for_response, 4_096);
}

#[test]
fn serde_roundtrip_compaction_strategy() {
    let strategies = vec![
        CompactionStrategy::FullReplace,
        CompactionStrategy::TailKeep { keep_n: 10 },
        CompactionStrategy::Chunked { chunk_size: 5 },
    ];
    for s in strategies {
        let json = serde_json::to_string(&s).expect("serialize");
        let decoded: CompactionStrategy = serde_json::from_str(&json).expect("deserialize");
        // Just check it round-trips without error.
        let _ = decoded;
    }
}

#[test]
fn serde_roundtrip_fork_config() {
    let config = ForkConfig {
        inherit_policy: InheritPolicy::TailOnly { n: 5 },
        max_tokens: Some(4096),
        turn_id: Some("child-turn".to_string()),
    };
    let json = serde_json::to_string(&config).expect("serialize");
    let decoded: ForkConfig = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(decoded.inherit_policy, InheritPolicy::TailOnly { n: 5 });
    assert_eq!(decoded.max_tokens, Some(4096));
}

// ---------------------------------------------------------------------------
// Push / history
// ---------------------------------------------------------------------------

#[test]
fn push_and_read_history() {
    let mut mgr = DefaultContextManager::new(default_budget());
    assert!(mgr.history().is_empty());

    mgr.push(user_msg("hello")).unwrap();
    mgr.push(assistant_msg("hi there")).unwrap();
    mgr.push(user_msg("how are you?")).unwrap();

    assert_eq!(mgr.history().len(), 3);
    assert_eq!(mgr.history()[0].content, MessageContent::Text("hello".to_string()));
    assert_eq!(
        mgr.history()[1].content,
        MessageContent::Text("hi there".to_string())
    );
}

// ---------------------------------------------------------------------------
// Token usage and budget
// ---------------------------------------------------------------------------

#[test]
fn token_usage_basic() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("hello world test message")).unwrap();
    let usage = mgr.token_usage();
    assert!(usage.total > 0, "total tokens should be > 0");
}

#[test]
fn token_budget_default() {
    let mgr = DefaultContextManager::new(default_budget());
    let budget = mgr.token_budget();
    assert_eq!(budget.max_total, 128_000);
    assert_eq!(budget.auto_compact_threshold, 0.85);
}

#[test]
fn budget_exceeded_on_push() {
    let budget = TokenBudget {
        max_total: 10,
        ..TokenBudget::default()
    };
    let mut mgr = DefaultContextManager::new(budget);
    // Push enough content to exceed the tiny budget.
    mgr.push(user_msg("this is a long message that should exceed the tiny budget"))
        .unwrap();
    let usage = mgr.token_usage();
    // With a 10-token budget and a long message, usage > budget.
    // The manager doesn't enforce the budget on push (that's the caller's
    // responsibility), but it accurately reports the usage.
    assert!(usage.total > 0);
}

// ---------------------------------------------------------------------------
// Engine patch
// ---------------------------------------------------------------------------

#[test]
fn engine_patch_append_and_replace() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("first")).unwrap();
    mgr.push(user_msg("second")).unwrap();
    mgr.push(user_msg("third")).unwrap();

    // Replace the second message.
    mgr.patch(1..2, vec![assistant_msg("replaced")]).unwrap();
    assert_eq!(mgr.history().len(), 3);
    assert_eq!(
        mgr.history()[1].content,
        MessageContent::Text("replaced".to_string())
    );
}

#[test]
fn engine_patch_invalid_range() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("only")).unwrap();
    let result = mgr.patch(0..5, vec![assistant_msg("nope")]);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Fork / merge
// ---------------------------------------------------------------------------

#[test]
fn fork_full_inherit() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("a")).unwrap();
    mgr.push(assistant_msg("b")).unwrap();

    let child = mgr
        .fork(ForkConfig {
            inherit_policy: InheritPolicy::Full,
            max_tokens: None,
            turn_id: None,
        })
        .unwrap();

    assert_eq!(child.history().len(), 2);
    assert_eq!(child.history()[0].content, MessageContent::Text("a".to_string()));
}

#[test]
fn fork_tail_only() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("a")).unwrap();
    mgr.push(assistant_msg("b")).unwrap();
    mgr.push(user_msg("c")).unwrap();

    let child = mgr
        .fork(ForkConfig {
            inherit_policy: InheritPolicy::TailOnly { n: 1 },
            max_tokens: None,
            turn_id: None,
        })
        .unwrap();

    assert_eq!(child.history().len(), 1);
    assert_eq!(child.history()[0].content, MessageContent::Text("c".to_string()));
}

#[test]
fn fork_none_inherit() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("a")).unwrap();

    let child = mgr
        .fork(ForkConfig {
            inherit_policy: InheritPolicy::None,
            max_tokens: None,
            turn_id: None,
        })
        .unwrap();

    assert!(child.history().is_empty());
}

#[test]
fn merge_summary_basic() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("parent msg")).unwrap();

    let mut child = DefaultContextManager::new(default_budget());
    child.push(user_msg("child work 1")).unwrap();
    child.push(assistant_msg("child result")).unwrap();

    let child_tokens = child.token_usage().total;
    mgr.merge_summary(&child, child_tokens + 1000).unwrap();

    // Parent should now have its original message + the summary.
    assert_eq!(mgr.history().len(), 2);
    assert_eq!(
        mgr.history()[1].role,
        MessageRole::Compaction
    );
}

#[test]
fn merge_summary_budget_exceeded() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("parent")).unwrap();

    let mut child = DefaultContextManager::new(default_budget());
    child.push(user_msg("a very long child message with lots of content")).unwrap();

    let child_tokens = child.token_usage().total;
    // Set max_tokens to 1, which will be less than the child's tokens.
    let result = mgr.merge_summary(&child, 1);
    assert!(result.is_err());
    match result.unwrap_err() {
        ContextError::TokenBudgetExceeded { used, max } => {
            // `used` is the child's token count, `max` the limit we passed in.
            assert_eq!(used, child_tokens);
            assert_eq!(max, 1);
            assert!(used > max);
        }
        other => panic!("expected TokenBudgetExceeded, got: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

#[test]
fn normalize_dedup_consecutive() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("hello")).unwrap();
    mgr.push(user_msg("hello")).unwrap();
    mgr.push(user_msg("world")).unwrap();

    let report = mgr.normalize().unwrap();
    assert_eq!(report.duplicates_removed, 1);
    assert_eq!(mgr.history().len(), 2);
}

#[test]
fn normalize_clean_empty() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("hello")).unwrap();
    mgr.push(ContextMessage {
        id: MessageId::new(),
        role: MessageRole::User,
        content: MessageContent::Text(String::new()),
        token_count: None,
        metadata: MessageMetadata::default(),
        compaction_state: CompactionState::Uncompacted,
    })
    .unwrap();
    mgr.push(user_msg("world")).unwrap();

    let report = mgr.normalize().unwrap();
    assert_eq!(report.empties_cleaned, 1);
    assert_eq!(mgr.history().len(), 2);
}

#[test]
fn normalize_merge_tool_results() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("run something")).unwrap();
    mgr.push(tool_msg("call-1", "result part 1")).unwrap();
    mgr.push(tool_msg("call-1", "result part 2")).unwrap();
    mgr.push(assistant_msg("done")).unwrap();

    let report = mgr.normalize().unwrap();
    assert_eq!(report.tool_results_merged, 1);
    // After merge: user, merged tool, assistant = 3
    assert_eq!(mgr.history().len(), 3);
}

// ---------------------------------------------------------------------------
// Compact
// ---------------------------------------------------------------------------

#[test]
fn compact_full_replace() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("a")).unwrap();
    mgr.push(assistant_msg("b")).unwrap();
    mgr.push(user_msg("c")).unwrap();

    let report = mgr.compact(CompactionStrategy::FullReplace).unwrap();
    assert_eq!(report.messages_before, 3);
    assert_eq!(report.messages_after, 1);
    assert_eq!(report.compacted_count, 3);
    assert_eq!(mgr.history()[0].role, MessageRole::Compaction);
}

#[test]
fn compact_tail_keep() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("a")).unwrap();
    mgr.push(assistant_msg("b")).unwrap();
    mgr.push(user_msg("c")).unwrap();
    mgr.push(assistant_msg("d")).unwrap();

    let report = mgr
        .compact(CompactionStrategy::TailKeep { keep_n: 2 })
        .unwrap();
    // Before: 4 messages. Compact 2 into 1 summary + keep 2 = 3.
    assert_eq!(report.messages_before, 4);
    assert_eq!(report.messages_after, 3);
    assert_eq!(report.compacted_count, 2);
    // The first message should be a compaction summary.
    assert_eq!(mgr.history()[0].role, MessageRole::Compaction);
    // The last two should be the original tail.
    assert_eq!(
        mgr.history()[1].content,
        MessageContent::Text("c".to_string())
    );
    assert_eq!(
        mgr.history()[2].content,
        MessageContent::Text("d".to_string())
    );
}

#[test]
fn compact_chunked() {
    let mut mgr = DefaultContextManager::new(default_budget());
    for i in 0..6 {
        mgr.push(user_msg(&format!("msg {i}"))).unwrap();
    }

    let report = mgr
        .compact(CompactionStrategy::Chunked { chunk_size: 3 })
        .unwrap();
    // 6 messages -> 2 chunks of 3 -> 2 summary messages.
    assert_eq!(report.messages_before, 6);
    assert_eq!(report.messages_after, 2);
    assert_eq!(report.compacted_count, 6);
}

#[test]
fn compact_empty_history() {
    let mut mgr = DefaultContextManager::new(default_budget());
    let report = mgr.compact(CompactionStrategy::FullReplace).unwrap();
    assert_eq!(report.messages_before, 0);
    assert_eq!(report.messages_after, 0);
}

#[test]
fn compact_tail_keep_more_than_available() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("only")).unwrap();
    let report = mgr
        .compact(CompactionStrategy::TailKeep { keep_n: 10 })
        .unwrap();
    assert_eq!(report.messages_before, 1);
    assert_eq!(report.messages_after, 1);
    assert_eq!(report.compacted_count, 0);
}

// ---------------------------------------------------------------------------
// Structured and multipart content
// ---------------------------------------------------------------------------

#[test]
fn structured_content_serde() {
    let msg = ContextMessage {
        id: MessageId::new(),
        role: MessageRole::Assistant,
        content: MessageContent::Structured(serde_json::json!({"key": "value", "count": 42})),
        token_count: None,
        metadata: MessageMetadata::default(),
        compaction_state: CompactionState::Uncompacted,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: ContextMessage = serde_json::from_str(&json).unwrap();
    match &decoded.content {
        MessageContent::Structured(v) => {
            assert_eq!(v["key"], "value");
            assert_eq!(v["count"], 42);
        }
        _ => panic!("expected Structured content"),
    }
}

#[test]
fn multipart_content_serde() {
    let msg = ContextMessage {
        id: MessageId::new(),
        role: MessageRole::User,
        content: MessageContent::Multipart(vec![
            ContentPart::Text {
                content: "here is an image".to_string(),
            },
            ContentPart::Image {
                data: vec![0u8, 1, 2, 3],
                media_type: "image/png".to_string(),
            },
        ]),
        token_count: None,
        metadata: MessageMetadata::default(),
        compaction_state: CompactionState::Uncompacted,
    };
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: ContextMessage = serde_json::from_str(&json).unwrap();
    match &decoded.content {
        MessageContent::Multipart(parts) => {
            assert_eq!(parts.len(), 2);
            assert!(matches!(&parts[0], ContentPart::Text { content } if content == "here is an image"));
            assert!(matches!(&parts[1], ContentPart::Image { data, media_type } if data == &[0, 1, 2, 3] && media_type == "image/png"));
        }
        _ => panic!("expected Multipart content"),
    }
}

// ---------------------------------------------------------------------------
// MessageId defaults and display
// ---------------------------------------------------------------------------

#[test]
fn message_id_default_is_unique() {
    let a = MessageId::new();
    let b = MessageId::new();
    assert_ne!(a, b);
}

#[test]
fn message_id_display() {
    let id = MessageId::new();
    let s = format!("{id}");
    assert!(!s.is_empty());
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

#[test]
fn token_cache_basic() {
    let cache = TokenCache::new();
    let id = MessageId::new();
    assert_eq!(cache.get(&id), None);
    cache.insert(id.clone(), 50, 200);
    assert_eq!(cache.get(&id), Some(50));
}

#[test]
fn token_cache_clear() {
    let cache = TokenCache::new();
    let id = MessageId::new();
    cache.insert(id.clone(), 50, 200);
    cache.clear();
    assert_eq!(cache.get(&id), None);
}

// ---------------------------------------------------------------------------
// Compaction adapter
// ---------------------------------------------------------------------------

#[test]
fn default_compaction_adapter_produces_summary() {
    use xai_grok_context_manager::DefaultCompactionAdapter;

    let adapter = DefaultCompactionAdapter;
    let msgs = vec![user_msg("hello"), assistant_msg("world")];
    let summary = adapter.compact_messages(&msgs).unwrap();
    assert_eq!(summary.role, MessageRole::Compaction);
    match &summary.content {
        MessageContent::Text(s) => {
            assert!(s.contains("hello"));
            assert!(s.contains("world"));
        }
        _ => panic!("expected Text content"),
    }
}

// ---------------------------------------------------------------------------
// Multi-role token usage breakdown
// ---------------------------------------------------------------------------

#[test]
fn token_usage_by_role() {
    let mut mgr = DefaultContextManager::new(default_budget());
    mgr.push(user_msg("user message here")).unwrap();
    mgr.push(assistant_msg("assistant reply here")).unwrap();
    mgr.push(system_msg("system prompt")).unwrap();

    let usage = mgr.token_usage();
    assert!(usage.total > 0);
    // Should have entries for User, Assistant, System roles.
    assert!(!usage.by_role.is_empty());
}

// ---------------------------------------------------------------------------
// Budget allocator
// ---------------------------------------------------------------------------

/// `available()` subtracts the response reserve from the parent's total, so a
/// small budget makes the arithmetic checkable by hand: 100 - 20 = 80.
#[test]
fn allocator_available_excludes_response_reserve() {
    let budget = small_budget();
    let allocator = BudgetAllocator::new(budget.clone());
    assert_eq!(
        allocator.available(),
        budget.max_total - budget.reserve_for_response,
    );
    assert_eq!(allocator.allocated(), 0);
}

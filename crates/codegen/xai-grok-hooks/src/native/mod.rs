//! Native (in-process) hooks that replace the TSP Node.js hook scripts.
//!
//! These run synchronously in the dispatcher with zero spawn overhead.

pub mod block_no_verify;
pub mod command_log;
pub mod cost_tracker;
pub mod session_lifecycle;
pub mod session_suggest;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::event::{HookEventEnvelope, HookEventName};
use crate::runner::HookRunnerResult;

/// A native hook that runs in-process rather than spawning an external command.
pub trait NativeHook: Send + Sync {
    fn name(&self) -> &str;
    fn event(&self) -> HookEventName;
    /// Tool name to match against (e.g. "Bash"). None means fire on all.
    fn matcher(&self) -> Option<&str>;
    fn execute(&self, envelope: &HookEventEnvelope) -> HookRunnerResult;
}

struct ToolCallCounter(Arc<AtomicU32>);

impl NativeHook for ToolCallCounter {
    fn name(&self) -> &str {
        "tsp:tool-call-counter"
    }

    fn event(&self) -> HookEventName {
        HookEventName::PostToolUse
    }

    fn matcher(&self) -> Option<&str> {
        None
    }

    fn execute(&self, _envelope: &HookEventEnvelope) -> HookRunnerResult {
        self.0.fetch_add(1, Ordering::Relaxed);
        HookRunnerResult::Success
    }
}

/// All built-in native hooks, registered at startup.
pub fn builtin_native_hooks() -> Vec<Box<dyn NativeHook>> {
    let tool_call_counter = Arc::new(AtomicU32::new(0));
    let hooks: Vec<Box<dyn NativeHook>> = vec![
        Box::new(block_no_verify::BlockNoVerify::new()),
        Box::new(ToolCallCounter(Arc::clone(&tool_call_counter))),
        Box::new(command_log::CommandLog::new()),
        Box::new(cost_tracker::CostTracker::new()),
        Box::new(session_lifecycle::SessionStart::new()),
        Box::new(session_lifecycle::SessionEnd::new()),
        Box::new(session_suggest::SessionSuggest::new(tool_call_counter)),
    ];
    hooks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::HookPayload;

    fn post_tool_envelope(tool_name: &str) -> HookEventEnvelope {
        HookEventEnvelope {
            hook_event_name: HookEventName::PostToolUse,
            session_id: "test".into(),
            cwd: "/tmp".into(),
            workspace_root: "/tmp".into(),
            timestamp: "2026-01-01T00:00:00Z".into(),
            transcript_path: None,
            client_identifier: None,
            prompt_id: None,
            permission_mode: None,
            payload: HookPayload::PostToolUse {
                tool_name: tool_name.into(),
                tool_use_id: "call-1".into(),
                tool_input: serde_json::json!({}),
                tool_result: serde_json::json!({}),
                tool_input_truncated: false,
                tool_result_truncated: false,
                duration_ms: None,
                is_backgrounded: false,
                subagent_type: None,
            },
        }
    }

    #[test]
    fn tool_call_counter_counts_every_tool_name() {
        let count = Arc::new(AtomicU32::new(0));
        let hooks: Vec<Box<dyn NativeHook>> = vec![Box::new(ToolCallCounter(Arc::clone(&count)))];

        crate::dispatcher::dispatch_native_observers(&hooks, &post_tool_envelope("read_file"));
        crate::dispatcher::dispatch_native_observers(&hooks, &post_tool_envelope("bash"));

        assert_eq!(count.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn builtin_bash_matchers_are_case_insensitive() {
        let mut envelope = post_tool_envelope("bash");
        envelope.hook_event_name = HookEventName::PreToolUse;
        envelope.payload = HookPayload::PreToolUse {
            tool_name: "bash".into(),
            tool_use_id: "call-1".into(),
            tool_input: serde_json::json!({"command": "git commit --no-verify -m test"}),
            tool_input_truncated: false,
            subagent_type: None,
        };

        let decision =
            crate::dispatcher::dispatch_native_pre_tool_use(&builtin_native_hooks(), &envelope);
        assert!(matches!(
            decision,
            Some(crate::result::HookDecision::Deny { .. })
        ));
    }
}

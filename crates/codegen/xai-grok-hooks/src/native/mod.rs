//! Native (in-process) hooks that replace the TSP Node.js hook scripts.
//!
//! These run synchronously in the dispatcher with zero spawn overhead.

pub mod block_no_verify;
pub mod command_log;
pub mod cost_tracker;
pub mod session_lifecycle;
pub mod session_suggest;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

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

/// Shared counter for tool calls in this session, incremented by PostToolUse
/// hooks and read by the Stop hook to determine session complexity.
pub struct NativeHookState {
    pub tool_call_counter: Arc<AtomicU32>,
}

impl NativeHookState {
    pub fn new() -> Self {
        Self {
            tool_call_counter: Arc::new(AtomicU32::new(0)),
        }
    }

    pub fn increment_tool_calls(&self) {
        self.tool_call_counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// All built-in native hooks, registered at startup.
pub fn builtin_native_hooks() -> (Vec<Box<dyn NativeHook>>, Arc<NativeHookState>) {
    let state = Arc::new(NativeHookState::new());
    let hooks: Vec<Box<dyn NativeHook>> = vec![
        Box::new(block_no_verify::BlockNoVerify::new()),
        Box::new(command_log::CommandLog::new(Arc::clone(
            &state.tool_call_counter,
        ))),
        Box::new(cost_tracker::CostTracker::new()),
        Box::new(session_lifecycle::SessionStart::new()),
        Box::new(session_lifecycle::SessionEnd::new()),
        Box::new(session_suggest::SessionSuggest::new(Arc::clone(
            &state.tool_call_counter,
        ))),
    ];
    (hooks, state)
}

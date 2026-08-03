//! Native (in-process) hooks that replace the TSP Node.js hook scripts.
//!
//! These run synchronously in the dispatcher with zero spawn overhead.

pub mod block_no_verify;
pub mod command_log;
pub mod cost_tracker;
pub mod session_lifecycle;

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

/// All built-in native hooks, registered at startup.
pub fn builtin_native_hooks() -> Vec<Box<dyn NativeHook>> {
    vec![
        Box::new(block_no_verify::BlockNoVerify::new()),
        Box::new(command_log::CommandLog::new()),
        Box::new(cost_tracker::CostTracker::new()),
        Box::new(session_lifecycle::SessionStart::new()),
        Box::new(session_lifecycle::SessionEnd::new()),
    ]
}

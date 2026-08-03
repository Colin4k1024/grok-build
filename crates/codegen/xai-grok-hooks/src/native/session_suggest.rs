//! Stop hook: suggests extractable skills/agents at conversation end.
//!
//! Fires when a turn ends with no pending work (no background tasks,
//! no session crons) and the session has been complex enough (≥3 tool calls).
//! Injects `additionalContext` so the model outputs extraction suggestions.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use crate::event::{HookEventEnvelope, HookEventName, HookPayload};
use crate::result::StopHookOutcome;
use crate::runner::HookRunnerResult;

use super::NativeHook;

const MIN_TOOL_CALLS: u32 = 3;
const MAX_DAILY_SUGGESTS: u32 = 3;

const SUGGEST_PROMPT: &str = "[internal:session-suggest] Before finishing, analyze this \
conversation for reusable patterns. If you find: (1) multi-step workflows repeated or \
generalizable, (2) domain-specific role+tool combinations, (3) command sequences that could \
be automated — append a brief suggestion starting with '---' and 💡, listing each pattern \
and whether to use /learn (skill) or create an agent file (~/.grok/agents/name.md). \
Keep it under 4 lines. If nothing is extractable, output nothing extra.";

pub struct SessionSuggest {
    tool_call_counter: Arc<AtomicU32>,
}

impl SessionSuggest {
    pub fn new(counter: Arc<AtomicU32>) -> Self {
        Self {
            tool_call_counter: counter,
        }
    }
}

impl NativeHook for SessionSuggest {
    fn name(&self) -> &str {
        "tsp:session-suggest"
    }

    fn event(&self) -> HookEventName {
        HookEventName::Stop
    }

    fn matcher(&self) -> Option<&str> {
        None
    }

    fn execute(&self, envelope: &HookEventEnvelope) -> HookRunnerResult {
        let (reason, stop_hook_active, background_tasks, session_crons) = match &envelope.payload {
            HookPayload::Stop {
                reason,
                stop_hook_active,
                background_tasks,
                session_crons,
                ..
            } => (reason, *stop_hook_active, background_tasks, session_crons),
            _ => return HookRunnerResult::Success,
        };

        // Don't stack on an already-active stop hook
        if stop_hook_active {
            return HookRunnerResult::Success;
        }

        // Only trigger on natural end_turn
        if reason != "end_turn" {
            return HookRunnerResult::Success;
        }

        // Don't trigger if there's pending work
        let has_bg = background_tasks
            .as_ref()
            .map_or(false, |tasks| !tasks.is_empty());
        let has_crons = session_crons
            .as_ref()
            .map_or(false, |crons| !crons.is_empty());
        if has_bg || has_crons {
            return HookRunnerResult::Success;
        }

        // Complexity gate
        let count = self.tool_call_counter.load(Ordering::Relaxed);
        tracing::debug!(
            tool_call_count = count,
            min_required = MIN_TOOL_CALLS,
            "session-suggest: evaluating complexity gate"
        );
        if count < MIN_TOOL_CALLS {
            return HookRunnerResult::Success;
        }

        // Daily frequency limit
        if !check_daily_limit() {
            return HookRunnerResult::Success;
        }

        tracing::info!(
            tool_calls = count,
            "Session suggest: injecting extraction prompt"
        );

        HookRunnerResult::Stop(StopHookOutcome {
            block_reason: None,
            additional_context: Some(SUGGEST_PROMPT.to_string()),
            force_stop: None,
        })
    }
}

fn check_daily_limit() -> bool {
    let marker_path = xai_grok_config::grok_home().join(".suggest-count");

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let today_days = (now.as_secs() / 86400) as u64;

    let (stored_days, count) = std::fs::read_to_string(&marker_path)
        .ok()
        .and_then(|s| {
            let mut parts = s.trim().splitn(2, ':');
            let d: u64 = parts.next()?.parse().ok()?;
            let c: u32 = parts.next()?.parse().ok()?;
            Some((d, c))
        })
        .unwrap_or((0, 0));

    if stored_days == today_days && count >= MAX_DAILY_SUGGESTS {
        return false;
    }

    let new_count = if stored_days == today_days {
        count + 1
    } else {
        1
    };
    let _ = std::fs::write(&marker_path, format!("{today_days}:{new_count}"));
    true
}

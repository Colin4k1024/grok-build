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

const SUGGEST_PROMPT: &str = "\
回顾本次对话，如果存在以下任何一种可复用模式，请在回复末尾用简短分隔区域提示用户：

1. 重复的多步骤工作流 → 可提取为 Skill（建议运行 /learn）
2. 特定领域的角色+工具组合 → 可提取为独立 Agent（~/.grok/agents/name.md）
3. 频繁使用的命令序列 → 可提取为 Hook 或自定义命令

格式：
---
💡 本次对话发现可复用模式：
- [模式描述] → /learn 提取为 skill
- [角色描述] → 创建为 agent

如果没有明显可提取的模式，不要输出此区域。";

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

//! PreToolUse gate: blocks `git commit --no-verify`.

use regex::Regex;
use std::sync::LazyLock;

use crate::event::{HookEventEnvelope, HookEventName, HookPayload};
use crate::result::HookDecision;
use crate::runner::HookRunnerResult;

use super::NativeHook;

static GIT_COMMIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bgit\s+commit\b").unwrap());
static NO_VERIFY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s--no-verify(?:\s|$)").unwrap());

pub struct BlockNoVerify;

impl BlockNoVerify {
    pub fn new() -> Self {
        Self
    }
}

impl NativeHook for BlockNoVerify {
    fn name(&self) -> &str {
        "tsp:block-no-verify"
    }

    fn event(&self) -> HookEventName {
        HookEventName::PreToolUse
    }

    fn matcher(&self) -> Option<&str> {
        Some("Bash")
    }

    fn execute(&self, envelope: &HookEventEnvelope) -> HookRunnerResult {
        let command = match &envelope.payload {
            HookPayload::PreToolUse { tool_input, .. } => {
                tool_input.get("command").and_then(|v| v.as_str()).unwrap_or("")
            }
            _ => return HookRunnerResult::Decision(HookDecision::Allow),
        };

        let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");

        if GIT_COMMIT_RE.is_match(&normalized) && NO_VERIFY_RE.is_match(&format!(" {normalized} "))
        {
            HookRunnerResult::Decision(HookDecision::Deny {
                reason: "`git commit --no-verify` is not allowed. Git hooks must not be bypassed."
                    .into(),
                hook_name: self.name().into(),
            })
        } else {
            HookRunnerResult::Decision(HookDecision::Allow)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::HookEventEnvelope;

    fn make_envelope(command: &str) -> HookEventEnvelope {
        HookEventEnvelope {
            hook_event_name: HookEventName::PreToolUse,
            session_id: "test".into(),
            cwd: "/tmp".into(),
            workspace_root: "/tmp".into(),
            timestamp: "2025-01-01T00:00:00Z".into(),
            transcript_path: None,
            client_identifier: None,
            prompt_id: None,
            permission_mode: None,
            payload: HookPayload::PreToolUse {
                tool_name: "Bash".into(),
                tool_use_id: "id".into(),
                tool_input: serde_json::json!({"command": command}),
                tool_input_truncated: false,
                subagent_type: None,
            },
        }
    }

    #[test]
    fn blocks_no_verify() {
        let hook = BlockNoVerify::new();
        let result = hook.execute(&make_envelope("git commit --no-verify -m 'test'"));
        assert!(matches!(result, HookRunnerResult::Decision(HookDecision::Deny { .. })));
    }

    #[test]
    fn allows_normal_commit() {
        let hook = BlockNoVerify::new();
        let result = hook.execute(&make_envelope("git commit -m 'test'"));
        assert!(matches!(result, HookRunnerResult::Decision(HookDecision::Allow)));
    }

    #[test]
    fn allows_non_git() {
        let hook = BlockNoVerify::new();
        let result = hook.execute(&make_envelope("ls -la"));
        assert!(matches!(result, HookRunnerResult::Decision(HookDecision::Allow)));
    }
}

//! Session lifecycle hooks: start (observer) and end (writes summary JSON).

use serde::Serialize;

use crate::event::{HookEventEnvelope, HookEventName};
use crate::runner::HookRunnerResult;

use super::NativeHook;

// --- SessionStart ---

pub struct SessionStart;

impl SessionStart {
    pub fn new() -> Self {
        Self
    }
}

impl NativeHook for SessionStart {
    fn name(&self) -> &str {
        "tsp:session-start"
    }

    fn event(&self) -> HookEventName {
        HookEventName::SessionStart
    }

    fn matcher(&self) -> Option<&str> {
        None
    }

    fn execute(&self, _envelope: &HookEventEnvelope) -> HookRunnerResult {
        // Observer-only: the original JS reads project context but its stdout is
        // ignored by the dispatcher for SessionStart events. No side effects needed.
        HookRunnerResult::Success
    }
}

// --- SessionEnd ---

#[derive(Serialize)]
struct SessionSummary {
    platform: &'static str,
    #[serde(rename = "projectRoot")]
    project_root: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    timestamp: String,
    #[serde(rename = "transcriptPath", skip_serializing_if = "Option::is_none")]
    transcript_path: Option<String>,
}

pub struct SessionEnd;

impl SessionEnd {
    pub fn new() -> Self {
        Self
    }
}

impl NativeHook for SessionEnd {
    fn name(&self) -> &str {
        "tsp:session-end"
    }

    fn event(&self) -> HookEventName {
        HookEventName::SessionEnd
    }

    fn matcher(&self) -> Option<&str> {
        None
    }

    fn execute(&self, envelope: &HookEventEnvelope) -> HookRunnerResult {
        let summary = SessionSummary {
            platform: "grok",
            project_root: envelope.workspace_root.clone(),
            session_id: envelope.session_id.clone(),
            timestamp: envelope.timestamp.clone(),
            transcript_path: envelope.transcript_path.clone(),
        };

        let session_dir = xai_grok_config::grok_home().join("session-data");
        let _ = std::fs::create_dir_all(&session_dir);

        let file_path = session_dir.join(format!("{}.json", envelope.session_id));
        let _ = serde_json::to_string_pretty(&summary).map(|json| {
            let _ = std::fs::write(&file_path, json);
        });

        HookRunnerResult::Success
    }
}

//! Public API types for subagent resolution.

use std::path::PathBuf;

use crate::resume::ResumeValidationError;

/// How the child session's initial context was bootstrapped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextSource {
    /// Fresh session with no inherited history.
    New,
    /// Resumed from a previously completed peer subagent. The child inherits
    /// the source's raw transcript, tool state, and model. System prompt and
    /// prompt context are freshly rendered.
    Resumed,
}

/// Resolved effective runtime configuration for a child agent.
///
/// Precedence: explicit spawn-time override > role default > persona default > parent inheritance (None).
#[derive(Debug, Clone, Default)]
pub struct EffectiveRuntimeConfig {
    /// Resolved model ID override (if any).
    pub model: Option<String>,
    /// Resolved reasoning effort (e.g. "low", "medium", "high").
    // TODO(phase2): consider a typed `ReasoningEffort` enum to prevent typos.
    // Currently stringly-typed for compatibility with the shell's existing API.
    pub reasoning_effort: Option<String>,
    /// Resolved capability mode controlling tool access.
    pub capability_mode: Option<xai_tool_types::SubagentCapabilityMode>,
    /// Resolved persona name (for metadata/observability).
    pub persona: Option<String>,
    /// Resolved persona instructions text (for prompt assembly).
    pub persona_instructions: Option<String>,
    /// Role prompt_file content (loaded at resolve time).
    pub role_prompt: Option<String>,
    /// Warning when role prompt_file failed to load (soft degradation).
    pub role_prompt_warning: Option<String>,
    /// Resolved role name (the key that matched in subagent_roles lookup).
    pub role_name: Option<String>,
    /// Error from persona resolution (file unreadable, not found, empty).
    /// Unlike role prompts, persona errors are fatal: spawn is aborted.
    pub persona_error: Option<String>,
    /// Isolation mode for the child execution environment.
    pub isolation: xai_tool_types::SubagentIsolationMode,
}

/// Data about a completed source subagent, needed for resume validation
/// and downstream spawn orchestration.
#[derive(Debug, Clone)]
pub struct ResumeSourceData {
    /// Source subagent ID.
    pub subagent_id: String,
    /// Source subagent type (e.g. "general-purpose", "explore").
    /// Used by `validate_resume_identity` to check type match.
    pub subagent_type: String,
    /// Source subagent persona, if any.
    /// Used by `validate_resume_identity` to check persona match.
    pub persona: Option<String>,
    /// Effective model ID used by the source child session.
    /// Used by the shell for resume model pinning (model overrides on
    /// resume are soft-ignored, not identity-gated).
    pub model_id: Option<String>,
    /// Effective cwd the source child used. Consumed by the shell's
    /// spawn orchestration to reconstruct `SessionInfo` for raw
    /// transcript continuation and worktree reuse.
    pub child_cwd: String,
    /// Worktree path if the source used `isolation=worktree`. Consumed
    /// by the shell to reuse the source's isolated workspace directory
    /// when resuming a worktree-isolated child.
    pub worktree_path: Option<PathBuf>,
    /// Durable git ref holding a snapshot of the source worktree's working
    /// state, set when the worktree was snapshotted at completion. Consumed
    /// by the shell to rehydrate a deleted worktree directory on resume.
    pub snapshot_ref: Option<String>,
    /// The child session ID of the source subagent. Consumed by the
    /// shell to locate the source's session directory for raw transcript
    /// copying (`copy_session_data_sync`).
    pub child_session_id: String,
}

/// Spawn request with nesting depth tracking for nested subagent forwarding.
///
/// Depth 0 = main agent, depth 1 = first-level subagent, depth 2+ = nested.
/// Events from nested subagents (depth >= 2) are forwarded to the TUI when
/// `--forward-subagent-text` is enabled.
#[derive(Debug, Clone, Default)]
pub struct SubagentSpawnRequest {
    pub prompt: String,
    pub subagent_type: String,
    /// Nesting depth (main agent = 0, first subagent = 1, etc.)
    pub depth: usize,
    /// Parent agent ID for building the forwarding chain.
    pub parent_id: Option<String>,
}

/// Events forwarded from nested subagents to the TUI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForwardedEvent {
    Spawned { subagent_id: String, depth: usize },
    Completed { subagent_id: String, depth: usize },
    Error { subagent_id: String, message: String },
    Progress { subagent_id: String, message: String },
}

/// Policy for forwarding nested subagent events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardingPolicy {
    /// Never forward nested events (default).
    None,
    /// Forward key lifecycle events (Spawned, Completed, Error).
    Lifecycle,
    /// Forward all events including progress.
    All,
}

impl Default for ForwardingPolicy {
    fn default() -> Self {
        Self::None
    }
}

impl ForwardingPolicy {
    pub fn should_forward(&self, depth: usize) -> bool {
        match self {
            Self::None => false,
            Self::Lifecycle | Self::All => depth >= 2,
        }
    }

    pub fn include_progress(&self) -> bool {
        matches!(self, Self::All)
    }
}

/// Errors that can occur during subagent resolution.
#[derive(Debug, thiserror::Error)]
pub enum ResolutionError {
    /// No production or session CLI definition has this name.
    #[error("unknown subagent type \"{subagent_type}\"; available: {available:?}")]
    Unknown {
        subagent_type: String,
        available: Vec<String>,
    },

    /// The definition exists but is disabled by the session toggle.
    #[error("subagent \"{subagent_type}\" is disabled")]
    Disabled { subagent_type: String },

    /// The parent session restricts which child types may run.
    #[error("subagent \"{subagent_type}\" is not allowed; allowed: {allowed:?}")]
    NotAllowed {
        subagent_type: String,
        allowed: Vec<String>,
    },

    /// Persona was explicitly requested but could not be resolved.
    #[error("persona resolution failed: {0}")]
    PersonaResolution(String),

    /// Resume identity validation failed.
    #[error("resume validation failed: {0}")]
    ResumeValidation(#[from] ResumeValidationError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_tool_types::SubagentIsolationMode;

    #[test]
    fn effective_runtime_config_default_values() {
        let config = EffectiveRuntimeConfig::default();
        assert!(config.model.is_none());
        assert!(config.reasoning_effort.is_none());
        assert!(config.capability_mode.is_none());
        assert!(config.persona.is_none());
        assert!(config.persona_instructions.is_none());
        assert!(config.role_prompt.is_none());
        assert!(config.role_prompt_warning.is_none());
        assert!(config.role_name.is_none());
        assert!(config.persona_error.is_none());
        assert_eq!(config.isolation, SubagentIsolationMode::None);
    }

    #[test]
    fn resolution_error_persona_display() {
        let err = ResolutionError::PersonaResolution("persona \"x\" not found".into());
        assert_eq!(
            err.to_string(),
            "persona resolution failed: persona \"x\" not found",
        );
    }

    #[test]
    fn resolution_error_resume_from_typed_error() {
        let typed = ResumeValidationError::TypeMismatch {
            requested: "explore".into(),
            source_value: "general-purpose".into(),
        };
        let err = ResolutionError::from(typed);
        let msg = err.to_string();
        assert!(msg.contains("resume validation failed"));
        assert!(msg.contains("explore"));
        assert!(msg.contains("general-purpose"));
    }

    #[test]
    fn context_source_equality() {
        assert_eq!(ContextSource::New, ContextSource::New);
        assert_ne!(ContextSource::New, ContextSource::Resumed);
    }

    #[test]
    fn spawn_request_default_depth_is_zero() {
        let req = SubagentSpawnRequest::default();
        assert_eq!(req.depth, 0);
        assert!(req.parent_id.is_none());
    }

    #[test]
    fn forwarding_policy_none_never_forwards() {
        let policy = ForwardingPolicy::None;
        assert!(!policy.should_forward(0));
        assert!(!policy.should_forward(1));
        assert!(!policy.should_forward(2));
        assert!(!policy.should_forward(5));
    }

    #[test]
    fn forwarding_policy_lifecycle_forwards_depth_2_plus() {
        let policy = ForwardingPolicy::Lifecycle;
        assert!(!policy.should_forward(0));
        assert!(!policy.should_forward(1));
        assert!(policy.should_forward(2));
        assert!(policy.should_forward(3));
        assert!(!policy.include_progress());
    }

    #[test]
    fn forwarding_policy_all_includes_progress() {
        let policy = ForwardingPolicy::All;
        assert!(policy.should_forward(2));
        assert!(policy.include_progress());
    }

    #[test]
    fn forwarded_event_equality() {
        let e1 = ForwardedEvent::Spawned {
            subagent_id: "a".into(),
            depth: 2,
        };
        let e2 = ForwardedEvent::Spawned {
            subagent_id: "a".into(),
            depth: 2,
        };
        assert_eq!(e1, e2);
    }
}

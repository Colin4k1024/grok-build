//! Runtime availability contract shared by optional and externally-backed features.

use serde::{Deserialize, Serialize};

/// Why a capability is or is not currently executable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCapabilityState {
    Available,
    NotCompiled,
    NotConfigured,
    UnsupportedPlatform,
    DependencyMissing,
    RuntimeUnavailable,
}

/// Stable, serializable status returned by every optional capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityStatus {
    pub name: String,
    pub state: RuntimeCapabilityState,
    pub compiled_in: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RuntimeCapabilityStatus {
    pub fn available(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            state: RuntimeCapabilityState::Available,
            compiled_in: true,
            available: true,
            reason: None,
        }
    }

    pub fn unavailable(
        name: impl Into<String>,
        state: RuntimeCapabilityState,
        compiled_in: bool,
        reason: impl Into<String>,
    ) -> Self {
        debug_assert_ne!(state, RuntimeCapabilityState::Available);
        Self {
            name: name.into(),
            state,
            compiled_in,
            available: false,
            reason: Some(reason.into()),
        }
    }

    /// Fail before authentication, worktree creation, or other side effects.
    pub fn ensure_available(&self) -> Result<(), String> {
        if self.available {
            Ok(())
        } else {
            Err(self
                .reason
                .clone()
                .unwrap_or_else(|| format!("{} is unavailable", self.name)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_status_always_explains_itself() {
        let status = RuntimeCapabilityStatus::unavailable(
            "remote_restore",
            RuntimeCapabilityState::NotCompiled,
            false,
            "adapter omitted",
        );
        assert!(!status.compiled_in);
        assert!(!status.available);
        assert_eq!(status.ensure_available().unwrap_err(), "adapter omitted");
        assert_eq!(serde_json::to_value(status).unwrap()["state"], "not_compiled");
    }
}

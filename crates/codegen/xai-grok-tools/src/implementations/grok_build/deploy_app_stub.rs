//! Stub surface when the deploy feature is off.

use xai_grok_workspace_types::{RuntimeCapabilityState, RuntimeCapabilityStatus};

const UNAVAILABLE: &str =
    "deploy_app is not compiled into this source distribution; no deployment adapter is present";

/// Placeholder config — deploy is unavailable in this build.
#[derive(Debug, Clone, Default)]
pub enum AppBuilderDeployerConfig {
    #[default]
    Disabled,
}

impl AppBuilderDeployerConfig {
    pub fn is_enabled(&self) -> bool {
        false
    }

    pub fn capability_status(&self) -> RuntimeCapabilityStatus {
        capability_status()
    }
}

pub const DEPLOY_APP_TOOL_NAME: &str = "deploy_app";

pub fn capability_status() -> RuntimeCapabilityStatus {
    RuntimeCapabilityStatus::unavailable(
        DEPLOY_APP_TOOL_NAME,
        RuntimeCapabilityState::NotCompiled,
        false,
        UNAVAILABLE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_never_advertises_deploy_as_executable() {
        let status = capability_status();
        assert!(!status.compiled_in);
        assert!(!status.available);
        assert_eq!(status.state, RuntimeCapabilityState::NotCompiled);
        assert!(status.reason.unwrap().contains("no deployment adapter"));
    }
}

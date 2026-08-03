//! Stub for builds without the devbox auth feature.
//!
//! Compiled instead of `devbox_login.rs` when the devbox auth feature is
//! off, so the remote devbox login helper is not reached. The API
//! mirrors the real module: `is_devbox_environment()` is always `false`, which
//! short-circuits every auto-recovery/migration call site, and the entry
//! points that can still be reached directly (`grok login --devbox`) return a
//! descriptive error.

use super::manager::AuthManager;
use super::model::GrokAuth;
use xai_grok_workspace_types::{RuntimeCapabilityState, RuntimeCapabilityStatus};

const UNAVAILABLE: &str =
    "devbox login is not compiled into this source distribution; the remote credential mint adapter is absent";

pub(crate) fn capability_status() -> RuntimeCapabilityStatus {
    RuntimeCapabilityStatus::unavailable(
        "devbox_login",
        RuntimeCapabilityState::NotCompiled,
        false,
        UNAVAILABLE,
    )
}

/// Always `false` without the devbox auth feature; callers treat the
/// process as running outside a devbox environment.
pub(crate) fn is_devbox_environment() -> bool {
    false
}

/// Unreachable in practice (guarded by [`is_devbox_environment`]); errors
/// defensively if called.
pub(crate) async fn mint_devbox_auth(_auth_manager: &AuthManager) -> anyhow::Result<GrokAuth> {
    anyhow::bail!(UNAVAILABLE)
}

/// Unreachable in practice (guarded by [`is_devbox_environment`]); errors
/// defensively if called.
pub(super) async fn mint_devbox_auth_raw() -> anyhow::Result<GrokAuth> {
    anyhow::bail!(UNAVAILABLE)
}

/// `grok login --devbox` entry point: always errors in this build.
pub async fn run_devbox_login(_config: &crate::agent::config::Config) -> anyhow::Result<GrokAuth> {
    anyhow::bail!(UNAVAILABLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_reports_missing_adapter() {
        let status = capability_status();
        assert_eq!(status.state, RuntimeCapabilityState::NotCompiled);
        assert!(!status.compiled_in);
        assert!(!status.available);
        assert!(!is_devbox_environment());
    }
}

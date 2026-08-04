//! Build/runtime capability matrix for optional external integrations.

use anyhow::Result;
use xai_grok_workspace_types::{RuntimeCapabilityState, RuntimeCapabilityStatus};

pub fn report() -> Vec<RuntimeCapabilityStatus> {
    vec![
        xai_grok_tools::implementations::grok_build::deploy_app::capability_status(),
        xai_grok_shell::session::restore::capability_status(),
        xai_grok_shell::auth::devbox_login_capability_status(),
        RuntimeCapabilityStatus::available("git_change_serialization"),
        xai_grok_voice::capture_capability_status(),
    ]
}

pub fn run(json: bool) -> Result<()> {
    let statuses = report();
    if json {
        println!("{}", serde_json::to_string(&statuses)?);
        return Ok(());
    }
    println!("Capability                  State                 Compiled  Available  Reason");
    for status in statuses {
        println!(
            "{:<27} {:<21} {:<9} {:<10} {}",
            status.name,
            state_label(status.state),
            yes_no(status.compiled_in),
            yes_no(status.available),
            status.reason.as_deref().unwrap_or("-")
        );
    }
    Ok(())
}

fn state_label(state: RuntimeCapabilityState) -> &'static str {
    match state {
        RuntimeCapabilityState::Available => "available",
        RuntimeCapabilityState::NotCompiled => "not_compiled",
        RuntimeCapabilityState::NotConfigured => "not_configured",
        RuntimeCapabilityState::UnsupportedPlatform => "unsupported_platform",
        RuntimeCapabilityState::DependencyMissing => "dependency_missing",
        RuntimeCapabilityState::RuntimeUnavailable => "runtime_unavailable",
    }
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_covers_every_external_dependency_capability() {
        let report = report();
        let names: Vec<_> = report.iter().map(|status| status.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "deploy_app",
                "remote_session_restore",
                "devbox_login",
                "git_change_serialization",
                "voice_capture",
            ]
        );
        assert!(
            report
                .iter()
                .find(|status| status.name == "git_change_serialization")
                .unwrap()
                .available
        );
        assert!(
            report
                .iter()
                .filter(|status| !status.available)
                .all(|status| {
                    status
                        .reason
                        .as_deref()
                        .is_some_and(|reason| !reason.is_empty())
                })
        );
    }
}

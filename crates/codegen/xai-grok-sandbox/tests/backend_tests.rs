//! Integration tests for the cross-platform sandbox backend trait.

use std::path::{Path, PathBuf};

use xai_grok_sandbox::backend::{
    AccessMode, NoopSandboxBackend, SandboxBackend, SandboxStatus,
    SandboxSupportInfo, create_backend,
};

// ── NoopSandboxBackend ──────────────────────────────────────────────────────

#[test]
fn noop_backend_platform_id() {
    let backend = NoopSandboxBackend::new();
    assert_eq!(backend.platform_id(), "noop");
}

#[test]
fn noop_backend_is_always_available() {
    let backend = NoopSandboxBackend::new();
    assert!(backend.is_available());
}

#[test]
fn noop_backend_support_info_reports_unsupported() {
    let backend = NoopSandboxBackend::new();
    let info = backend.support_info();
    assert!(!info.is_supported);
    assert_eq!(info.platform_id, "noop");
    assert!(!info.details.is_empty());
}

#[test]
fn noop_backend_starts_not_applied() {
    let backend = NoopSandboxBackend::new();
    assert_eq!(backend.status(), SandboxStatus::NotApplied);
}

#[test]
fn noop_backend_apply_transitions_to_disabled() {
    let mut backend = NoopSandboxBackend::new();
    backend.apply(Path::new("/tmp")).unwrap();
    assert_eq!(backend.status(), SandboxStatus::Disabled);
}

#[test]
fn noop_backend_check_file_access_always_true() {
    let backend = NoopSandboxBackend::new();
    assert!(backend.check_file_access(Path::new("/any/path"), AccessMode::Read));
    assert!(backend.check_file_access(
        Path::new("/any/path"),
        AccessMode::ReadWrite
    ));
}

#[test]
fn noop_backend_default_trait_impl() {
    let backend = NoopSandboxBackend::default();
    assert_eq!(backend.platform_id(), "noop");
}

// ── Factory ─────────────────────────────────────────────────────────────────

#[test]
fn create_backend_returns_non_null() {
    let backend = create_backend();
    // Should return a valid backend; platform_id is always non-empty.
    assert!(!backend.platform_id().is_empty());
}

#[test]
fn create_backend_returns_correct_platform_id() {
    let backend = create_backend();
    let id = backend.platform_id();
    #[cfg(target_os = "linux")]
    assert_eq!(id, "linux/landlock");

    #[cfg(target_os = "macos")]
    assert_eq!(id, "macos/seatbelt");

    #[cfg(target_os = "windows")]
    {
        // On Windows, the factory tries AppContainer first, then Job Object.
        assert!(
            id == "windows/appcontainer" || id == "windows/job_object" || id == "noop",
            "unexpected platform_id on Windows: {id}"
        );
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    assert_eq!(id, "noop");
}

// ── Linux backend ───────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use xai_grok_sandbox::linux_backend::LinuxSandboxBackend;

    #[test]
    fn linux_backend_platform_id() {
        let backend = LinuxSandboxBackend::new();
        assert_eq!(backend.platform_id(), "linux/landlock");
    }

    #[test]
    fn linux_backend_starts_not_applied() {
        let backend = LinuxSandboxBackend::new();
        assert_eq!(backend.status(), SandboxStatus::NotApplied);
    }

    #[test]
    fn linux_backend_check_file_access_always_true() {
        let backend = LinuxSandboxBackend::new();
        assert!(backend.check_file_access(Path::new("/tmp"), AccessMode::Read));
    }

    #[test]
    fn linux_backend_support_info_has_platform_id() {
        let backend = LinuxSandboxBackend::new();
        let info = backend.support_info();
        assert_eq!(info.platform_id, "linux/landlock");
    }
}

// ── macOS backend ───────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use xai_grok_sandbox::macos_backend::MacOSSandboxBackend;

    #[test]
    fn macos_backend_platform_id() {
        let backend = MacOSSandboxBackend::new();
        assert_eq!(backend.platform_id(), "macos/seatbelt");
    }

    #[test]
    fn macos_backend_starts_not_applied() {
        let backend = MacOSSandboxBackend::new();
        assert_eq!(backend.status(), SandboxStatus::NotApplied);
    }

    #[test]
    fn macos_backend_check_file_access_always_true() {
        let backend = MacOSSandboxBackend::new();
        assert!(backend.check_file_access(Path::new("/tmp"), AccessMode::Read));
    }

    #[test]
    fn macos_backend_support_info_has_platform_id() {
        let backend = MacOSSandboxBackend::new();
        let info = backend.support_info();
        assert_eq!(info.platform_id, "macos/seatbelt");
    }
}

// ── Windows backend ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_tests {
    use super::*;
    use xai_grok_sandbox::windows::appcontainer::WindowsAppContainerBackend;
    use xai_grok_sandbox::windows::job_object::WindowsJobObjectBackend;
    use xai_grok_sandbox::windows::file_policy::WindowsFilePolicy;
    use xai_grok_sandbox::windows::network_policy::{
        NetworkRestriction, WindowsNetworkPolicy, WfpAction, WfpFilterRule,
    };

    #[test]
    fn appcontainer_platform_id() {
        let backend = WindowsAppContainerBackend::new();
        assert_eq!(backend.platform_id(), "windows/appcontainer");
    }

    #[test]
    fn appcontainer_support_info() {
        let backend = WindowsAppContainerBackend::new();
        let info = backend.support_info();
        assert_eq!(info.platform_id, "windows/appcontainer");
    }

    #[test]
    fn job_object_platform_id() {
        let backend = WindowsJobObjectBackend::new();
        assert_eq!(backend.platform_id(), "windows/job_object");
    }

    #[test]
    fn job_object_is_available() {
        let backend = WindowsJobObjectBackend::new();
        assert!(backend.is_available());
    }

    #[test]
    fn job_object_apply_and_status() {
        let mut backend = WindowsJobObjectBackend::new();
        assert_eq!(backend.status(), SandboxStatus::NotApplied);
        backend.apply(Path::new("C:\\workspace")).unwrap();
        assert_eq!(backend.status(), SandboxStatus::Active);
    }

    #[test]
    fn job_object_check_file_access_always_true() {
        let backend = WindowsJobObjectBackend::new();
        assert!(backend.check_file_access(
            Path::new("C:\\workspace\\file.txt"),
            AccessMode::ReadWrite
        ));
    }

    #[test]
    fn file_policy_deny_overrides() {
        let mut policy = WindowsFilePolicy::new();
        policy.add_read_path(PathBuf::from("C:\\workspace"));
        policy.add_read_write_path(PathBuf::from("C:\\workspace\\output"));
        policy.add_deny_path(PathBuf::from("C:\\workspace\\secrets"));

        assert!(policy.check_access(
            Path::new("C:\\workspace\\file.txt"),
            AccessMode::Read
        ));
        assert!(policy.check_access(
            Path::new("C:\\workspace\\output\\result.txt"),
            AccessMode::ReadWrite
        ));
        assert!(!policy.check_access(
            Path::new("C:\\workspace\\secrets\\key.pem"),
            AccessMode::Read
        ));
    }

    #[test]
    fn network_policy_blocked() {
        let policy = WindowsNetworkPolicy::blocked();
        assert_eq!(policy.restriction(), NetworkRestriction::Blocked);
        assert!(!policy.check_connection("10.0.0.1", 443));
    }

    #[test]
    fn network_policy_allowlist() {
        let policy = WindowsNetworkPolicy::allowlist(vec![WfpFilterRule {
            name: "allow-https".to_string(),
            protocol: "TCP".to_string(),
            remote_address: "api.example.com".to_string(),
            remote_port: 443,
            action: WfpAction::Permit,
        }]);
        assert!(policy.check_connection("api.example.com", 443));
        assert!(!policy.check_connection("evil.com", 443));
    }

    #[test]
    fn factory_selects_best_windows_backend() {
        let backend = create_backend();
        let id = backend.platform_id();
        assert!(
            id == "windows/appcontainer" || id == "windows/job_object" || id == "noop",
            "unexpected Windows backend: {id}"
        );
    }
}

// ── SandboxStatus / SandboxSupportInfo serialization ────────────────────────

#[test]
fn sandbox_status_serializes_and_deserializes() {
    let statuses = [
        SandboxStatus::NotApplied,
        SandboxStatus::Active,
        SandboxStatus::Degraded,
        SandboxStatus::Disabled,
        SandboxStatus::Failed,
    ];
    for status in &statuses {
        let json = serde_json::to_string(status).unwrap();
        let deserialized: SandboxStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(*status, deserialized);
    }
}

#[test]
fn sandbox_support_info_serializes_and_deserializes() {
    let info = SandboxSupportInfo {
        is_supported: true,
        platform_id: "test/platform".to_string(),
        details: "Test details".to_string(),
    };
    let json = serde_json::to_string(&info).unwrap();
    let deserialized: SandboxSupportInfo = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.is_supported, info.is_supported);
    assert_eq!(deserialized.platform_id, info.platform_id);
    assert_eq!(deserialized.details, info.details);
}

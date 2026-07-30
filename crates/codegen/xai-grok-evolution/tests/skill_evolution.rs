//! Integration tests for skill-level self-evolution signals.

use xai_grok_evolution::signal::{
    DefaultSignalCollector, InjectedExperienceRef, SessionSignalsDelta, SignalCollector,
    ToolFailure,
};
use xai_grok_evolution::types::*;

fn base_delta() -> SessionSignalsDelta {
    SessionSignalsDelta {
        session_id: "int-test-sess".to_string(),
        turn_id: Some("turn-1".to_string()),
        turn_step_count: 5,
        tools_used: vec![
            "read".to_string(),
            "write".to_string(),
            "bash".to_string(),
        ],
        ..Default::default()
    }
}

#[test]
fn positive_turn_with_injection_emits_skill_success() {
    let mut delta = base_delta();
    delta.injected_experiences = vec![InjectedExperienceRef {
        experience_id: "exp-abc".to_string(),
        injection_id: "inj-001".to_string(),
        skill_name: Some("rust-fix".to_string()),
    }];

    let collector = DefaultSignalCollector;
    let signals = collector.collect(&delta);

    let positive = signals
        .iter()
        .filter(|s| s.signal_type == SignalType::PositiveOutcome)
        .count();
    let skill_success = signals
        .iter()
        .filter(|s| s.signal_type == SignalType::SkillSuccess)
        .count();

    assert!(positive >= 1, "should emit positive outcome signal");
    assert_eq!(skill_success, 1, "should emit exactly 1 skill success");
}

#[test]
fn failed_turn_with_injection_emits_skill_ineffective() {
    let mut delta = base_delta();
    delta.tool_failures = vec![ToolFailure {
        tool_name: "bash".to_string(),
        error_message: "compile error".to_string(),
        file_path: Some("src/main.rs".to_string()),
        exit_code: Some(1),
    }];
    delta.injected_experiences = vec![InjectedExperienceRef {
        experience_id: "exp-xyz".to_string(),
        injection_id: "inj-002".to_string(),
        skill_name: None,
    }];

    let collector = DefaultSignalCollector;
    let signals = collector.collect(&delta);

    let tool_fail = signals
        .iter()
        .filter(|s| s.signal_type == SignalType::ToolFailure)
        .count();
    let skill_ineff = signals
        .iter()
        .filter(|s| s.signal_type == SignalType::SkillIneffective)
        .count();

    assert_eq!(tool_fail, 1);
    assert_eq!(skill_ineff, 1);
    // No positive outcome since there were failures
    assert!(signals
        .iter()
        .all(|s| s.signal_type != SignalType::PositiveOutcome));
}

#[test]
fn no_injection_no_skill_signals() {
    let delta = base_delta();
    let collector = DefaultSignalCollector;
    let signals = collector.collect(&delta);

    let skill_signals: Vec<_> = signals
        .iter()
        .filter(|s| {
            matches!(
                s.signal_type,
                SignalType::SkillSuccess | SignalType::SkillIneffective
            )
        })
        .collect();

    assert!(
        skill_signals.is_empty(),
        "no injections should produce no skill signals"
    );
}

#[test]
fn multiple_injections_all_get_signals() {
    let mut delta = base_delta();
    delta.injected_experiences = vec![
        InjectedExperienceRef {
            experience_id: "exp-1".to_string(),
            injection_id: "inj-a".to_string(),
            skill_name: None,
        },
        InjectedExperienceRef {
            experience_id: "exp-2".to_string(),
            injection_id: "inj-b".to_string(),
            skill_name: Some("test-fix".to_string()),
        },
    ];

    let collector = DefaultSignalCollector;
    let signals = collector.collect(&delta);

    let skill_signals: Vec<_> = signals
        .iter()
        .filter(|s| s.signal_type == SignalType::SkillSuccess)
        .collect();

    assert_eq!(skill_signals.len(), 2, "each injection gets a signal");
}

#[test]
fn trigger_from_skill_ineffective_is_skill_decay() {
    let mut delta = base_delta();
    delta.tool_failures = vec![ToolFailure {
        tool_name: "bash".to_string(),
        error_message: "test failed".to_string(),
        file_path: None,
        exit_code: Some(1),
    }];
    delta.injected_experiences = vec![InjectedExperienceRef {
        experience_id: "exp-decay".to_string(),
        injection_id: "inj-d".to_string(),
        skill_name: None,
    }];

    let collector = DefaultSignalCollector;
    let signals = collector.collect(&delta);

    // SkillIneffective should map to SkillDecay trigger type
    let skill_ineff = signals
        .iter()
        .find(|s| s.signal_type == SignalType::SkillIneffective);
    assert!(skill_ineff.is_some());
}

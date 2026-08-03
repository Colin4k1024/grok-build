//! Skill-level signal extraction from injected experiences.
//!
//! When an experience is injected into a turn, we observe the turn outcome
//! and emit SkillSuccess or SkillIneffective signals for each injection.
//! These feed into the confidence system and enable skill decay detection.

use crate::signal::classifier;
use crate::types::*;

use super::SessionSignalsDelta;

/// Determine whether the turn had failure signals.
pub fn turn_has_failures(delta: &SessionSignalsDelta) -> bool {
    !delta.tool_failures.is_empty()
        || !delta.test_failures.is_empty()
        || !delta.timeouts.is_empty()
        || !delta.panics.is_empty()
        || !delta.compilation_errors.is_empty()
        || !delta.retries_exhausted.is_empty()
}

/// Extract skill-level signals from injected experiences based on turn outcome.
///
/// For each injected experience in the delta:
/// - If turn completed without failures → SkillSuccess (Low severity)
/// - If turn had failures → SkillIneffective (Medium severity)
///
/// Returns an empty vec if no experiences were injected.
pub fn observe_skill_signals(delta: &SessionSignalsDelta) -> Vec<EvolutionSignal> {
    if delta.injected_experiences.is_empty() {
        return Vec::new();
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let has_failures = turn_has_failures(delta);

    delta
        .injected_experiences
        .iter()
        .enumerate()
        .map(|(i, exp)| {
            let (signal_type, severity, desc) = if has_failures {
                (
                    SignalType::SkillIneffective,
                    SignalSeverity::Medium,
                    format!(
                        "Injected experience (index {}) did not prevent failures in turn",
                        i
                    ),
                )
            } else {
                (
                    SignalType::SkillSuccess,
                    SignalSeverity::Low,
                    format!(
                        "Injected experience (index {}) contributed to successful turn",
                        i
                    ),
                )
            };

            EvolutionSignal {
                signal_id: format!("{}-skill-{}", delta.session_id, i),
                schema_version: CURRENT_SCHEMA_VERSION,
                signal_type,
                severity,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: exp.skill_name.clone(),
                    file_path: None,
                },
                description: classifier::sanitize_description(&desc),
                context_hash: classifier::hash_context(&format!(
                    "skill:{}:{}",
                    exp.experience_id, exp.injection_id
                )),
                created_at: now,
            }
        })
        .collect()
}

/// Check if pre-filtered skill signals show decay.
///
/// Caller is responsible for filtering signals to only those relevant to a
/// specific experience. This avoids fragile text-based matching — the live
/// path uses `SkillTracker.is_decaying()` instead; this function is for
/// offline/batch analysis of stored signal slices.
///
/// Decay is detected when the ratio of SkillIneffective signals to total
/// skill signals exceeds `threshold` within the most recent `window` observations.
pub fn detect_skill_decay(
    skill_signals: &[EvolutionSignal],
    window: usize,
    threshold: f64,
) -> bool {
    let windowed: Vec<&EvolutionSignal> = skill_signals.iter().rev().take(window).collect();

    if windowed.len() < 3 {
        return false;
    }

    let ineffective_count = windowed
        .iter()
        .filter(|s| s.signal_type == SignalType::SkillIneffective)
        .count();

    let ratio = ineffective_count as f64 / windowed.len() as f64;
    ratio >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::{InjectedExperienceRef, ToolFailure};

    fn make_delta(
        injections: Vec<InjectedExperienceRef>,
        has_failure: bool,
    ) -> SessionSignalsDelta {
        SessionSignalsDelta {
            session_id: "sess-test".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool_failures: if has_failure {
                vec![ToolFailure {
                    tool_name: "terminal".to_string(),
                    error_message: "exit 1".to_string(),
                    file_path: None,
                    exit_code: Some(1),
                }]
            } else {
                vec![]
            },
            turn_step_count: 5,
            tools_used: vec!["read".to_string(), "write".to_string()],
            injected_experiences: injections,
            ..Default::default()
        }
    }

    #[test]
    fn no_injections_produces_no_signals() {
        let delta = make_delta(vec![], false);
        let signals = observe_skill_signals(&delta);
        assert!(signals.is_empty());
    }

    #[test]
    fn successful_turn_produces_skill_success() {
        let delta = make_delta(
            vec![InjectedExperienceRef {
                experience_id: "exp-1".to_string(),
                injection_id: "inj-1".to_string(),
                skill_name: Some("rust-fix".to_string()),
            }],
            false,
        );
        let signals = observe_skill_signals(&delta);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].signal_type, SignalType::SkillSuccess);
        assert_eq!(signals[0].severity, SignalSeverity::Low);
    }

    #[test]
    fn failed_turn_produces_skill_ineffective() {
        let delta = make_delta(
            vec![InjectedExperienceRef {
                experience_id: "exp-1".to_string(),
                injection_id: "inj-1".to_string(),
                skill_name: None,
            }],
            true,
        );
        let signals = observe_skill_signals(&delta);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].signal_type, SignalType::SkillIneffective);
        assert_eq!(signals[0].severity, SignalSeverity::Medium);
    }

    #[test]
    fn multiple_injections_produce_multiple_signals() {
        let delta = make_delta(
            vec![
                InjectedExperienceRef {
                    experience_id: "exp-1".to_string(),
                    injection_id: "inj-1".to_string(),
                    skill_name: None,
                },
                InjectedExperienceRef {
                    experience_id: "exp-2".to_string(),
                    injection_id: "inj-2".to_string(),
                    skill_name: Some("go-test".to_string()),
                },
            ],
            false,
        );
        let signals = observe_skill_signals(&delta);
        assert_eq!(signals.len(), 2);
        assert!(
            signals
                .iter()
                .all(|s| s.signal_type == SignalType::SkillSuccess)
        );
    }

    #[test]
    fn decay_not_detected_with_few_observations() {
        let signals = vec![make_signal(SignalType::SkillIneffective, "exp-1")];
        assert!(!detect_skill_decay(&signals, 10, 0.4));
    }

    #[test]
    fn decay_detected_when_threshold_exceeded() {
        let signals = vec![
            make_signal(SignalType::SkillIneffective, "exp-1"),
            make_signal(SignalType::SkillIneffective, "exp-1"),
            make_signal(SignalType::SkillIneffective, "exp-1"),
            make_signal(SignalType::SkillSuccess, "exp-1"),
        ];
        // 3/4 = 0.75 > 0.4 threshold
        assert!(detect_skill_decay(&signals, 10, 0.4));
    }

    #[test]
    fn decay_not_detected_when_below_threshold() {
        let signals = vec![
            make_signal(SignalType::SkillSuccess, "exp-1"),
            make_signal(SignalType::SkillSuccess, "exp-1"),
            make_signal(SignalType::SkillSuccess, "exp-1"),
            make_signal(SignalType::SkillIneffective, "exp-1"),
        ];
        // 1/4 = 0.25 < 0.4 threshold
        assert!(!detect_skill_decay(&signals, 10, 0.4));
    }

    #[test]
    fn decay_respects_window_size() {
        let mut signals = Vec::new();
        // 7 successes followed by 3 ineffectives
        for _ in 0..7 {
            signals.push(make_signal(SignalType::SkillSuccess, "exp-1"));
        }
        for _ in 0..3 {
            signals.push(make_signal(SignalType::SkillIneffective, "exp-1"));
        }
        // Window of 5: takes last 5 → 3 ineffective + 2 success = 3/5 = 0.6 > 0.4
        assert!(detect_skill_decay(&signals, 5, 0.4));
        // Window of 10: all 10 → 3/10 = 0.3 < 0.4
        assert!(!detect_skill_decay(&signals, 10, 0.4));
    }

    fn make_signal(signal_type: SignalType, exp_id: &str) -> EvolutionSignal {
        EvolutionSignal {
            signal_id: uuid::Uuid::new_v4().to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            signal_type,
            severity: SignalSeverity::Low,
            source: SignalSource {
                session_id: "test".to_string(),
                turn_id: None,
                tool_name: None,
                file_path: None,
            },
            description: format!("experience {} signal", exp_id),
            context_hash: "hash".to_string(),
            created_at: 0,
        }
    }
}

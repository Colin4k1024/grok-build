//! Signal collection, classification, and queueing.
//!
//! Signals are extracted from session events (tool failures, test failures,
//! user corrections, etc.) and classified by deterministic rules. LLM is
//! only used for summarization and task-type inference (not in this module).

pub mod classifier;
pub mod correction;
pub mod queue;
pub mod skill_observer;

use crate::types::*;

/// Trait for collecting raw signals from session events.
///
/// Implementations extract normalized `EvolutionSignal` values from
/// session deltas. The classifier module applies deterministic rules
/// for dedup, severity, and type assignment.
pub trait SignalCollector: Send + Sync {
    /// Extract signals from a raw session delta.
    ///
    /// Returns zero or more classified, deduplicated signals.
    fn collect(&self, delta: &SessionSignalsDelta) -> Vec<EvolutionSignal>;
}

/// Raw session signals delta — the input to signal collection.
///
/// This mirrors the data available at turn end from the session actor.
/// All string fields must already be sanitized (no secrets).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionSignalsDelta {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub tool_failures: Vec<ToolFailure>,
    pub test_failures: Vec<TestFailure>,
    pub timeouts: Vec<TimeoutInfo>,
    pub panics: Vec<PanicInfo>,
    pub user_corrections: Vec<UserCorrection>,
    pub negative_feedback: Vec<NegativeFeedback>,
    pub performance_regressions: Vec<PerformanceRegression>,
    pub retries_exhausted: Vec<RetryExhausted>,
    pub compilation_errors: Vec<CompilationError>,
    #[serde(default)]
    pub turn_step_count: usize,
    #[serde(default)]
    pub tools_used: Vec<String>,
    #[serde(default)]
    pub injected_experiences: Vec<InjectedExperienceRef>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InjectedExperienceRef {
    pub experience_id: String,
    pub injection_id: String,
    #[serde(default)]
    pub skill_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolFailure {
    pub tool_name: String,
    pub error_message: String,
    pub file_path: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TestFailure {
    pub test_name: String,
    pub error_message: String,
    pub file_path: Option<String>,
    pub package: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TimeoutInfo {
    pub operation: String,
    pub timeout_secs: u64,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PanicInfo {
    pub message: String,
    pub file_path: Option<String>,
    pub backtrace_hash: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UserCorrection {
    pub original_action: String,
    pub correction: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NegativeFeedback {
    pub rating: i32, // negative values
    pub comment: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PerformanceRegression {
    pub metric: String,
    pub baseline: f64,
    pub actual: f64,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetryExhausted {
    pub operation: String,
    pub attempts: u32,
    pub last_error: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompilationError {
    pub error_message: String,
    pub file_path: Option<String>,
    pub package: Option<String>,
}

/// Default signal collector implementation.
///
/// Uses deterministic rules for classification, dedup, and severity.
/// No LLM calls — purely rule-based.
pub struct DefaultSignalCollector;

impl SignalCollector for DefaultSignalCollector {
    fn collect(&self, delta: &SessionSignalsDelta) -> Vec<EvolutionSignal> {
        let mut signals = Vec::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        for (i, failure) in delta.tool_failures.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-tool-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::ToolFailure,
                severity: classifier::classify_tool_failure_severity(failure),
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: Some(failure.tool_name.clone()),
                    file_path: failure.file_path.clone(),
                },
                description: classifier::sanitize_description(&failure.error_message),
                context_hash: classifier::hash_context(&failure.error_message),
                created_at: now,
            });
        }

        for (i, failure) in delta.test_failures.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-test-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::TestFailure,
                severity: SignalSeverity::High,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: Some("terminal".to_string()),
                    file_path: failure.file_path.clone(),
                },
                description: classifier::sanitize_description(&failure.error_message),
                context_hash: classifier::hash_context(&failure.error_message),
                created_at: now,
            });
        }

        for (i, info) in delta.timeouts.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-timeout-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::Timeout,
                severity: if info.timeout_secs > 300 {
                    SignalSeverity::High
                } else {
                    SignalSeverity::Medium
                },
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: info.tool_name.clone(),
                    file_path: None,
                },
                description: classifier::sanitize_description(&format!(
                    "Operation '{}' timed out after {}s",
                    info.operation, info.timeout_secs
                )),
                context_hash: classifier::hash_context(&info.operation),
                created_at: now,
            });
        }

        for (i, info) in delta.panics.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-panic-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::Panic,
                severity: SignalSeverity::Critical,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: info.file_path.clone(),
                },
                description: classifier::sanitize_description(&info.message),
                context_hash: classifier::hash_context(&info.message),
                created_at: now,
            });
        }

        for (i, correction) in delta.user_corrections.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-correction-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::UserCorrection,
                severity: SignalSeverity::Medium,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: None,
                },
                description: classifier::sanitize_description(&format!(
                    "User corrected: {} → {}",
                    correction.original_action, correction.correction
                )),
                context_hash: classifier::hash_context(&correction.original_action),
                created_at: now,
            });
        }

        for (i, fb) in delta.negative_feedback.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-feedback-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::NegativeFeedback,
                severity: if fb.rating <= -2 {
                    SignalSeverity::High
                } else {
                    SignalSeverity::Medium
                },
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: None,
                },
                description: classifier::sanitize_description(
                    fb.comment.as_deref().unwrap_or("negative feedback"),
                ),
                context_hash: classifier::hash_context(&fb.rating.to_string()),
                created_at: now,
            });
        }

        for (i, reg) in delta.performance_regressions.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-perf-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::PerformanceRegression,
                severity: classifier::classify_perf_severity(reg),
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: reg.file_path.clone(),
                },
                description: classifier::sanitize_description(&format!(
                    "Performance regression: {} went from {} to {}",
                    reg.metric, reg.baseline, reg.actual
                )),
                context_hash: classifier::hash_context(&reg.metric),
                created_at: now,
            });
        }

        for (i, retry) in delta.retries_exhausted.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-retry-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::RetryExhausted,
                severity: SignalSeverity::High,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: None,
                },
                description: classifier::sanitize_description(&format!(
                    "Retries exhausted for '{}' after {} attempts: {}",
                    retry.operation, retry.attempts, retry.last_error
                )),
                context_hash: classifier::hash_context(&retry.operation),
                created_at: now,
            });
        }

        for (i, err) in delta.compilation_errors.iter().enumerate() {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-compile-{}", delta.session_id, i),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::CompilationError,
                severity: SignalSeverity::High,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: err.file_path.clone(),
                },
                description: classifier::sanitize_description(&err.error_message),
                context_hash: classifier::hash_context(&err.error_message),
                created_at: now,
            });
        }

        // Positive outcome: non-trivial successful turn with no failures
        if delta.turn_step_count >= 3
            && delta.tools_used.len() >= 2
            && signals.iter().all(|s| {
                !matches!(
                    s.signal_type,
                    SignalType::ToolFailure
                        | SignalType::TestFailure
                        | SignalType::Timeout
                        | SignalType::Panic
                        | SignalType::CompilationError
                )
            })
        {
            signals.push(EvolutionSignal {
                signal_id: format!("{}-positive-0", delta.session_id),
                schema_version: crate::types::CURRENT_SCHEMA_VERSION,
                signal_type: SignalType::PositiveOutcome,
                severity: SignalSeverity::Low,
                source: SignalSource {
                    session_id: delta.session_id.clone(),
                    turn_id: delta.turn_id.clone(),
                    tool_name: None,
                    file_path: None,
                },
                description: classifier::sanitize_description(&format!(
                    "Successful turn with {} steps using {} tools",
                    delta.turn_step_count,
                    delta.tools_used.len()
                )),
                context_hash: classifier::hash_context(&format!(
                    "positive:{}:{}",
                    delta.turn_step_count,
                    delta.tools_used.join(",")
                )),
                created_at: now,
            });
        }

        // Skill-level signals from injected experiences
        signals.extend(skill_observer::observe_skill_signals(delta));

        // Dedup by context_hash
        classifier::dedup_signals(&mut signals);

        signals
    }
}

/// Create an empty session signals delta (for when no signals are detected).
impl Default for SessionSignalsDelta {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            turn_id: None,
            tool_failures: vec![],
            test_failures: vec![],
            timeouts: vec![],
            panics: vec![],
            user_corrections: vec![],
            negative_feedback: vec![],
            performance_regressions: vec![],
            retries_exhausted: vec![],
            compilation_errors: vec![],
            turn_step_count: 0,
            tools_used: vec![],
            injected_experiences: vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collector() -> DefaultSignalCollector {
        DefaultSignalCollector
    }

    #[test]
    fn empty_delta_produces_no_signals() {
        let delta = SessionSignalsDelta::default();
        let signals = collector().collect(&delta);
        assert!(signals.is_empty());
    }

    #[test]
    fn tool_failure_produces_signal() {
        let delta = SessionSignalsDelta {
            session_id: "sess-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool_failures: vec![ToolFailure {
                tool_name: "terminal".to_string(),
                error_message: "command not found".to_string(),
                file_path: None,
                exit_code: Some(127),
            }],
            ..Default::default()
        };
        let signals = collector().collect(&delta);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].signal_type, SignalType::ToolFailure);
    }

    #[test]
    fn test_failure_is_high_severity() {
        let delta = SessionSignalsDelta {
            session_id: "sess-1".to_string(),
            test_failures: vec![TestFailure {
                test_name: "test_parse".to_string(),
                error_message: "assertion failed".to_string(),
                file_path: Some("src/parser.rs".to_string()),
                package: Some("my-crate".to_string()),
            }],
            ..Default::default()
        };
        let signals = collector().collect(&delta);
        assert_eq!(signals[0].severity, SignalSeverity::High);
    }

    #[test]
    fn panic_is_critical() {
        let delta = SessionSignalsDelta {
            session_id: "sess-1".to_string(),
            panics: vec![PanicInfo {
                message: "index out of bounds".to_string(),
                file_path: Some("src/main.rs".to_string()),
                backtrace_hash: None,
            }],
            ..Default::default()
        };
        let signals = collector().collect(&delta);
        assert_eq!(signals[0].severity, SignalSeverity::Critical);
    }

    #[test]
    fn multiple_signal_types() {
        let delta = SessionSignalsDelta {
            session_id: "sess-1".to_string(),
            tool_failures: vec![ToolFailure {
                tool_name: "editor".to_string(),
                error_message: "permission denied".to_string(),
                file_path: None,
                exit_code: None,
            }],
            test_failures: vec![TestFailure {
                test_name: "test_it".to_string(),
                error_message: "failed".to_string(),
                file_path: None,
                package: None,
            }],
            user_corrections: vec![UserCorrection {
                original_action: "delete file".to_string(),
                correction: "edit file instead".to_string(),
            }],
            ..Default::default()
        };
        let signals = collector().collect(&delta);
        assert_eq!(signals.len(), 3);
    }

    #[test]
    fn dedup_by_context_hash() {
        let delta = SessionSignalsDelta {
            session_id: "sess-1".to_string(),
            tool_failures: vec![
                ToolFailure {
                    tool_name: "terminal".to_string(),
                    error_message: "same error".to_string(),
                    file_path: None,
                    exit_code: Some(1),
                },
                ToolFailure {
                    tool_name: "terminal".to_string(),
                    error_message: "same error".to_string(),
                    file_path: None,
                    exit_code: Some(1),
                },
            ],
            ..Default::default()
        };
        let signals = collector().collect(&delta);
        assert_eq!(signals.len(), 1); // deduplicated
    }
}

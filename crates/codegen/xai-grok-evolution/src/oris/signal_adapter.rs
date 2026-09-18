//! Signal adapter: grok-build SessionSignalsDelta → Oris EvolutionSignal.
//!
//! Implements `oris_evolution::port::SignalExtractorPort` by translating
//! grok-build's structured session signals into Oris's `EvolutionSignal` format.

use oris_evolution::port::{SignalExtractorInput, SignalExtractorPort};
use oris_evolution::{EvolutionSignal as OrisSignal, SignalType as OrisSignalType};

use crate::signal::SessionSignalsDelta;

/// Grok-to-Oris signal extractor.
///
/// Takes raw session delta data and produces Oris-compatible signals.
/// For the initial integration, signals are pre-classified by grok-build's
/// `DefaultSignalCollector` and converted to Oris format here.
pub struct GrokSignalExtractor;

impl GrokSignalExtractor {
    /// Convert a grok-build session delta into Oris signals.
    pub fn extract_from_delta(delta: &SessionSignalsDelta) -> Vec<OrisSignal> {
        let mut signals = Vec::new();

        for (i, failure) in delta.tool_failures.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-tool-{}", delta.session_id, i),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "tool_failure".to_string(),
                    frequency: 1,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.8,
                description: failure.error_message.clone(),
                metadata: serde_json::json!({
                    "tool": failure.tool_name,
                    "file": failure.file_path,
                    "exit_code": failure.exit_code,
                }),
            });
        }

        for (i, failure) in delta.test_failures.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-test-{}", delta.session_id, i),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "test_failure".to_string(),
                    frequency: 1,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.9,
                description: format!("{}: {}", failure.test_name, failure.error_message),
                metadata: serde_json::json!({
                    "test": failure.test_name,
                    "file": failure.file_path,
                    "package": failure.package,
                }),
            });
        }

        for (i, info) in delta.timeouts.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-timeout-{}", delta.session_id, i),
                signal_type: OrisSignalType::Performance {
                    metric: "timeout".to_string(),
                    improvement_potential: 0.5,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.7,
                description: format!("Operation '{}' timed out after {}s", info.operation, info.timeout_secs),
                metadata: serde_json::json!({
                    "operation": info.operation,
                    "timeout_secs": info.timeout_secs,
                    "tool": info.tool_name,
                }),
            });
        }

        for (i, info) in delta.panics.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-panic-{}", delta.session_id, i),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "panic".to_string(),
                    frequency: 1,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.95,
                description: info.message.clone(),
                metadata: serde_json::json!({
                    "file": info.file_path,
                    "backtrace_hash": info.backtrace_hash,
                }),
            });
        }

        for (i, correction) in delta.user_corrections.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-correction-{}", delta.session_id, i),
                signal_type: OrisSignalType::QualityIssue {
                    issue_type: "user_correction".to_string(),
                    severity: 0.6,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.85,
                description: format!("User corrected: {} → {}", correction.original_action, correction.correction),
                metadata: serde_json::json!({
                    "original": correction.original_action,
                    "correction": correction.correction,
                }),
            });
        }

        for (i, reg) in delta.performance_regressions.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-perf-{}", delta.session_id, i),
                signal_type: OrisSignalType::Performance {
                    metric: reg.metric.clone(),
                    improvement_potential: if reg.baseline > 0.0 {
                        ((reg.actual - reg.baseline) / reg.baseline).clamp(0.0, 1.0) as f32
                    } else {
                        0.5
                    },
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.75,
                description: format!("{}: {} → {}", reg.metric, reg.baseline, reg.actual),
                metadata: serde_json::json!({
                    "baseline": reg.baseline,
                    "actual": reg.actual,
                    "file": reg.file_path,
                }),
            });
        }

        for (i, retry) in delta.retries_exhausted.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-retry-{}", delta.session_id, i),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "retry_exhausted".to_string(),
                    frequency: retry.attempts,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.8,
                description: format!("Retries exhausted for '{}': {}", retry.operation, retry.last_error),
                metadata: serde_json::json!({
                    "operation": retry.operation,
                    "attempts": retry.attempts,
                }),
            });
        }

        for (i, err) in delta.compilation_errors.iter().enumerate() {
            signals.push(OrisSignal {
                signal_id: format!("{}-compile-{}", delta.session_id, i),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "compilation_error".to_string(),
                    frequency: 1,
                },
                source_task_id: delta.session_id.clone(),
                confidence: 0.9,
                description: err.error_message.clone(),
                metadata: serde_json::json!({
                    "file": err.file_path,
                    "package": err.package,
                }),
            });
        }

        signals
    }
}

impl SignalExtractorPort for GrokSignalExtractor {
    fn extract(&self, input: &SignalExtractorInput) -> Vec<OrisSignal> {
        // When called by the Oris pipeline, we parse the extra field
        // which may contain a serialized SessionSignalsDelta
        if let Ok(delta) = serde_json::from_value::<SessionSignalsDelta>(input.extra.clone()) {
            return Self::extract_from_delta(&delta);
        }

        // Fallback: synthesize signals from raw compiler output / stack trace
        let mut signals = Vec::new();

        if let Some(ref output) = input.compiler_output {
            signals.push(OrisSignal {
                signal_id: "compiler-output".to_string(),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "compilation".to_string(),
                    frequency: 1,
                },
                source_task_id: "pipeline".to_string(),
                confidence: 0.8,
                description: output.chars().take(500).collect(),
                metadata: serde_json::json!({ "source": "compiler_output" }),
            });
        }

        if let Some(ref trace) = input.stack_trace {
            signals.push(OrisSignal {
                signal_id: "stack-trace".to_string(),
                signal_type: OrisSignalType::ErrorPattern {
                    error_type: "runtime_error".to_string(),
                    frequency: 1,
                },
                source_task_id: "pipeline".to_string(),
                confidence: 0.85,
                description: trace.chars().take(500).collect(),
                metadata: serde_json::json!({ "source": "stack_trace" }),
            });
        }

        signals
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::{ToolFailure, TestFailure, SessionSignalsDelta};

    #[test]
    fn empty_delta_produces_no_oris_signals() {
        let delta = SessionSignalsDelta::default();
        let signals = GrokSignalExtractor::extract_from_delta(&delta);
        assert!(signals.is_empty());
    }

    #[test]
    fn tool_failure_maps_to_error_pattern() {
        let delta = SessionSignalsDelta {
            session_id: "sess-1".to_string(),
            tool_failures: vec![ToolFailure {
                tool_name: "terminal".to_string(),
                error_message: "command failed".to_string(),
                file_path: None,
                exit_code: Some(1),
            }],
            ..Default::default()
        };
        let signals = GrokSignalExtractor::extract_from_delta(&delta);
        assert_eq!(signals.len(), 1);
        match &signals[0].signal_type {
            OrisSignalType::ErrorPattern { error_type, .. } => {
                assert_eq!(error_type, "tool_failure");
            }
            _ => panic!("expected ErrorPattern"),
        }
        assert_eq!(signals[0].confidence, 0.8);
    }

    #[test]
    fn test_failure_high_confidence() {
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
        let signals = GrokSignalExtractor::extract_from_delta(&delta);
        assert_eq!(signals[0].confidence, 0.9);
    }

    #[test]
    fn port_trait_from_raw_input() {
        let extractor = GrokSignalExtractor;
        let input = SignalExtractorInput {
            compiler_output: Some("error[E0425]: cannot find value `x`".to_string()),
            ..Default::default()
        };
        let signals = extractor.extract(&input);
        assert_eq!(signals.len(), 1);
    }
}

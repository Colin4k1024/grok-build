//! Deterministic signal classification rules.
//!
//! All classification logic is rule-based. No LLM calls.
//! Sensitive data is scrubbed before storage.

use super::{PerformanceRegression, ToolFailure};
use crate::types::*;

/// Classify tool failure severity based on exit code and message patterns.
pub fn classify_tool_failure_severity(failure: &ToolFailure) -> SignalSeverity {
    // Permission errors are high (potential security issue)
    if failure.error_message.contains("permission denied")
        || failure.error_message.contains("EACCES")
        || failure.error_message.contains("Operation not permitted")
    {
        return SignalSeverity::High;
    }

    // Exit code 137 (OOM/SIGKILL) or 139 (SIGSEGV) are critical
    if matches!(failure.exit_code, Some(137) | Some(139)) {
        return SignalSeverity::Critical;
    }

    // Non-zero exit code is medium
    if failure.exit_code.unwrap_or(0) != 0 {
        return SignalSeverity::Medium;
    }

    SignalSeverity::Low
}

/// Classify performance regression severity.
pub fn classify_perf_severity(reg: &PerformanceRegression) -> SignalSeverity {
    if reg.baseline == 0.0 {
        return SignalSeverity::Low;
    }
    let ratio = reg.actual / reg.baseline;
    if ratio > 3.0 {
        SignalSeverity::Critical
    } else if ratio > 2.0 {
        SignalSeverity::High
    } else if ratio > 1.5 {
        SignalSeverity::Medium
    } else {
        SignalSeverity::Low
    }
}

/// Sanitize a description string, removing potential sensitive data.
///
/// Truncates to 500 chars and strips patterns that look like tokens/keys.
pub fn sanitize_description(raw: &str) -> String {
    let truncated: String = raw.chars().take(500).collect();
    // Basic scrubbing: remove anything that looks like an API key pattern
    // (long alphanumeric strings with specific prefixes)
    let lines: Vec<&str> = truncated.lines().collect();
    let sanitized: Vec<String> = lines
        .iter()
        .map(|line| {
            if line.contains("sk-")
                || line.contains("Bearer ")
                || line.contains("token=")
                || line.contains("password=")
                || line.contains("secret=")
            {
                "[REDACTED]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect();
    sanitized.join("\n")
}

/// Compute a blake3 hash of context for deduplication.
pub fn hash_context(context: &str) -> ContentHash {
    blake3::hash(context.as_bytes()).to_hex().to_string()
}

/// Remove duplicate signals based on context_hash.
///
/// Keeps the first occurrence of each unique hash.
pub fn dedup_signals(signals: &mut Vec<EvolutionSignal>) {
    let mut seen = std::collections::HashSet::new();
    signals.retain(|s| seen.insert(s.context_hash.clone()));
}

#[cfg(test)]
mod tests {
    use super::super::{PerformanceRegression, ToolFailure};
    use super::*;

    #[test]
    fn permission_denied_is_high() {
        let f = ToolFailure {
            tool_name: "editor".to_string(),
            error_message: "permission denied".to_string(),
            file_path: None,
            exit_code: None,
        };
        assert_eq!(classify_tool_failure_severity(&f), SignalSeverity::High);
    }

    #[test]
    fn sigsegv_is_critical() {
        let f = ToolFailure {
            tool_name: "terminal".to_string(),
            error_message: "segfault".to_string(),
            file_path: None,
            exit_code: Some(139),
        };
        assert_eq!(classify_tool_failure_severity(&f), SignalSeverity::Critical);
    }

    #[test]
    fn non_zero_exit_is_medium() {
        let f = ToolFailure {
            tool_name: "terminal".to_string(),
            error_message: "failed".to_string(),
            file_path: None,
            exit_code: Some(1),
        };
        assert_eq!(classify_tool_failure_severity(&f), SignalSeverity::Medium);
    }

    #[test]
    fn zero_exit_is_low() {
        let f = ToolFailure {
            tool_name: "terminal".to_string(),
            error_message: "warning only".to_string(),
            file_path: None,
            exit_code: Some(0),
        };
        assert_eq!(classify_tool_failure_severity(&f), SignalSeverity::Low);
    }

    #[test]
    fn perf_3x_is_critical() {
        let r = PerformanceRegression {
            metric: "latency".to_string(),
            baseline: 100.0,
            actual: 400.0,
            file_path: None,
        };
        assert_eq!(classify_perf_severity(&r), SignalSeverity::Critical);
    }

    #[test]
    fn perf_1_1x_is_low() {
        let r = PerformanceRegression {
            metric: "latency".to_string(),
            baseline: 100.0,
            actual: 110.0,
            file_path: None,
        };
        assert_eq!(classify_perf_severity(&r), SignalSeverity::Low);
    }

    #[test]
    fn sanitize_truncates() {
        let long = "a".repeat(1000);
        let result = sanitize_description(&long);
        assert!(result.len() <= 500);
    }

    #[test]
    fn sanitize_redacts_tokens() {
        let input = "Error with sk-abc123secretkey";
        let result = sanitize_description(input);
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("sk-abc123secretkey"));
    }

    #[test]
    fn dedup_removes_duplicates() {
        let mut signals = vec![
            EvolutionSignal {
                signal_id: "1".to_string(),
                schema_version: 1,
                signal_type: SignalType::ToolFailure,
                severity: SignalSeverity::Medium,
                source: SignalSource {
                    session_id: "s".to_string(),
                    turn_id: None,
                    tool_name: None,
                    file_path: None,
                },
                description: "err".to_string(),
                context_hash: "aaa".to_string(),
                created_at: 1000,
            },
            EvolutionSignal {
                signal_id: "2".to_string(),
                schema_version: 1,
                signal_type: SignalType::ToolFailure,
                severity: SignalSeverity::Medium,
                source: SignalSource {
                    session_id: "s".to_string(),
                    turn_id: None,
                    tool_name: None,
                    file_path: None,
                },
                description: "err".to_string(),
                context_hash: "aaa".to_string(), // same hash
                created_at: 1000,
            },
            EvolutionSignal {
                signal_id: "3".to_string(),
                schema_version: 1,
                signal_type: SignalType::TestFailure,
                severity: SignalSeverity::High,
                source: SignalSource {
                    session_id: "s".to_string(),
                    turn_id: None,
                    tool_name: None,
                    file_path: None,
                },
                description: "other".to_string(),
                context_hash: "bbb".to_string(), // different hash
                created_at: 1000,
            },
        ];
        dedup_signals(&mut signals);
        assert_eq!(signals.len(), 2);
    }
}

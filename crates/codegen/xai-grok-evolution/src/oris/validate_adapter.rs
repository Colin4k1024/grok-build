//! Validate adapter: Oris ValidatePort → grok-build validation.
//!
//! Implements `oris_evolution::port::ValidatePort` using grok-build's
//! validation infrastructure (cargo test, fmt --check, etc.).
//!
//! **P2 (Shadow mode)**: Returns a stub validation result.
//! **P3 (IsolatedAutonomous)**: Will run actual validation commands in the trial worktree.

use oris_evolution::port::{ValidateInput, ValidatePort};
use oris_evolution::evolver::ValidationResult as OrisValidationResult;

/// Grok validate adapter.
pub struct GrokValidateAdapter {
    shadow_mode: bool,
}

impl GrokValidateAdapter {
    pub fn new(shadow_mode: bool) -> Self {
        Self { shadow_mode }
    }
}

impl ValidatePort for GrokValidateAdapter {
    fn validate(&self, input: &ValidateInput) -> OrisValidationResult {
        if self.shadow_mode {
            // Shadow mode: simulate validation
            OrisValidationResult {
                proposal_id: input.proposal_id.clone(),
                passed: input.execution_success,
                score: if input.execution_success { 0.8 } else { 0.2 },
                issues: vec![],
                simulation_results: Some(serde_json::json!({
                    "mode": "shadow",
                    "simulated": true,
                })),
            }
        } else {
            // P3: Will run actual validation
            OrisValidationResult {
                proposal_id: input.proposal_id.clone(),
                passed: false,
                score: 0.0,
                issues: vec![oris_evolution::evolver::ValidationIssue {
                    severity: oris_evolution::evolver::IssueSeverity::Error,
                    description: "IsolatedAutonomous validation not yet implemented (P3)".to_string(),
                    location: None,
                }],
                simulation_results: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_mode_passes_when_execution_succeeds() {
        let adapter = GrokValidateAdapter::new(true);
        let input = ValidateInput {
            proposal_id: "p1".to_string(),
            execution_success: true,
            stdout: "ok".to_string(),
            stderr: String::new(),
        };
        let result = adapter.validate(&input);
        assert!(result.passed);
        assert!(result.score > 0.5);
    }

    #[test]
    fn shadow_mode_fails_when_execution_fails() {
        let adapter = GrokValidateAdapter::new(true);
        let input = ValidateInput {
            proposal_id: "p1".to_string(),
            execution_success: false,
            stdout: String::new(),
            stderr: "error".to_string(),
        };
        let result = adapter.validate(&input);
        assert!(!result.passed);
    }
}

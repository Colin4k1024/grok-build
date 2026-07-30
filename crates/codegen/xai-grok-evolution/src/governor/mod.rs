//! EvolutionGovernor: budget, promotion, quarantine, and circuit breaker integration.
//!
//! The governor enforces deterministic safety constraints that no model can override.

use crate::config::EvolutionGovernorConfig;
use crate::events::QuarantineReason;
use crate::state::confidence;
use crate::types::*;

pub mod budget;
pub mod promotion;
pub mod quarantine;

/// Budget status for a running evolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetStatus {
    /// Within budget, can continue.
    Ok,
    /// Budget exceeded, trial must stop.
    Exceeded { reason: String },
}

/// Governor that enforces evolution safety constraints.
pub struct EvolutionGovernor {
    config: EvolutionGovernorConfig,
}

impl EvolutionGovernor {
    pub fn new(config: EvolutionGovernorConfig) -> Self {
        Self { config }
    }

    /// Check if a run is within budget.
    pub fn check_budget(&self, run: &EvolutionRun, elapsed_secs: u64, rounds: u32) -> BudgetStatus {
        budget::check(run, elapsed_secs, rounds, self.config.quarantine_sla_secs)
    }

    /// Decide adoption based on evaluation result.
    pub fn decide_adoption(
        &self,
        eval_score: f64,
        safety_gate_passed: bool,
    ) -> AdoptionDecision {
        if !safety_gate_passed {
            return AdoptionDecision::Reject;
        }
        if eval_score >= 0.7 {
            AdoptionDecision::PublishCandidate
        } else if eval_score >= 0.4 {
            AdoptionDecision::Quarantine
        } else {
            AdoptionDecision::Reject
        }
    }

    /// Check if an experience should be promoted from Candidate to Active.
    pub fn check_promotion(&self, exp: &ExperienceRevision) -> Option<ConfidenceState> {
        promotion::check(exp, self.config.promote_after_successes)
    }

    /// Check if an experience should be quarantined.
    pub fn check_quarantine(&self, exp: &ExperienceRevision) -> Option<QuarantineReason> {
        quarantine::check(exp, self.config.quarantine_after_failures)
    }

    /// Apply confidence decay based on elapsed time.
    pub fn apply_decay(
        &self,
        current_confidence: f64,
        elapsed_days: f64,
    ) -> f64 {
        confidence::apply_decay(current_confidence, elapsed_days, self.config.confidence_half_life_days)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn governor() -> EvolutionGovernor {
        EvolutionGovernor::new(EvolutionGovernorConfig::default())
    }

    #[test]
    fn budget_ok_within_limits() {
        let gov = governor();
        let run = EvolutionRun {
            run_id: "r1".to_string(),
            schema_version: 1,
            state: RunState::Running,
            trigger: TriggerInfo {
                trigger_type: TriggerType::Manual,
                source_event_id: None,
                description: "".to_string(),
            },
            config_snapshot: ConfigSnapshot {
                mode: "shadow".to_string(),
                budget_max_duration_secs: 1200,
                budget_max_variant_rounds: 3,
            },
            started_at: 1000,
            completed_at: None,
            error: None,
        };
        assert_eq!(gov.check_budget(&run, 600, 2), BudgetStatus::Ok);
    }

    #[test]
    fn decide_adoption_rejects_when_safety_gate_fails() {
        let gov = governor();
        assert_eq!(gov.decide_adoption(0.9, false), AdoptionDecision::Reject);
    }

    #[test]
    fn decide_adoption_publishes_high_scores() {
        let gov = governor();
        assert_eq!(gov.decide_adoption(0.8, true), AdoptionDecision::PublishCandidate);
    }

    #[test]
    fn decide_adoption_quarantines_medium_scores() {
        let gov = governor();
        assert_eq!(gov.decide_adoption(0.5, true), AdoptionDecision::Quarantine);
    }

    #[test]
    fn decide_adoption_rejects_low_scores() {
        let gov = governor();
        assert_eq!(gov.decide_adoption(0.2, true), AdoptionDecision::Reject);
    }

    #[test]
    fn check_promotion_eligible() {
        let gov = governor();
        let exp = ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: 3,
            failure_count: 0,
            scope: ScopeFingerprint {
                repo: Some("org/repo".to_string()),
                task_type: Some("bug_fix".to_string()),
                signal_types: vec![SignalType::TestFailure],
                env_fingerprint: None,
            },
            content_hash: "abc".to_string(),
            created_at: 1000,
            updated_at: 1000,
        };
        let result = gov.check_promotion(&exp);
        assert!(result.is_some());
    }

    #[test]
    fn check_promotion_not_enough_successes() {
        let gov = governor();
        let exp = ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: 2,
            failure_count: 0,
            scope: ScopeFingerprint {
                repo: None,
                task_type: None,
                signal_types: vec![],
                env_fingerprint: None,
            },
            content_hash: "abc".to_string(),
            created_at: 1000,
            updated_at: 1000,
        };
        let result = gov.check_promotion(&exp);
        assert!(result.is_none());
    }

    #[test]
    fn check_quarantine_on_failures() {
        let gov = governor();
        let exp = ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: 1,
            failure_count: 2,
            scope: ScopeFingerprint {
                repo: None,
                task_type: None,
                signal_types: vec![],
                env_fingerprint: None,
            },
            content_hash: "abc".to_string(),
            created_at: 1000,
            updated_at: 1000,
        };
        let result = gov.check_quarantine(&exp);
        assert!(result.is_some());
    }

    #[test]
    fn apply_decay_uses_configured_half_life() {
        let gov = governor();
        // Default half_life = 30 days; after 30 days, confidence should halve
        let result = gov.apply_decay(1.0, 30.0);
        assert!((result - 0.5).abs() < 0.01);
    }
}

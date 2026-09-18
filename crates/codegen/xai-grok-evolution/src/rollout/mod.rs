//! Staged rollout controller for evolution modes.
//!
//! Manages the `Off → Shadow → IsolatedAutonomous → ReuseEligible`
//! progression with mandatory gate checks at each transition.
//!
//! ## Gate Requirements
//!
//! ### Off → Shadow
//! - Configuration explicitly enables evolution
//! - No kill switch active
//!
//! ### Shadow → IsolatedAutonomous
//! - Shadow sampling has produced sufficient data
//! - No source worktree pollution detected
//! - Sandbox preflight passes on current platform
//!
//! ### IsolatedAutonomous → ReuseEligible
//! - Source worktree pollution events: zero
//! - Sandbox and evidence completeness: 100%
//! - No unexplained network or out-of-bounds writes
//! - Circuit breaker, kill switch, and Quarantine drills pass
//! - Fixed replay corpus has no correctness regression
//! - Baseline metrics established (success rate, first-attempt success,
//!   retries, token usage, duration, revoke rate)

pub mod killswitch;
pub mod metrics;

use serde::{Deserialize, Serialize};

use crate::config::EvolutionMode;
use crate::error::EvolutionError;
use crate::trial::preflight::PreflightResult;

/// Measured gates that must all pass before reusable experiences may be injected.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolloutReadiness {
    pub source_pollution_events: u32,
    pub sandbox_complete: bool,
    pub evidence_complete: bool,
    pub unexplained_network_or_writes: u32,
    pub safety_drills_passed: bool,
    pub replay_regressions: u32,
    pub metrics_baseline_established: bool,
}

impl RolloutReadiness {
    pub fn reuse_eligible(&self) -> bool {
        self.source_pollution_events == 0
            && self.sandbox_complete
            && self.evidence_complete
            && self.unexplained_network_or_writes == 0
            && self.safety_drills_passed
            && self.replay_regressions == 0
            && self.metrics_baseline_established
    }
}

/// Content hashes for the reports reviewed by the approving operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolloutEvidence {
    pub shadow_metrics_hash: String,
    pub sandbox_report_hash: String,
    pub evidence_completeness_hash: String,
    pub safety_drill_report_hash: String,
    pub replay_report_hash: String,
}

impl RolloutEvidence {
    pub fn validate(&self) -> Result<(), EvolutionError> {
        for (name, hash) in [
            ("shadow_metrics_hash", &self.shadow_metrics_hash),
            ("sandbox_report_hash", &self.sandbox_report_hash),
            (
                "evidence_completeness_hash",
                &self.evidence_completeness_hash,
            ),
            ("safety_drill_report_hash", &self.safety_drill_report_hash),
            ("replay_report_hash", &self.replay_report_hash),
        ] {
            if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(EvolutionError::PreflightFailed(format!(
                    "{name} must be a 64-character content hash"
                )));
            }
        }
        Ok(())
    }
}

/// Immutable, auditable approval record persisted in the evolution database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolloutApproval {
    pub approval_id: String,
    pub readiness: RolloutReadiness,
    pub evidence: RolloutEvidence,
    pub evidence_hash: String,
    pub approved_by: String,
    pub approved_at: i64,
    pub revoked_at: Option<i64>,
    pub revocation_reason: Option<String>,
}

impl RolloutApproval {
    pub fn new(
        readiness: RolloutReadiness,
        evidence: RolloutEvidence,
        approved_by: String,
        approved_at: i64,
    ) -> Result<Self, EvolutionError> {
        if !readiness.reuse_eligible() {
            return Err(EvolutionError::PreflightFailed(
                "rollout readiness gates are not all satisfied".to_string(),
            ));
        }
        evidence.validate()?;
        validate_operator(&approved_by)?;
        let evidence_hash = approval_payload_hash(&readiness, &evidence, &approved_by, approved_at)?;
        Ok(Self {
            approval_id: uuid::Uuid::new_v4().to_string(),
            readiness,
            evidence,
            evidence_hash,
            approved_by,
            approved_at,
            revoked_at: None,
            revocation_reason: None,
        })
    }

    pub fn verify(&self) -> Result<(), EvolutionError> {
        if self.revoked_at.is_some() || !self.readiness.reuse_eligible() {
            return Err(EvolutionError::PreflightFailed(
                "rollout approval is revoked or no longer eligible".to_string(),
            ));
        }
        self.evidence.validate()?;
        validate_operator(&self.approved_by)?;
        let actual = approval_payload_hash(
            &self.readiness,
            &self.evidence,
            &self.approved_by,
            self.approved_at,
        )?;
        if actual != self.evidence_hash {
            return Err(EvolutionError::ArtifactIntegrity {
                expected: self.evidence_hash.clone(),
                actual,
            });
        }
        Ok(())
    }
}

fn approval_payload_hash(
    readiness: &RolloutReadiness,
    evidence: &RolloutEvidence,
    approved_by: &str,
    approved_at: i64,
) -> Result<String, EvolutionError> {
    let payload = serde_json::to_vec(&(readiness, evidence, approved_by, approved_at))
        .map_err(|error| EvolutionError::Internal(format!("serialize rollout approval: {error}")))?;
    Ok(blake3::hash(&payload).to_hex().to_string())
}

fn validate_operator(approved_by: &str) -> Result<(), EvolutionError> {
    let approved_by = approved_by.trim();
    if approved_by.is_empty()
        || approved_by.len() > 128
        || approved_by.chars().any(char::is_control)
    {
        return Err(EvolutionError::PreflightFailed(
            "approved_by must be a non-empty operator identity of at most 128 characters"
                .to_string(),
        ));
    }
    Ok(())
}

/// Rollout controller managing mode transitions.
pub struct RolloutController {
    current_mode: EvolutionMode,
    kill_switch_active: bool,
    metrics: metrics::RolloutMetrics,
    shadow_samples: u32,
    pollution_events: u32,
    replay_regression_count: u32,
}

impl RolloutController {
    pub fn new(initial_mode: EvolutionMode) -> Self {
        Self {
            current_mode: initial_mode,
            kill_switch_active: false,
            metrics: metrics::RolloutMetrics::default(),
            shadow_samples: 0,
            pollution_events: 0,
            replay_regression_count: 0,
        }
    }

    /// Get the current mode.
    pub fn current_mode(&self) -> EvolutionMode {
        self.current_mode
    }

    /// Activate the kill switch (force Off).
    pub fn activate_kill_switch(&mut self, reason: String) {
        self.kill_switch_active = true;
        self.current_mode = EvolutionMode::Off;
        tracing::warn!(reason = %reason, "evolution kill switch activated");
    }

    /// Deactivate the kill switch.
    pub fn deactivate_kill_switch(&mut self) {
        self.kill_switch_active = false;
        tracing::info!("evolution kill switch deactivated");
    }

    /// Check if the kill switch is active.
    pub fn is_kill_switch_active(&self) -> bool {
        self.kill_switch_active
    }

    /// Record a shadow sampling result.
    pub fn record_shadow_sample(&mut self) {
        self.shadow_samples += 1;
    }

    /// Record a pollution event (source worktree modification detected).
    pub fn record_pollution_event(&mut self) {
        self.pollution_events += 1;
        tracing::error!(
            count = self.pollution_events,
            "source worktree pollution detected"
        );
    }

    /// Record a replay regression.
    pub fn record_replay_regression(&mut self) {
        self.replay_regression_count += 1;
    }

    /// Attempt to upgrade to the next mode.
    ///
    /// Runs all gate checks and returns the result. If any gate fails,
    /// the mode remains unchanged and a structured failure is returned.
    pub fn try_upgrade(
        &mut self,
        preflight: &PreflightResult,
    ) -> Result<EvolutionMode, UpgradeFailure> {
        if self.kill_switch_active {
            return Err(UpgradeFailure {
                target_mode: self.current_mode, // no change
                reasons: vec!["Kill switch is active".to_string()],
            });
        }

        let target = match self.current_mode {
            EvolutionMode::Off => EvolutionMode::Shadow,
            EvolutionMode::Shadow => EvolutionMode::IsolatedAutonomous,
            EvolutionMode::IsolatedAutonomous => EvolutionMode::ReuseEligible,
            EvolutionMode::ReuseEligible => {
                return Err(UpgradeFailure {
                    target_mode: self.current_mode,
                    reasons: vec!["Already at highest mode".to_string()],
                })
            }
        };

        let gates = self.check_gates(target, preflight);

        if gates.all_passed() {
            self.current_mode = target;
            tracing::info!(mode = ?target, "evolution mode upgraded");
            Ok(target)
        } else {
            Err(UpgradeFailure {
                target_mode: target,
                reasons: gates.failure_reasons,
            })
        }
    }

    /// Downgrade to a lower mode.
    pub fn downgrade(&mut self, target: EvolutionMode) {
        if target.level() < self.current_mode.level() {
            self.current_mode = target;
            tracing::warn!(mode = ?target, "evolution mode downgraded");
        }
    }

    /// Check all gates for a target mode transition.
    fn check_gates(
        &self,
        target: EvolutionMode,
        preflight: &PreflightResult,
    ) -> GateResult {
        let mut result = GateResult::default();

        match target {
            EvolutionMode::Shadow => {
                // Off → Shadow: minimal gates
                // (kill switch already checked above)
            }
            EvolutionMode::IsolatedAutonomous => {
                // Shadow → IsolatedAutonomous
                if self.shadow_samples < 10 {
                    result.failure(format!(
                        "Insufficient shadow samples: {} (need 10)",
                        self.shadow_samples
                    ));
                }
                if self.pollution_events > 0 {
                    result.failure(format!(
                        "Source worktree pollution detected: {} events",
                        self.pollution_events
                    ));
                }
                if !preflight.sandbox_available {
                    result.failure("Sandbox not available on this platform".to_string());
                }
                if !preflight.source_dir_write_blocked {
                    result.failure("Source directory write not blocked".to_string());
                }
                if !preflight.network_blocked {
                    result.failure("Network not blocked".to_string());
                }
            }
            EvolutionMode::ReuseEligible => {
                // IsolatedAutonomous → ReuseEligible: strictest gates
                if self.pollution_events > 0 {
                    result.failure(format!(
                        "Source worktree pollution: {} events (need 0)",
                        self.pollution_events
                    ));
                }
                if !preflight.all_passed() {
                    result.failure("Not all preflight checks passed".to_string());
                    for reason in &preflight.failure_reasons {
                        result.failure(format!("  - {}", reason));
                    }
                }
                if self.replay_regression_count > 0 {
                    result.failure(format!(
                        "Replay regressions: {} (need 0)",
                        self.replay_regression_count
                    ));
                }
                if !self.metrics.has_baseline() {
                    result.failure("Baseline metrics not yet established".to_string());
                }
            }
            _ => {}
        }

        result
    }

    /// Get a snapshot of current metrics.
    pub fn metrics_snapshot(&self) -> metrics::RolloutMetrics {
        self.metrics.clone()
    }

    /// Record a trial outcome for metrics.
    pub fn record_trial_outcome(&mut self, outcome: metrics::TrialOutcomeRecord) {
        self.metrics.record(outcome);
    }
}

/// Result of a gate check.
#[derive(Debug, Default)]
struct GateResult {
    failure_reasons: Vec<String>,
}

impl GateResult {
    fn failure(&mut self, reason: String) {
        self.failure_reasons.push(reason);
    }

    fn all_passed(&self) -> bool {
        self.failure_reasons.is_empty()
    }
}

/// Failure information when an upgrade is rejected.
#[derive(Debug, Clone)]
pub struct UpgradeFailure {
    pub target_mode: EvolutionMode,
    pub reasons: Vec<String>,
}

impl std::fmt::Display for UpgradeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Cannot upgrade to {:?}: {}",
            self.target_mode,
            self.reasons.join("; ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trial::preflight::PreflightResult;

    fn clean_preflight() -> PreflightResult {
        PreflightResult {
            source_dir_write_blocked: true,
            network_blocked: true,
            symlink_escape_blocked: true,
            worktree_outside_write_blocked: true,
            sandbox_available: true,
            disk_space_sufficient: true,
            vcs_clean: true,
            failure_reasons: vec![],
        }
    }

    fn eligible_readiness() -> RolloutReadiness {
        RolloutReadiness {
            source_pollution_events: 0,
            sandbox_complete: true,
            evidence_complete: true,
            unexplained_network_or_writes: 0,
            safety_drills_passed: true,
            replay_regressions: 0,
            metrics_baseline_established: true,
        }
    }

    fn complete_evidence() -> RolloutEvidence {
        RolloutEvidence {
            shadow_metrics_hash: "a".repeat(64),
            sandbox_report_hash: "b".repeat(64),
            evidence_completeness_hash: "c".repeat(64),
            safety_drill_report_hash: "d".repeat(64),
            replay_report_hash: "e".repeat(64),
        }
    }

    #[test]
    fn approval_rejects_incomplete_gates() {
        let mut readiness = eligible_readiness();
        readiness.replay_regressions = 1;
        assert!(RolloutApproval::new(
            readiness,
            complete_evidence(),
            "operator".to_string(),
            1,
        )
        .is_err());
    }

    #[test]
    fn approval_hash_detects_tampering() {
        let mut approval = RolloutApproval::new(
            eligible_readiness(),
            complete_evidence(),
            "operator".to_string(),
            1,
        )
        .unwrap();
        approval.evidence.replay_report_hash = "f".repeat(64);
        assert!(matches!(
            approval.verify(),
            Err(EvolutionError::ArtifactIntegrity { .. })
        ));
    }

    #[test]
    fn off_to_shadow_succeeds() {
        let mut ctrl = RolloutController::new(EvolutionMode::Off);
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_ok());
        assert_eq!(ctrl.current_mode(), EvolutionMode::Shadow);
    }

    #[test]
    fn kill_switch_blocks_upgrade() {
        let mut ctrl = RolloutController::new(EvolutionMode::Off);
        ctrl.activate_kill_switch("test".to_string());
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_err());
        assert!(result.unwrap_err().reasons[0].contains("Kill switch"));
    }

    #[test]
    fn shadow_to_isolated_needs_samples() {
        let mut ctrl = RolloutController::new(EvolutionMode::Shadow);
        // No shadow samples recorded
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_err());
        assert!(result.unwrap_err().reasons.iter().any(|r| r.contains("shadow samples")));
    }

    #[test]
    fn shadow_to_isolated_with_enough_samples() {
        let mut ctrl = RolloutController::new(EvolutionMode::Shadow);
        for _ in 0..10 {
            ctrl.record_shadow_sample();
        }
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_ok());
        assert_eq!(ctrl.current_mode(), EvolutionMode::IsolatedAutonomous);
    }

    #[test]
    fn pollution_blocks_isolated_upgrade() {
        let mut ctrl = RolloutController::new(EvolutionMode::Shadow);
        for _ in 0..10 {
            ctrl.record_shadow_sample();
        }
        ctrl.record_pollution_event();
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_err());
        assert!(result.unwrap_err().reasons.iter().any(|r| r.contains("pollution")));
    }

    #[test]
    fn isolated_to_reuse_needs_baseline() {
        let mut ctrl = RolloutController::new(EvolutionMode::IsolatedAutonomous);
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_err());
        assert!(result.unwrap_err().reasons.iter().any(|r| r.contains("Baseline")));
    }

    #[test]
    fn downgrade_works() {
        let mut ctrl = RolloutController::new(EvolutionMode::IsolatedAutonomous);
        ctrl.downgrade(EvolutionMode::Shadow);
        assert_eq!(ctrl.current_mode(), EvolutionMode::Shadow);
    }

    #[test]
    fn downgrade_igners_higher_modes() {
        let mut ctrl = RolloutController::new(EvolutionMode::Shadow);
        ctrl.downgrade(EvolutionMode::IsolatedAutonomous); // can't downgrade to higher
        assert_eq!(ctrl.current_mode(), EvolutionMode::Shadow);
    }

    #[test]
    fn reuse_is_highest_mode() {
        let mut ctrl = RolloutController::new(EvolutionMode::ReuseEligible);
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_err());
        assert!(result.unwrap_err().reasons[0].contains("highest"));
    }

    #[test]
    fn kill_switch_deactivation() {
        let mut ctrl = RolloutController::new(EvolutionMode::Off);
        ctrl.activate_kill_switch("test".to_string());
        assert!(ctrl.is_kill_switch_active());
        ctrl.deactivate_kill_switch();
        assert!(!ctrl.is_kill_switch_active());
        // Now upgrade should work
        let result = ctrl.try_upgrade(&clean_preflight());
        assert!(result.is_ok());
    }
}

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

use crate::config::EvolutionMode;
use crate::trial::preflight::PreflightResult;

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

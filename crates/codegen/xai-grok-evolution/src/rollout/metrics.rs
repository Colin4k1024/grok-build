//! Rollout metrics: baseline establishment for ReuseEligible gate.
//!
//! Tracks per-trial outcomes to build a statistical baseline required
//! for entering ReuseEligible mode. Metrics include:
//! - Success rate
//! - First-attempt success rate
//! - Retry count distribution
//! - Token usage
//! - Duration
//! - Revoke rate (user-initiated quarantines)

use serde::{Deserialize, Serialize};

/// A single trial outcome record for metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialOutcomeRecord {
    pub run_id: String,
    pub success: bool,
    pub first_attempt: bool,
    pub retry_count: u32,
    pub token_usage: u64,
    pub duration_ms: u64,
    pub user_revoked: bool,
}

/// Aggregate rollout metrics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RolloutMetrics {
    pub total_trials: u64,
    pub successful_trials: u64,
    pub first_attempt_successes: u64,
    pub total_retries: u64,
    pub total_tokens: u64,
    pub total_duration_ms: u64,
    pub user_revocations: u64,
}

/// Minimum number of trials required to establish a baseline.
pub const MIN_TRIALS_FOR_BASELINE: u64 = 20;

impl RolloutMetrics {
    /// Record a trial outcome.
    pub fn record(&mut self, outcome: TrialOutcomeRecord) {
        self.total_trials += 1;
        if outcome.success {
            self.successful_trials += 1;
        }
        if outcome.first_attempt {
            self.first_attempt_successes += 1;
        }
        self.total_retries += outcome.retry_count as u64;
        self.total_tokens += outcome.token_usage;
        self.total_duration_ms += outcome.duration_ms;
        if outcome.user_revoked {
            self.user_revocations += 1;
        }
    }

    /// Check if sufficient data exists to establish a baseline.
    pub fn has_baseline(&self) -> bool {
        self.total_trials >= MIN_TRIALS_FOR_BASELINE
    }

    /// Success rate (0.0 - 1.0).
    pub fn success_rate(&self) -> f64 {
        if self.total_trials == 0 {
            return 0.0;
        }
        self.successful_trials as f64 / self.total_trials as f64
    }

    /// First-attempt success rate (0.0 - 1.0).
    pub fn first_attempt_rate(&self) -> f64 {
        if self.total_trials == 0 {
            return 0.0;
        }
        self.first_attempt_successes as f64 / self.total_trials as f64
    }

    /// Average retries per trial.
    pub fn avg_retries(&self) -> f64 {
        if self.total_trials == 0 {
            return 0.0;
        }
        self.total_retries as f64 / self.total_trials as f64
    }

    /// Average token usage per trial.
    pub fn avg_tokens(&self) -> f64 {
        if self.total_trials == 0 {
            return 0.0;
        }
        self.total_tokens as f64 / self.total_trials as f64
    }

    /// Average duration in seconds.
    pub fn avg_duration_secs(&self) -> f64 {
        if self.total_trials == 0 {
            return 0.0;
        }
        (self.total_duration_ms as f64 / self.total_trials as f64) / 1000.0
    }

    /// Revoke rate (0.0 - 1.0).
    pub fn revoke_rate(&self) -> f64 {
        if self.total_trials == 0 {
            return 0.0;
        }
        self.user_revocations as f64 / self.total_trials as f64
    }

    /// Summary string for display.
    pub fn summary(&self) -> String {
        format!(
            "trials={}, success={:.0}%, first_attempt={:.0}%, avg_retries={:.1}, avg_tokens={:.0}, avg_duration={:.1}s, revoke={:.0}%",
            self.total_trials,
            self.success_rate() * 100.0,
            self.first_attempt_rate() * 100.0,
            self.avg_retries(),
            self.avg_tokens(),
            self.avg_duration_secs(),
            self.revoke_rate() * 100.0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_outcome(success: bool, first: bool) -> TrialOutcomeRecord {
        TrialOutcomeRecord {
            run_id: "run-1".to_string(),
            success,
            first_attempt: first,
            retry_count: if first { 0 } else { 1 },
            token_usage: 1000,
            duration_ms: 5000,
            user_revoked: false,
        }
    }

    #[test]
    fn empty_metrics() {
        let m = RolloutMetrics::default();
        assert!(!m.has_baseline());
        assert_eq!(m.success_rate(), 0.0);
    }

    #[test]
    fn record_outcomes() {
        let mut m = RolloutMetrics::default();
        for _ in 0..15 {
            m.record(sample_outcome(true, true));
        }
        for _ in 0..5 {
            m.record(sample_outcome(false, false));
        }
        assert_eq!(m.total_trials, 20);
        assert!(m.has_baseline());
        assert_eq!(m.success_rate(), 0.75);
        assert_eq!(m.first_attempt_rate(), 0.75);
    }

    #[test]
    fn revoke_tracking() {
        let mut m = RolloutMetrics::default();
        let mut outcome = sample_outcome(true, true);
        outcome.user_revoked = true;
        m.record(outcome);
        assert_eq!(m.revoke_rate(), 1.0);
    }

    #[test]
    fn summary_format() {
        let mut m = RolloutMetrics::default();
        for _ in 0..20 {
            m.record(sample_outcome(true, true));
        }
        let s = m.summary();
        assert!(s.contains("trials=20"));
        assert!(s.contains("success=100%"));
    }

    #[test]
    fn baseline_threshold() {
        let mut m = RolloutMetrics::default();
        for i in 0..19 {
            m.record(sample_outcome(true, true));
            assert!(!m.has_baseline(), "should not have baseline at {}", i + 1);
        }
        m.record(sample_outcome(true, true));
        assert!(m.has_baseline());
    }
}

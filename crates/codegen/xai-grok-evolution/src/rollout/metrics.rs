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

use std::collections::VecDeque;

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

/// Sliding-window circuit breaker for evolution trial outcomes.
///
/// Monitors recent trial outcomes and triggers the kill switch when the
/// failure rate exceeds the configured threshold within the observation window.
pub struct CircuitBreaker {
    /// Recent outcomes: (timestamp_secs, was_success)
    window: VecDeque<(i64, bool)>,
    /// Maximum window size (number of observations to retain).
    window_size: usize,
    /// Failure rate threshold (0.0-1.0) that triggers the breaker.
    failure_threshold: f64,
}

impl CircuitBreaker {
    pub fn new(window_size: usize, failure_threshold: f64) -> Self {
        Self {
            window: VecDeque::with_capacity(window_size),
            window_size,
            failure_threshold,
        }
    }

    /// Record a trial outcome. Returns `true` if the breaker should trip.
    pub fn record(&mut self, success: bool) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.window.push_back((now, success));
        while self.window.len() > self.window_size {
            self.window.pop_front();
        }
        self.should_trip()
    }

    /// Check if the breaker should trip based on current window.
    pub fn should_trip(&self) -> bool {
        if self.window.len() < 3 {
            // Need at least 3 observations to make a decision
            return false;
        }
        let failures = self.window.iter().filter(|(_, success)| !success).count();
        let rate = failures as f64 / self.window.len() as f64;
        rate >= self.failure_threshold
    }

    /// Get the current failure rate.
    pub fn failure_rate(&self) -> f64 {
        if self.window.is_empty() {
            return 0.0;
        }
        let failures = self.window.iter().filter(|(_, success)| !success).count();
        failures as f64 / self.window.len() as f64
    }

    /// Reset the window (e.g., after kill switch deactivation).
    pub fn reset(&mut self) {
        self.window.clear();
    }
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(10, 0.5)
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

    #[test]
    fn breaker_does_not_trip_with_all_success() {
        let mut cb = CircuitBreaker::new(10, 0.5);
        for _ in 0..5 {
            assert!(!cb.record(true));
        }
    }

    #[test]
    fn breaker_trips_at_threshold() {
        let mut cb = CircuitBreaker::new(10, 0.5);
        // 3 successes, then 3 failures = 50% failure rate
        cb.record(true);
        cb.record(true);
        cb.record(true);
        assert!(!cb.record(false));
        assert!(!cb.record(false));
        // Now at 3 success, 2 failure = 40%, not yet
        // Add one more failure: 3 success, 3 failure = 50%
        assert!(cb.record(false));
    }

    #[test]
    fn breaker_needs_minimum_observations() {
        let mut cb = CircuitBreaker::new(10, 0.5);
        // Even all failures shouldn't trip with < 3 observations
        assert!(!cb.record(false));
        assert!(!cb.record(false));
        // Third observation should now evaluate
        assert!(cb.record(false));
    }

    #[test]
    fn breaker_window_evicts_old() {
        let mut cb = CircuitBreaker::new(5, 0.5);
        // Fill window with failures
        for _ in 0..5 {
            cb.record(false);
        }
        assert!(cb.should_trip());
        // Now push successes — old failures should get evicted
        for _ in 0..5 {
            cb.record(true);
        }
        assert!(!cb.should_trip());
    }

    #[test]
    fn breaker_reset_clears_window() {
        let mut cb = CircuitBreaker::new(10, 0.5);
        for _ in 0..5 {
            cb.record(false);
        }
        assert!(cb.should_trip());
        cb.reset();
        assert!(!cb.should_trip());
        assert_eq!(cb.failure_rate(), 0.0);
    }
}

//! Telemetry: tracing targets, spans, and metrics for the evolution system.
//!
//! Follows the existing `xai_grok_telemetry` pattern: defines a
//! `TARGET` constant and structured span/event macros.
//!
//! ## Instrumented Operations
//!
//! - `evolution::pipeline` — full pipeline execution
//! - `evolution::trial` — individual trial lifecycle
//! - `evolution::signal` — signal collection and queueing
//! - `evolution::quarantine` — quarantine events
//! - `evolution::mode_transition` — mode changes
//! - `evolution::kill_switch` — kill switch activation

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Tracing target for evolution log messages.
pub const TARGET: &str = "grok_evolution";

/// Metrics counters for the evolution system.
///
/// Uses atomic operations for lock-free concurrent access.
/// Counters are process-scoped and reset on restart.
#[derive(Debug, Clone)]
pub struct EvolutionMetrics {
    inner: Arc<MetricsInner>,
}

#[derive(Debug)]
struct MetricsInner {
    /// Total pipeline executions started.
    pipeline_started: AtomicU64,
    /// Pipeline executions completed successfully.
    pipeline_completed: AtomicU64,
    /// Pipeline executions failed.
    pipeline_failed: AtomicU64,
    /// Trials started.
    trials_started: AtomicU64,
    /// Trials completed successfully.
    trials_completed: AtomicU64,
    /// Trials failed.
    trials_failed: AtomicU64,
    /// Signals collected.
    signals_collected: AtomicU64,
    /// Signals dropped (backpressure).
    signals_dropped: AtomicU64,
    /// Quarantine events.
    quarantine_events: AtomicU64,
    /// Mode transitions.
    mode_transitions: AtomicU64,
    /// Kill switch activations.
    kill_switch_activations: AtomicU64,
    /// Experience promotions (Candidate → Active).
    promotions: AtomicU64,
    /// Reuse injections.
    reuse_injections: AtomicU64,
    /// Reuse observations recorded.
    reuse_observations: AtomicU64,
}

impl Default for EvolutionMetrics {
    fn default() -> Self {
        Self {
            inner: Arc::new(MetricsInner {
                pipeline_started: AtomicU64::new(0),
                pipeline_completed: AtomicU64::new(0),
                pipeline_failed: AtomicU64::new(0),
                trials_started: AtomicU64::new(0),
                trials_completed: AtomicU64::new(0),
                trials_failed: AtomicU64::new(0),
                signals_collected: AtomicU64::new(0),
                signals_dropped: AtomicU64::new(0),
                quarantine_events: AtomicU64::new(0),
                mode_transitions: AtomicU64::new(0),
                kill_switch_activations: AtomicU64::new(0),
                promotions: AtomicU64::new(0),
                reuse_injections: AtomicU64::new(0),
                reuse_observations: AtomicU64::new(0),
            }),
        }
    }
}

impl EvolutionMetrics {
    // -- Pipeline --
    pub fn pipeline_started(&self) {
        self.inner.pipeline_started.fetch_add(1, Ordering::Relaxed);
        tracing::info!(target: TARGET, "evolution pipeline started");
    }
    pub fn pipeline_completed(&self) {
        self.inner.pipeline_completed.fetch_add(1, Ordering::Relaxed);
    }
    pub fn pipeline_failed(&self) {
        self.inner.pipeline_failed.fetch_add(1, Ordering::Relaxed);
        tracing::warn!(target: TARGET, "evolution pipeline failed");
    }

    // -- Trials --
    pub fn trial_started(&self) {
        self.inner.trials_started.fetch_add(1, Ordering::Relaxed);
    }
    pub fn trial_completed(&self, duration_ms: u64) {
        self.inner.trials_completed.fetch_add(1, Ordering::Relaxed);
        tracing::info!(target: TARGET, duration_ms, "trial completed");
    }
    pub fn trial_failed(&self, reason: &str) {
        self.inner.trials_failed.fetch_add(1, Ordering::Relaxed);
        tracing::warn!(target: TARGET, reason, "trial failed");
    }

    // -- Signals --
    pub fn signals_collected(&self, count: u64) {
        self.inner.signals_collected.fetch_add(count, Ordering::Relaxed);
    }
    pub fn signal_dropped(&self) {
        self.inner.signals_dropped.fetch_add(1, Ordering::Relaxed);
    }

    // -- Quarantine --
    pub fn quarantine_event(&self, experience_id: &str, reason: &str) {
        self.inner.quarantine_events.fetch_add(1, Ordering::Relaxed);
        tracing::warn!(
            target: TARGET,
            experience_id,
            reason,
            "experience quarantined"
        );
    }

    // -- Mode transitions --
    pub fn mode_transition(&self, from: &str, to: &str) {
        self.inner.mode_transitions.fetch_add(1, Ordering::Relaxed);
        tracing::info!(target: TARGET, from, to, "evolution mode transition");
    }

    // -- Kill switch --
    pub fn kill_switch_activated(&self, reason: &str) {
        self.inner.kill_switch_activations.fetch_add(1, Ordering::Relaxed);
        tracing::error!(target: TARGET, reason, "kill switch activated");
    }

    // -- Promotions --
    pub fn promotion(&self, experience_id: &str) {
        self.inner.promotions.fetch_add(1, Ordering::Relaxed);
        tracing::info!(target: TARGET, experience_id, "experience promoted to Active");
    }

    // -- Reuse --
    pub fn reuse_injection(&self, experience_id: &str, tokens: usize) {
        self.inner.reuse_injections.fetch_add(1, Ordering::Relaxed);
        tracing::debug!(target: TARGET, experience_id, tokens, "experience injected");
    }
    pub fn reuse_observation(&self, experience_id: &str, outcome: &str) {
        self.inner.reuse_observations.fetch_add(1, Ordering::Relaxed);
        tracing::debug!(target: TARGET, experience_id, outcome, "reuse observation recorded");
    }

    // -- Snapshot --
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            pipeline_started: self.inner.pipeline_started.load(Ordering::Relaxed),
            pipeline_completed: self.inner.pipeline_completed.load(Ordering::Relaxed),
            pipeline_failed: self.inner.pipeline_failed.load(Ordering::Relaxed),
            trials_started: self.inner.trials_started.load(Ordering::Relaxed),
            trials_completed: self.inner.trials_completed.load(Ordering::Relaxed),
            trials_failed: self.inner.trials_failed.load(Ordering::Relaxed),
            signals_collected: self.inner.signals_collected.load(Ordering::Relaxed),
            signals_dropped: self.inner.signals_dropped.load(Ordering::Relaxed),
            quarantine_events: self.inner.quarantine_events.load(Ordering::Relaxed),
            mode_transitions: self.inner.mode_transitions.load(Ordering::Relaxed),
            kill_switch_activations: self.inner.kill_switch_activations.load(Ordering::Relaxed),
            promotions: self.inner.promotions.load(Ordering::Relaxed),
            reuse_injections: self.inner.reuse_injections.load(Ordering::Relaxed),
            reuse_observations: self.inner.reuse_observations.load(Ordering::Relaxed),
        }
    }
}

/// Point-in-time snapshot of all metrics.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MetricsSnapshot {
    pub pipeline_started: u64,
    pub pipeline_completed: u64,
    pub pipeline_failed: u64,
    pub trials_started: u64,
    pub trials_completed: u64,
    pub trials_failed: u64,
    pub signals_collected: u64,
    pub signals_dropped: u64,
    pub quarantine_events: u64,
    pub mode_transitions: u64,
    pub kill_switch_activations: u64,
    pub promotions: u64,
    pub reuse_injections: u64,
    pub reuse_observations: u64,
}

impl MetricsSnapshot {
    /// Trial success rate.
    pub fn trial_success_rate(&self) -> f64 {
        if self.trials_started == 0 {
            return 0.0;
        }
        self.trials_completed as f64 / self.trials_started as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_increment() {
        let m = EvolutionMetrics::default();
        m.pipeline_started();
        m.pipeline_completed();
        m.trial_started();
        m.trial_completed(5000);
        m.signals_collected(3);

        let snap = m.snapshot();
        assert_eq!(snap.pipeline_started, 1);
        assert_eq!(snap.pipeline_completed, 1);
        assert_eq!(snap.trials_started, 1);
        assert_eq!(snap.trials_completed, 1);
        assert_eq!(snap.signals_collected, 3);
    }

    #[test]
    fn snapshot_success_rate() {
        let m = EvolutionMetrics::default();
        m.trial_started();
        m.trial_completed(100);
        m.trial_started();
        m.trial_failed("timeout");

        let snap = m.snapshot();
        assert!((snap.trial_success_rate() - 0.5).abs() < 0.01);
    }

    #[test]
    fn clone_shares_state() {
        let m1 = EvolutionMetrics::default();
        let m2 = m1.clone();
        m1.pipeline_started();
        assert_eq!(m2.snapshot().pipeline_started, 1);
    }

    #[test]
    fn default_snapshot_is_zero() {
        let snap = MetricsSnapshot::default();
        assert_eq!(snap.pipeline_started, 0);
        assert_eq!(snap.trial_success_rate(), 0.0);
    }
}

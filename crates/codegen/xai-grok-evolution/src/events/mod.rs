//! Evolution event definitions.
//!
//! Events are the immutable facts of the evolution system. All state
//! transitions are represented as append-only events in `evolution.sqlite`.

pub mod schema;
pub mod store;

use crate::types::*;
use serde::{Deserialize, Serialize};

/// A single evolution event, tagged by type with embedded data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum EvolutionEvent {
    RunStarted {
        run_id: RunId,
        trigger: TriggerInfo,
        config_snapshot: ConfigSnapshot,
    },
    SignalsDetected {
        run_id: RunId,
        signals: Vec<EvolutionSignal>,
    },
    CandidatesRanked {
        run_id: RunId,
        candidates: Vec<CandidateRank>,
    },
    VariantProposed {
        run_id: RunId,
        candidate: ExperienceCandidate,
    },
    TrialStarted {
        run_id: RunId,
        spec: TrialSpec,
    },
    TrialCompleted {
        run_id: RunId,
        outcome: TrialOutcome,
    },
    ValidationCompleted {
        run_id: RunId,
        baseline: Vec<ValidationResult>,
        candidate: Vec<ValidationResult>,
    },
    EvaluationCompleted {
        run_id: RunId,
        evaluation: EvaluationResult,
    },
    AdoptionDecided {
        run_id: RunId,
        decision: AdoptionDecision,
    },
    RevisionPublished {
        run_id: RunId,
        revision: ExperienceRevision,
    },
    Quarantined {
        run_id: RunId,
        experience_id: ExperienceId,
        reason: QuarantineReason,
    },
    ReuseObserved {
        run_id: RunId,
        observation: ReuseObservation,
    },
    ConfidenceTransitioned {
        run_id: RunId,
        experience_id: ExperienceId,
        from: ConfidenceState,
        to: ConfidenceState,
    },
    /// A pipeline stage started. Stage names are stable lowercase identifiers.
    StageStarted {
        run_id: RunId,
        stage: String,
    },
    /// A pipeline stage completed successfully.
    StageCompleted {
        run_id: RunId,
        stage: String,
    },
    /// A pipeline stage failed. A failed stage is terminal for the run.
    StageFailed {
        run_id: RunId,
        stage: String,
        error: String,
    },
    /// Terminal fact for an evolution run.
    RunFinished {
        run_id: RunId,
        state: RunState,
        error: Option<String>,
    },
}

/// Ranking of a candidate in the selection phase.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateRank {
    pub candidate_id: String,
    pub score: f64,
    pub rank: u32,
    pub is_main: bool,
}

/// Result from the Evaluate phase (safety gate + critic).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationResult {
    /// Did the candidate resolve the triggering signals?
    pub signals_resolved: bool,
    /// Semantic correctness score (0.0 - 1.0).
    pub correctness_score: f64,
    /// Generalization capability score (0.0 - 1.0).
    pub generalization_score: f64,
    /// Test coverage delta (new tests minus removed tests).
    pub test_coverage_delta: i32,
    /// Complexity change assessment.
    pub complexity_assessment: String,
    /// Token cost of the trial.
    pub token_cost: u64,
    /// Time cost in milliseconds.
    pub time_cost_ms: u64,
    /// Evaluator recommendation (can be overridden by safety gate).
    pub recommendation: AdoptionDecision,
    /// Whether the safety gate blocked this evaluation.
    pub safety_gate_passed: bool,
}

/// Reason for quarantining an experience.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuarantineReason {
    pub reason_type: QuarantineReasonType,
    pub description: String,
    pub triggering_run_id: Option<RunId>,
    pub quarantined_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineReasonType {
    /// Consecutive failures exceeded threshold.
    ConsecutiveFailures,
    /// User explicitly revoked.
    UserRevoke,
    /// Quality regression detected.
    QualityRegression,
    /// Environment drift detected.
    EnvironmentDrift,
    /// Manual quarantine via TUI/CLI.
    Manual,
}

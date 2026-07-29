//! Core domain types for the evolution system.
//!
//! All public types carry a `schema_version` field for forward/backward compatibility.
//! Types are designed to be immutable once created — mutations produce new instances.

use serde::{Deserialize, Serialize};

/// Current schema version for new types.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/// Unique identifier for an evolution run.
pub type RunId = String;

/// Unique identifier for an experience revision.
pub type ExperienceId = String;

/// Unique identifier for an event.
pub type EventId = String;

/// blake3 content hash (64-char hex).
pub type ContentHash = String;

/// Idempotency key for event deduplication.
pub type IdempotencyKey = String;

// ---------------------------------------------------------------------------
// Evolution Run
// ---------------------------------------------------------------------------

/// One complete evolution run (eight-stage pipeline execution).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionRun {
    pub run_id: RunId,
    pub schema_version: u32,
    pub state: RunState,
    pub trigger: TriggerInfo,
    pub config_snapshot: ConfigSnapshot,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
}

/// Run lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Running,
    Completed,
    Failed,
    Abandoned,
}

/// What triggered this evolution run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub trigger_type: TriggerType,
    pub source_event_id: Option<EventId>,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    /// Tool failure detected.
    ToolFailure,
    /// Test failure detected.
    TestFailure,
    /// User feedback (negative).
    UserFeedback,
    /// Performance regression.
    PerformanceRegression,
    /// Manual trigger via CLI/TUI.
    Manual,
}

/// Snapshot of the evolution config at run start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub mode: String,
    pub budget_max_duration_secs: u64,
    pub budget_max_variant_rounds: u32,
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

/// A normalized problem, success, or feedback signal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionSignal {
    pub signal_id: String,
    pub schema_version: u32,
    pub signal_type: SignalType,
    pub severity: SignalSeverity,
    pub source: SignalSource,
    /// Sanitized description (no secrets).
    pub description: String,
    pub context_hash: ContentHash,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalType {
    ToolFailure,
    TestFailure,
    Timeout,
    Panic,
    UserCorrection,
    NegativeFeedback,
    PerformanceRegression,
    RetryExhausted,
    CompilationError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalSeverity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalSource {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub tool_name: Option<String>,
    pub file_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Experience Candidate & Revision
// ---------------------------------------------------------------------------

/// A candidate experience that has not yet been validated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceCandidate {
    pub candidate_id: String,
    pub schema_version: u32,
    pub trigger_signals: Vec<String>,
    pub proposal: VariantProposal,
    pub parent_revision_id: Option<ExperienceId>,
    pub created_at: i64,
}

/// The structured mutation proposal from the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantProposal {
    /// What the mutation targets.
    pub target: String,
    /// Prerequisites for this experience to apply.
    pub preconditions: Vec<String>,
    /// Files or directories this mutation may modify.
    pub allowed_paths: Vec<String>,
    /// Actions that are forbidden.
    pub forbidden_actions: Vec<String>,
    /// Expected benefit.
    pub expected_benefit: String,
    /// Validation command (argv array, no shell).
    pub validation_command: Vec<String>,
    /// Success predicate description.
    pub success_predicate: String,
    /// Unified diff generated by the parent process. Historical patches are
    /// evidence only and must never be placed here automatically.
    #[serde(default)]
    pub patch: Option<String>,
}

/// An immutable, versioned experience revision with parent lineage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceRevision {
    pub experience_id: ExperienceId,
    pub revision: u32,
    pub schema_version: u32,
    pub parent_id: Option<ExperienceId>,
    pub state: ExperienceState,
    pub confidence: f64,
    pub success_count: u32,
    pub failure_count: u32,
    pub scope: ScopeFingerprint,
    pub content_hash: ContentHash,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Experience lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExperienceState {
    /// Newly created, awaiting enough observations.
    Candidate,
    /// Sufficient successful observations, available for reuse.
    Active,
    /// Confidence decaying over time.
    Decaying,
    /// Being revalidated after environment drift.
    Revalidating,
    /// Temporarily disabled due to failures or user revoke.
    Quarantined,
    /// Permanently disabled.
    Revoked,
}

/// Fingerprint for the applicable scope of an experience.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeFingerprint {
    /// Repository identifier (e.g., org/repo).
    pub repo: Option<String>,
    /// Task type this experience applies to.
    pub task_type: Option<String>,
    /// Signal types that triggered this experience.
    pub signal_types: Vec<SignalType>,
    /// Environment fingerprint (toolchain version, lockfile hash, etc.).
    pub env_fingerprint: Option<String>,
}

// ---------------------------------------------------------------------------
// Contraindication
// ---------------------------------------------------------------------------

/// A negative experience: "this approach does not work in this context."
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contraindication {
    pub contraindication_id: String,
    pub schema_version: u32,
    pub experience_id: Option<ExperienceId>,
    pub scope: ScopeFingerprint,
    pub reason: String,
    pub evidence_ref: EvidenceRef,
    pub ttl_secs: u64,
    pub refute_conditions: Vec<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

// ---------------------------------------------------------------------------
// Trial
// ---------------------------------------------------------------------------

/// Specification for an allowed trial execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialSpec {
    pub spec_id: String,
    pub schema_version: u32,
    pub candidate_id: String,
    pub allowed_paths: Vec<String>,
    pub forbidden_actions: Vec<String>,
    pub budget: TrialBudget,
    pub validation_recipe: Vec<String>,
    pub max_variant_rounds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialBudget {
    pub max_duration_secs: u64,
    pub max_artifact_bytes: u64,
    pub max_files_changed: u32,
    pub max_lines_changed: u32,
}

/// Execution outcome of a trial (factual, no model opinion).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialOutcome {
    pub outcome_id: String,
    pub schema_version: u32,
    pub spec_id: String,
    pub result: TrialResult,
    pub duration_ms: u64,
    pub files_changed: Vec<String>,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub validation_results: Vec<ValidationResult>,
    pub artifact_hash: Option<ContentHash>,
    pub completed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrialResult {
    Success,
    Failed,
    Timeout,
    Cancelled,
    BudgetExceeded,
    SandboxUnavailable,
}

/// Result of running a single validation command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub command: Vec<String>,
    pub exit_code: i32,
    pub stdout_hash: ContentHash,
    pub stderr_hash: ContentHash,
    pub passed: bool,
    pub duration_ms: u64,
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/// A verifiable evidence bundle attached to a trial outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceBundle {
    pub bundle_id: String,
    pub schema_version: u32,
    pub run_id: RunId,
    pub refs: Vec<EvidenceRef>,
    pub content_hash: ContentHash,
    pub total_bytes: u64,
    pub scrubbed: bool,
    pub created_at: i64,
}

/// Reference to a single piece of evidence (sanitized pointer).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub ref_type: EvidenceRefType,
    /// Relative path within the artifacts directory.
    pub path: String,
    pub content_hash: ContentHash,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRefType {
    Diff,
    TestOutput,
    ValidationLog,
    Environment,
    Patch,
    ErrorLog,
}

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

/// Decision on what to do with a trial evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdoptionDecision {
    /// The candidate did not meet quality bar.
    Reject,
    /// Insufficient evidence; hold for more observations.
    Quarantine,
    /// Ready for publishing as a candidate revision.
    PublishCandidate,
    /// Eligible for reuse in future tasks.
    EligibleForReuse,
}

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

/// Observation of how a reused experience performed in a real task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReuseObservation {
    pub observation_id: String,
    pub schema_version: u32,
    pub experience_id: ExperienceId,
    pub run_id: RunId,
    pub outcome: ReuseOutcome,
    pub context_hash: ContentHash,
    pub observed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReuseOutcome {
    Helped,
    Neutral,
    Hindered,
    Unknown,
}

// ---------------------------------------------------------------------------
// Confidence & Lineage
// ---------------------------------------------------------------------------

/// Confidence state for an experience revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConfidenceState {
    /// Awaiting enough observations.
    Candidate { successes: u32, failures: u32 },
    /// Active with a numeric confidence score.
    Active { confidence: f64 },
    /// Confidence decaying over time.
    Decaying { confidence: f64, decay_rate: f64 },
    /// Being revalidated after environment drift.
    Revalidating { triggered_by: String },
    /// Temporarily disabled.
    Quarantined { reason: String, quarantined_at: i64 },
    /// Permanently disabled.
    Revoked { reason: String, revoked_at: i64 },
}

/// Edge type in the experience lineage graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineageEdgeType {
    /// Child was derived from parent.
    DerivesFrom,
    /// Child supersedes parent.
    Supersedes,
    /// Child contradicts parent.
    Contradicts,
}

// ---------------------------------------------------------------------------
// Worktree types (trait boundaries)
// ---------------------------------------------------------------------------

/// Reference to a source snapshot for worktree creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    /// Commit SHA to base the worktree on.
    pub commit_sha: String,
    /// Whether there are uncommitted changes.
    pub is_dirty: bool,
    /// Source repository path.
    pub repo_path: String,
}

/// Handle to a trial worktree (opaque to the evolution crate).
#[derive(Debug, Clone)]
pub struct TrialWorktree {
    pub worktree_id: String,
    pub path: String,
}

/// Handle to a baseline worktree (read-only).
#[derive(Debug, Clone)]
pub struct BaselineWorktree {
    pub worktree_id: String,
    pub path: String,
}

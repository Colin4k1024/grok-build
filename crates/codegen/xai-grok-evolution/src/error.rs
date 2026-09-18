use thiserror::Error;

/// Typed errors for the evolution system's public API.
///
/// Callers can match on specific variants for programmatic decision-making.
/// Internal orchestration may use `anyhow` for composition, but all public
/// trait methods return `EvolutionError`.
#[derive(Debug, Error)]
pub enum EvolutionError {
    /// SQLite storage error.
    #[error("storage error: {0}")]
    Storage(#[from] rusqlite::Error),

    /// Budget (time, rounds, artifact size, file/line count) exceeded.
    #[error("budget exceeded: {0}")]
    BudgetExceeded(String),

    /// Invalid state machine transition.
    #[error("invalid state transition from {from} to {to}")]
    InvalidTransition { from: String, to: String },

    /// Sandbox mechanism unavailable on this platform.
    #[error("sandbox unavailable: {0}")]
    SandboxUnavailable(String),

    /// Worker protocol error (malformed message, unexpected EOF, etc.).
    #[error("worker protocol error: {0}")]
    WorkerProtocol(String),

    /// Trial execution timed out.
    #[error("trial timeout after {0}s")]
    Timeout(u64),

    /// Quarantine SLA violation (failed to quarantine within deadline).
    #[error("quarantine SLA violation: {0}")]
    QuarantineSlaViolation(String),

    /// Operation was cancelled (user request or shutdown).
    #[error("cancelled: {0}")]
    Cancelled(String),

    /// Event payload schema version is from the future; can only read.
    #[error("future schema version {got}, current is {current}; read-only mode")]
    FutureSchemaVersion { got: u32, current: u32 },

    /// Artifact integrity check failed (hash mismatch).
    #[error("artifact integrity violation: expected {expected}, got {actual}")]
    ArtifactIntegrity { expected: String, actual: String },

    /// Idempotency key already seen; event was deduplicated.
    #[error("duplicate event for idempotency key {0}")]
    DuplicateEvent(String),

    /// Preflight check failed.
    #[error("preflight failed: {0}")]
    PreflightFailed(String),

    /// Generic internal error (for cases that don't fit above).
    #[error("{0}")]
    Internal(String),
}

impl EvolutionError {
    /// Returns `true` if this error indicates a budget violation.
    pub fn is_budget_exceeded(&self) -> bool {
        matches!(self, Self::BudgetExceeded(_))
    }

    /// Returns `true` if this error is transient and the operation can be retried.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Timeout(_) | Self::Cancelled(_))
    }
}

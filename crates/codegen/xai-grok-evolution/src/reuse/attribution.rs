//! Attribution state machine for experience reuse observations.
//!
//! Tracks the lifecycle of an injected experience from injection through
//! to final outcome determination. Prevents leaked attributions on cancel/panic.

use crate::types::ReuseOutcome;

/// Unique key for an attribution record.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AttributionKey {
    pub injection_id: String,
    pub turn_id: String,
}

/// Terminal states for attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttributionOutcome {
    /// Turn completed normally; outcome determined by signal analysis.
    Completed { outcome: ReuseOutcome },
    /// Turn was cancelled by user or system before completion.
    Cancelled,
    /// Attribution expired (stale pending from prior turn).
    Expired,
}

/// State machine for a single injection's attribution lifecycle.
#[derive(Debug, Clone)]
pub enum AttributionState {
    /// Experience was injected, awaiting turn completion.
    Pending {
        key: AttributionKey,
        experience_id: String,
        context_hash: String,
        injected_at: i64,
    },
    /// Attribution has reached a terminal state.
    Resolved {
        key: AttributionKey,
        experience_id: String,
        context_hash: String,
        outcome: AttributionOutcome,
    },
}

impl AttributionState {
    /// Create a new Pending attribution.
    pub fn new_pending(
        injection_id: String,
        turn_id: String,
        experience_id: String,
        context_hash: String,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        Self::Pending {
            key: AttributionKey { injection_id, turn_id },
            experience_id,
            context_hash,
            injected_at: now,
        }
    }

    /// Resolve the attribution with a determined outcome.
    pub fn resolve(self, outcome: AttributionOutcome) -> Self {
        match self {
            Self::Pending { key, experience_id, context_hash, .. } => Self::Resolved {
                key,
                experience_id,
                context_hash,
                outcome,
            },
            already_resolved => already_resolved,
        }
    }

    /// Check if this attribution is stale (pending for too long).
    /// TTL is 5 minutes — any turn that hasn't completed in 5 min is abandoned.
    pub fn is_expired(&self) -> bool {
        const ATTRIBUTION_TTL_SECS: i64 = 300;
        match self {
            Self::Pending { injected_at, .. } => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                now - injected_at > ATTRIBUTION_TTL_SECS
            }
            Self::Resolved { .. } => false,
        }
    }

    /// Get the experience_id regardless of state.
    pub fn experience_id(&self) -> &str {
        match self {
            Self::Pending { experience_id, .. } | Self::Resolved { experience_id, .. } => {
                experience_id
            }
        }
    }

    /// Get the context_hash regardless of state.
    pub fn context_hash(&self) -> &str {
        match self {
            Self::Pending { context_hash, .. } | Self::Resolved { context_hash, .. } => {
                context_hash
            }
        }
    }

    /// Returns true if still pending.
    pub fn is_pending(&self) -> bool {
        matches!(self, Self::Pending { .. })
    }
}

/// Determine the reuse outcome from turn signals.
///
/// Improved logic over the original:
/// - Requires at least one successful tool call OR non-empty assistant response for Helped
/// - No-op turns (zero tool calls, no response) are Neutral, not Helped
pub fn determine_outcome(
    has_user_corrections: bool,
    has_negative_feedback: bool,
    has_any_failure: bool,
    has_substantive_completion: bool,
) -> ReuseOutcome {
    if has_user_corrections || has_negative_feedback {
        ReuseOutcome::Hindered
    } else if has_any_failure {
        ReuseOutcome::Neutral
    } else if has_substantive_completion {
        ReuseOutcome::Helped
    } else {
        // No failures but also no substantive work — can't attribute to experience
        ReuseOutcome::Neutral
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_resolves_to_completed() {
        let state = AttributionState::new_pending(
            "inj-1".to_string(),
            "turn-1".to_string(),
            "exp-1".to_string(),
            "hash-1".to_string(),
        );
        assert!(state.is_pending());

        let resolved = state.resolve(AttributionOutcome::Completed {
            outcome: ReuseOutcome::Helped,
        });
        assert!(!resolved.is_pending());
        match resolved {
            AttributionState::Resolved { outcome, .. } => {
                assert_eq!(
                    outcome,
                    AttributionOutcome::Completed {
                        outcome: ReuseOutcome::Helped
                    }
                );
            }
            _ => panic!("expected Resolved"),
        }
    }

    #[test]
    fn pending_resolves_to_cancelled() {
        let state = AttributionState::new_pending(
            "inj-1".to_string(),
            "turn-1".to_string(),
            "exp-1".to_string(),
            "hash-1".to_string(),
        );
        let resolved = state.resolve(AttributionOutcome::Cancelled);
        match resolved {
            AttributionState::Resolved { outcome, .. } => {
                assert_eq!(outcome, AttributionOutcome::Cancelled);
            }
            _ => panic!("expected Resolved"),
        }
    }

    #[test]
    fn already_resolved_stays_resolved() {
        let state = AttributionState::new_pending(
            "inj-1".to_string(),
            "turn-1".to_string(),
            "exp-1".to_string(),
            "hash-1".to_string(),
        );
        let resolved = state.resolve(AttributionOutcome::Cancelled);
        // Trying to resolve again should be a no-op
        let again = resolved.resolve(AttributionOutcome::Completed {
            outcome: ReuseOutcome::Helped,
        });
        match again {
            AttributionState::Resolved { outcome, .. } => {
                assert_eq!(outcome, AttributionOutcome::Cancelled); // stays as first resolution
            }
            _ => panic!("expected Resolved"),
        }
    }

    #[test]
    fn determine_outcome_with_corrections_is_hindered() {
        assert_eq!(
            determine_outcome(true, false, false, true),
            ReuseOutcome::Hindered,
        );
    }

    #[test]
    fn determine_outcome_with_negative_feedback_is_hindered() {
        assert_eq!(
            determine_outcome(false, true, false, true),
            ReuseOutcome::Hindered,
        );
    }

    #[test]
    fn determine_outcome_with_failures_is_neutral() {
        assert_eq!(
            determine_outcome(false, false, true, true),
            ReuseOutcome::Neutral,
        );
    }

    #[test]
    fn determine_outcome_with_substantive_completion_is_helped() {
        assert_eq!(
            determine_outcome(false, false, false, true),
            ReuseOutcome::Helped,
        );
    }

    #[test]
    fn determine_outcome_without_substantive_completion_is_neutral() {
        // No failures but also no real work done — can't credit the experience
        assert_eq!(
            determine_outcome(false, false, false, false),
            ReuseOutcome::Neutral,
        );
    }
}

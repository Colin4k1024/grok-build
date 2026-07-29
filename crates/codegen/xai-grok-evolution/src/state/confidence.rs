//! Confidence state management with temporal decay.
//!
//! Tracks the lifecycle confidence of an experience revision, supporting
//! promotion, decay, revalidation, quarantine, and revocation transitions.

use crate::types::ConfidenceState;

/// Compute a new confidence value after applying exponential decay.
///
/// Uses the formula: `new_confidence = confidence * 2^(-elapsed_days / half_life_days)`.
pub fn apply_decay(confidence: f64, elapsed_days: f64, half_life_days: f64) -> f64 {
    if half_life_days <= 0.0 || elapsed_days <= 0.0 {
        return confidence;
    }
    let decay_factor = 2.0_f64.powf(-elapsed_days / half_life_days);
    (confidence * decay_factor).clamp(0.0, 1.0)
}

/// Determine if a decaying experience should be revoked (confidence below threshold).
pub fn should_revoke(confidence: f64, threshold: f64) -> bool {
    confidence < threshold
}

/// Default revocation threshold.
pub const REVOCATION_THRESHOLD: f64 = 0.05;

/// Build a confidence transition event data for a given state change.
pub fn transition_to(
    state: &ConfidenceState,
    successes: u32,
    failures: u32,
    promote_after: u32,
) -> Option<ConfidenceState> {
    match state {
        ConfidenceState::Candidate { .. } => {
            if successes >= promote_after && failures == 0 {
                Some(ConfidenceState::Active {
                    confidence: initial_confidence(successes),
                })
            } else {
                Some(ConfidenceState::Candidate { successes, failures })
            }
        }
        ConfidenceState::Active { confidence } => {
            // Decay trigger is external (time-based); this handles the transition
            Some(ConfidenceState::Decaying {
                confidence: *confidence,
                decay_rate: 0.5, // default: half-life
            })
        }
        ConfidenceState::Decaying { confidence, .. } => {
            if should_revoke(*confidence, REVOCATION_THRESHOLD) {
                Some(ConfidenceState::Revoked {
                    reason: "confidence decayed below threshold".to_string(),
                    revoked_at: now_epoch(),
                })
            } else {
                None // Stay in Decaying
            }
        }
        _ => None,
    }
}

/// Compute initial confidence from success count (logarithmic scale).
pub fn initial_confidence(successes: u32) -> f64 {
    if successes == 0 {
        0.0
    } else {
        (1.0 + (successes as f64).ln() * 0.15).min(1.0)
    }
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_no_time_no_change() {
        let result = apply_decay(0.8, 0.0, 30.0);
        assert!((result - 0.8).abs() < f64::EPSILON);
    }

    #[test]
    fn decay_one_half_life() {
        let result = apply_decay(1.0, 30.0, 30.0);
        assert!((result - 0.5).abs() < 0.001);
    }

    #[test]
    fn decay_two_half_lives() {
        let result = apply_decay(1.0, 60.0, 30.0);
        assert!((result - 0.25).abs() < 0.001);
    }

    #[test]
    fn decay_clamps_to_zero() {
        let result = apply_decay(0.01, 300.0, 30.0);
        assert!(result >= 0.0);
        assert!(result < 0.01);
    }

    #[test]
    fn decay_clamps_to_one() {
        let result = apply_decay(1.0, 0.0, 30.0);
        assert!(result <= 1.0);
    }

    #[test]
    fn decay_invalid_half_life() {
        let result = apply_decay(0.8, 30.0, 0.0);
        assert!((result - 0.8).abs() < f64::EPSILON);
    }

    #[test]
    fn should_revoke_below_threshold() {
        assert!(should_revoke(0.03, REVOCATION_THRESHOLD));
        assert!(!should_revoke(0.1, REVOCATION_THRESHOLD));
        assert!(!should_revoke(0.05, REVOCATION_THRESHOLD)); // exactly at threshold is not below
    }

    #[test]
    fn initial_confidence_from_successes() {
        let c0 = initial_confidence(0);
        assert_eq!(c0, 0.0);

        let c1 = initial_confidence(1);
        assert!((c1 - 1.0).abs() < 0.001); // ln(1) = 0 → 1.0

        let c3 = initial_confidence(3);
        // ln(3) ≈ 1.099 → 1.0 + 0.165 ≈ 1.165 → clamped to 1.0
        assert!((c3 - 1.0).abs() < 0.001);
    }

    #[test]
    fn candidate_promotes_after_threshold() {
        let from = ConfidenceState::Candidate { successes: 3, failures: 0 };
        let result = transition_to(&from, 3, 0, 3);
        match result {
            Some(ConfidenceState::Active { confidence }) => {
                assert!(confidence > 0.0);
            }
            other => panic!("expected Active, got {:?}", other),
        }
    }

    #[test]
    fn candidate_stays_with_failures() {
        let from = ConfidenceState::Candidate { successes: 3, failures: 1 };
        let result = transition_to(&from, 3, 1, 3);
        match result {
            Some(ConfidenceState::Candidate { successes, failures }) => {
                assert_eq!(successes, 3);
                assert_eq!(failures, 1);
            }
            other => panic!("expected Candidate, got {:?}", other),
        }
    }

    #[test]
    fn decaying_revokes_when_below_threshold() {
        let from = ConfidenceState::Decaying {
            confidence: 0.02,
            decay_rate: 0.5,
        };
        let result = transition_to(&from, 0, 0, 3);
        match result {
            Some(ConfidenceState::Revoked { reason, .. }) => {
                assert!(reason.contains("decayed"));
            }
            other => panic!("expected Revoked, got {:?}", other),
        }
    }
}

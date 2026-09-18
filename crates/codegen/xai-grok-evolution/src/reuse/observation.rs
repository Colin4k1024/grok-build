//! Reuse observation: track how a reused experience performed.
//!
//! After an experience is injected into a task, the outcome is recorded
//! as a `ReuseObservation`. This feeds back into the confidence system:
//! - `Helped` → increment success_count → confidence boost
//! - `Hindered` → increment failure_count → may trigger quarantine
//! - `Neutral` / `Unknown` → no confidence change

use crate::error::EvolutionError;
use crate::events::store::EvolutionStore;
use crate::events::{EvolutionEvent, QuarantineReason, QuarantineReasonType};
use crate::types::*;

/// Record a reuse observation and update the experience's confidence.
///
/// This function:
/// 1. Appends a `ReuseObserved` event to the store.
/// 2. If the outcome is `Hindered`, checks quarantine thresholds.
/// 3. If the outcome is `Helped`, updates success count for promotion.
pub fn record_observation(
    store: &EvolutionStore,
    experience_id: &str,
    run_id: &str,
    outcome: ReuseOutcome,
    context_hash: ContentHash,
) -> Result<ReuseObservation, EvolutionError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let observation_id = uuid::Uuid::new_v4().to_string();

    let observation = ReuseObservation {
        observation_id: observation_id.clone(),
        schema_version: CURRENT_SCHEMA_VERSION,
        experience_id: experience_id.to_string(),
        run_id: run_id.to_string(),
        outcome,
        context_hash,
        observed_at: now,
    };

    let event = EvolutionEvent::ReuseObserved {
        run_id: run_id.to_string(),
        observation: observation.clone(),
    };

    store.append_event(
        run_id,
        &event,
        None,
        Some(&format!("reuse-{}", observation_id)),
    )?;

    Ok(observation)
}

/// Check if an experience should be quarantined based on recent observations.
///
/// Returns a QuarantineReason if the failure count exceeds the threshold.
pub fn check_quarantine_after_reuse(
    store: &EvolutionStore,
    experience_id: &str,
    quarantine_after_failures: u32,
) -> Result<Option<QuarantineReason>, EvolutionError> {
    let candidates = store.experiences_by_state(ExperienceState::Active)?;
    let exp = candidates.iter().find(|e| e.experience_id == experience_id);

    if let Some(exp) = exp
        && exp.failure_count >= quarantine_after_failures
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        return Ok(Some(QuarantineReason {
            reason_type: QuarantineReasonType::ConsecutiveFailures,
            description: format!(
                "{} consecutive reuse failures (threshold: {})",
                exp.failure_count, quarantine_after_failures
            ),
            triggering_run_id: None,
            quarantined_at: now,
        }));
    }

    Ok(None)
}

/// Build a confidence transition event for an experience after reuse.
pub fn build_confidence_transition(
    experience_id: &str,
    run_id: &str,
    outcome: ReuseOutcome,
    current_state: &ExperienceState,
    current_successes: u32,
    current_failures: u32,
    promote_after: u32,
) -> Option<ConfidenceTransition> {
    let (new_successes, new_failures) = match outcome {
        ReuseOutcome::Helped => (current_successes + 1, current_failures),
        ReuseOutcome::Hindered => (current_successes, current_failures + 1),
        _ => return None,
    };

    let new_state = match current_state {
        ExperienceState::Candidate => {
            if new_successes >= promote_after && new_failures == 0 {
                ConfidenceState::Active {
                    confidence: crate::state::confidence::initial_confidence(new_successes),
                }
            } else {
                ConfidenceState::Candidate {
                    successes: new_successes,
                    failures: new_failures,
                }
            }
        }
        ExperienceState::Active => {
            // Active stays Active, confidence may change
            ConfidenceState::Active {
                confidence: crate::state::confidence::initial_confidence(new_successes),
            }
        }
        _ => return None,
    };

    let from = match current_state {
        ExperienceState::Candidate => ConfidenceState::Candidate {
            successes: current_successes,
            failures: current_failures,
        },
        ExperienceState::Active => ConfidenceState::Active {
            confidence: 0.5, // approximate
        },
        _ => return None,
    };

    Some(ConfidenceTransition {
        run_id: run_id.to_string(),
        experience_id: experience_id.to_string(),
        from,
        to: new_state,
    })
}

/// Intermediate struct for confidence transition events.
pub struct ConfidenceTransition {
    pub run_id: String,
    pub experience_id: String,
    pub from: ConfidenceState,
    pub to: ConfidenceState,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_helped_observation() {
        let store = EvolutionStore::open_memory().unwrap();
        let obs = record_observation(
            &store,
            "exp-1",
            "run-1",
            ReuseOutcome::Helped,
            "ctx-hash".to_string(),
        )
        .unwrap();

        assert_eq!(obs.experience_id, "exp-1");
        assert_eq!(obs.outcome, ReuseOutcome::Helped);
    }

    #[test]
    fn record_hindered_observation() {
        let store = EvolutionStore::open_memory().unwrap();
        let obs = record_observation(
            &store,
            "exp-1",
            "run-1",
            ReuseOutcome::Hindered,
            "ctx-hash".to_string(),
        )
        .unwrap();

        assert_eq!(obs.outcome, ReuseOutcome::Hindered);
    }

    #[test]
    fn confidence_transition_candidate_to_active() {
        let transition = build_confidence_transition(
            "exp-1",
            "run-1",
            ReuseOutcome::Helped,
            &ExperienceState::Candidate,
            2, // 2 successes already
            0,
            3, // need 3 to promote
        )
        .unwrap();

        match transition.to {
            ConfidenceState::Active { confidence } => {
                assert!(confidence > 0.0);
            }
            other => panic!("expected Active, got {:?}", other),
        }
    }

    #[test]
    fn confidence_transition_stays_candidate() {
        let transition = build_confidence_transition(
            "exp-1",
            "run-1",
            ReuseOutcome::Helped,
            &ExperienceState::Candidate,
            1, // only 1 success
            0,
            3, // need 3
        )
        .unwrap();

        match transition.to {
            ConfidenceState::Candidate { successes, failures } => {
                assert_eq!(successes, 2);
                assert_eq!(failures, 0);
            }
            other => panic!("expected Candidate, got {:?}", other),
        }
    }

    #[test]
    fn confidence_transition_neutral_outcome_no_change() {
        let result = build_confidence_transition(
            "exp-1",
            "run-1",
            ReuseOutcome::Neutral,
            &ExperienceState::Active,
            3,
            0,
            3,
        );
        assert!(result.is_none());
    }

    #[test]
    fn quarantine_check_returns_none_below_threshold() {
        let store = EvolutionStore::open_memory().unwrap();
        let result = check_quarantine_after_reuse(&store, "exp-1", 2).unwrap();
        assert!(result.is_none());
    }
}

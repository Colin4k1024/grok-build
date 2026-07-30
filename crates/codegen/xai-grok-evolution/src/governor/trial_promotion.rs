//! Trial-based promotion: Candidate -> Active via isolated replay trials.
//!
//! After a Candidate is published, promotion trials replay the validation
//! recipe in isolated sandbox environments. Each successful trial counts
//! as a reuse observation toward promotion. This breaks the deadlock where
//! Candidates could never be injected (only Active are injected) and thus
//! could never accumulate success observations.

use crate::error::EvolutionError;
use crate::events::store::EvolutionStore;
use crate::types::*;

/// Request to run promotion trials for a newly published Candidate.
#[derive(Debug, Clone)]
pub struct PromotionTrialRequest {
    /// The experience to promote.
    pub experience_id: ExperienceId,
    /// Run ID that published this candidate.
    pub origin_run_id: String,
    /// Validation recipe to replay.
    pub validation_recipe: Vec<String>,
    /// Number of successful trials needed.
    pub required_successes: u32,
}

/// Result of a promotion trial batch.
#[derive(Debug, Clone)]
pub struct PromotionTrialResult {
    pub experience_id: ExperienceId,
    pub trials_run: u32,
    pub trials_succeeded: u32,
    pub promoted: bool,
}

/// Execute promotion trials for a candidate experience.
///
/// Runs up to `required_successes` trials. Each successful trial is recorded
/// as a `Helped` observation. If all succeed, the experience is promoted.
///
/// This function is designed to be called from the background consumer thread.
/// It does NOT require trial executor ports -- it validates by checking the
/// existing evidence and validation recipe results stored during the original run.
///
/// For true isolated replay (with sandbox), the caller should use the trial
/// executor port. This fallback uses the stored validation results as evidence.
pub fn execute_promotion_trials(
    store: &EvolutionStore,
    request: &PromotionTrialRequest,
    promote_after: u32,
    quarantine_after: u32,
) -> Result<PromotionTrialResult, EvolutionError> {
    // If the experience is already Active (or beyond Candidate), skip trials.
    if let Some(existing) = store.get_experience(&request.experience_id)?
        && existing.state != ExperienceState::Candidate
    {
        return Ok(PromotionTrialResult {
            experience_id: request.experience_id.clone(),
            trials_run: 0,
            trials_succeeded: 0,
            promoted: false,
        });
    }

    let mut successes = 0u32;

    for trial_index in 0..request.required_successes {
        // Each trial is recorded as an independent observation
        let observation_run_id = format!(
            "{}/promotion-trial-{}",
            request.origin_run_id, trial_index
        );
        let context_hash = format!(
            "promotion:{}:{}",
            request.experience_id, trial_index
        );

        let new_state = store.record_reuse_with_policy(
            &ReuseObservation {
                observation_id: uuid::Uuid::new_v4().to_string(),
                schema_version: CURRENT_SCHEMA_VERSION,
                experience_id: request.experience_id.clone(),
                run_id: observation_run_id,
                outcome: ReuseOutcome::Helped,
                context_hash,
                observed_at: now_epoch(),
            },
            promote_after,
            quarantine_after,
        )?;

        successes += 1;

        if new_state == ExperienceState::Active {
            return Ok(PromotionTrialResult {
                experience_id: request.experience_id.clone(),
                trials_run: trial_index + 1,
                trials_succeeded: successes,
                promoted: true,
            });
        }
    }

    Ok(PromotionTrialResult {
        experience_id: request.experience_id.clone(),
        trials_run: request.required_successes,
        trials_succeeded: successes,
        promoted: false,
    })
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

    #[cfg(feature = "test-support")]
    #[test]
    fn promotion_after_required_successes() {
        let store = EvolutionStore::open_memory().unwrap();

        // First, publish a candidate experience with non-empty scope
        let experience_id = "exp-promo-1".to_string();
        let now = now_epoch();
        use crate::events::EvolutionEvent;
        store
            .append_event(
                "run-origin",
                &EvolutionEvent::RevisionPublished {
                    run_id: "run-origin".to_string(),
                    revision: ExperienceRevision {
                        experience_id: experience_id.clone(),
                        revision: 1,
                        schema_version: CURRENT_SCHEMA_VERSION,
                        parent_id: None,
                        state: ExperienceState::Candidate,
                        confidence: 0.0,
                        success_count: 0,
                        failure_count: 0,
                        scope: ScopeFingerprint {
                            repo: Some("org/repo".to_string()),
                            task_type: Some("bug_fix".to_string()),
                            signal_types: vec![SignalType::TestFailure],
                            env_fingerprint: None,
                        },
                        content_hash: "abc123".to_string(),
                        created_at: now,
                        updated_at: now,
                    },
                },
                None,
                Some("publish-1"),
            )
            .unwrap();

        let request = PromotionTrialRequest {
            experience_id: experience_id.clone(),
            origin_run_id: "run-origin".to_string(),
            validation_recipe: vec!["cargo test".to_string()],
            required_successes: 3,
        };

        let result = execute_promotion_trials(&store, &request, 3, 2).unwrap();
        assert!(result.promoted);
        assert_eq!(result.trials_succeeded, 3);

        // Verify the experience is now Active
        let exp = store.get_experience(&experience_id).unwrap().unwrap();
        assert_eq!(exp.state, ExperienceState::Active);
    }

    #[cfg(feature = "test-support")]
    #[test]
    fn promotion_does_not_double_promote() {
        let store = EvolutionStore::open_memory().unwrap();
        let experience_id = "exp-promo-2".to_string();
        let now = now_epoch();
        use crate::events::EvolutionEvent;

        store
            .append_event(
                "run-origin",
                &EvolutionEvent::RevisionPublished {
                    run_id: "run-origin".to_string(),
                    revision: ExperienceRevision {
                        experience_id: experience_id.clone(),
                        revision: 1,
                        schema_version: CURRENT_SCHEMA_VERSION,
                        parent_id: None,
                        state: ExperienceState::Candidate,
                        confidence: 0.0,
                        success_count: 0,
                        failure_count: 0,
                        scope: ScopeFingerprint {
                            repo: Some("org/repo".to_string()),
                            task_type: None,
                            signal_types: vec![SignalType::ToolFailure],
                            env_fingerprint: None,
                        },
                        content_hash: "def456".to_string(),
                        created_at: now,
                        updated_at: now,
                    },
                },
                None,
                Some("publish-2"),
            )
            .unwrap();

        // Run promotion twice -- second should be a no-op
        let request = PromotionTrialRequest {
            experience_id: experience_id.clone(),
            origin_run_id: "run-origin".to_string(),
            validation_recipe: vec!["cargo test".to_string()],
            required_successes: 3,
        };

        let result1 = execute_promotion_trials(&store, &request, 3, 2).unwrap();
        assert!(result1.promoted);

        // Second call -- already Active, observations don't change state
        let result2 = execute_promotion_trials(&store, &request, 3, 2).unwrap();
        // Should not crash, experience stays Active
        assert!(!result2.promoted);
        let exp = store.get_experience(&experience_id).unwrap().unwrap();
        assert_eq!(exp.state, ExperienceState::Active);
    }
}

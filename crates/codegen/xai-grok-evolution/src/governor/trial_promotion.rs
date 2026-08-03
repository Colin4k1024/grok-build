//! Trial-based promotion: Candidate -> Active via isolated replay trials.
//!
//! After a Candidate is published, promotion trials replay the validation
//! recipe in isolated sandbox environments. Each successful trial counts
//! as a reuse observation toward promotion. This breaks the deadlock where
//! Candidates could never be injected (only Active are injected) and thus
//! could never accumulate success observations.

use tokio_util::sync::CancellationToken;

use crate::engine::{TrialExecutor, TrialValidator};
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
    /// The candidate being promoted (needed to construct TrialSpec and call executor).
    pub candidate: ExperienceCandidate,
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
/// Each trial runs the validation recipe through the sandbox executor and
/// validator. Only genuinely passing trials record `Helped` observations.
/// Failing trials record `Neutral`. Executor errors record `Hindered` and
/// abort remaining trials (fail-closed).
pub fn execute_promotion_trials(
    store: &EvolutionStore,
    request: &PromotionTrialRequest,
    executor: &dyn TrialExecutor,
    validator: &dyn TrialValidator,
    promote_after: u32,
    quarantine_after: u32,
    cancel: &CancellationToken,
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
        if cancel.is_cancelled() {
            break;
        }

        let observation_run_id = format!(
            "{}/promotion-trial-{}",
            request.origin_run_id, trial_index
        );
        let context_hash = format!(
            "promotion:{}:{}",
            request.experience_id, trial_index
        );

        let spec = TrialSpec {
            spec_id: format!("promo-spec-{}-{}", request.experience_id, trial_index),
            schema_version: CURRENT_SCHEMA_VERSION,
            candidate_id: request.candidate.candidate_id.clone(),
            allowed_paths: request.candidate.proposal.allowed_paths.clone(),
            forbidden_actions: request.candidate.proposal.forbidden_actions.clone(),
            budget: TrialBudget {
                max_duration_secs: 300,
                max_artifact_bytes: 10 * 1024 * 1024,
                max_files_changed: 50,
                max_lines_changed: 2000,
            },
            validation_recipe: request.validation_recipe.clone(),
            max_variant_rounds: 1,
        };

        // Execute the trial in sandbox
        let execution = match executor.execute(
            &observation_run_id,
            &request.candidate,
            &spec,
            cancel,
        ) {
            Ok(exec) => exec,
            Err(error) => {
                tracing::warn!(
                    trial = trial_index,
                    %error,
                    "promotion trial executor failed — recording Hindered and aborting"
                );
                store.record_reuse_with_policy(
                    &ReuseObservation {
                        observation_id: uuid::Uuid::new_v4().to_string(),
                        schema_version: CURRENT_SCHEMA_VERSION,
                        experience_id: request.experience_id.clone(),
                        run_id: observation_run_id,
                        outcome: ReuseOutcome::Hindered,
                        context_hash,
                        observed_at: now_epoch(),
                    },
                    promote_after,
                    quarantine_after,
                )?;
                return Ok(PromotionTrialResult {
                    experience_id: request.experience_id.clone(),
                    trials_run: trial_index + 1,
                    trials_succeeded: successes,
                    promoted: false,
                });
            }
        };

        // Validate the execution result
        let outcome = match validator.validate(&request.candidate, &execution) {
            Ok(comparison) => {
                let all_candidate_passed = comparison
                    .candidate
                    .iter()
                    .all(|r| r.passed);
                if all_candidate_passed {
                    ReuseOutcome::Helped
                } else {
                    ReuseOutcome::Neutral
                }
            }
            Err(error) => {
                tracing::warn!(
                    trial = trial_index,
                    %error,
                    "promotion trial validator failed — recording Neutral"
                );
                ReuseOutcome::Neutral
            }
        };

        let new_state = store.record_reuse_with_policy(
            &ReuseObservation {
                observation_id: uuid::Uuid::new_v4().to_string(),
                schema_version: CURRENT_SCHEMA_VERSION,
                experience_id: request.experience_id.clone(),
                run_id: observation_run_id,
                outcome,
                context_hash,
                observed_at: now_epoch(),
            },
            promote_after,
            quarantine_after,
        )?;

        if outcome == ReuseOutcome::Helped {
            successes += 1;
        }

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

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct MockExecutor {
        should_succeed: bool,
    }

    impl TrialExecutor for MockExecutor {
        fn execute(
            &self,
            run_id: &str,
            _candidate: &ExperienceCandidate,
            _spec: &TrialSpec,
            _cancel: &CancellationToken,
        ) -> Result<TrialExecution, EvolutionError> {
            if self.should_succeed {
                Ok(TrialExecution {
                    outcome: TrialOutcome {
                        outcome_id: format!("outcome-{run_id}"),
                        schema_version: CURRENT_SCHEMA_VERSION,
                        spec_id: "spec-1".to_string(),
                        result: TrialResult::Success,
                        duration_ms: 100,
                        files_changed: vec![],
                        lines_added: 0,
                        lines_removed: 0,
                        validation_results: vec![ValidationResult {
                            command: vec!["cargo".to_string(), "test".to_string()],
                            exit_code: 0,
                            stdout_hash: "stdout-hash".to_string(),
                            stderr_hash: "stderr-hash".to_string(),
                            passed: true,
                            duration_ms: 50,
                        }],
                        artifact_hash: None,
                        completed_at: now_epoch(),
                    },
                    baseline_results: vec![],
                    evidence: EvidenceBundle {
                        bundle_id: "bundle-1".to_string(),
                        schema_version: CURRENT_SCHEMA_VERSION,
                        run_id: run_id.to_string(),
                        refs: vec![],
                        content_hash: "evidence-hash".to_string(),
                        total_bytes: 0,
                        scrubbed: true,
                        created_at: now_epoch(),
                    },
                    staged_evidence_path: PathBuf::from("/tmp/staged"),
                    diff: String::new(),
                    source_hash_before: "before".to_string(),
                    source_hash_after: "after".to_string(),
                })
            } else {
                Err(EvolutionError::SandboxUnavailable(
                    "mock executor failure".to_string(),
                ))
            }
        }
    }

    struct MockValidator {
        should_pass: bool,
    }

    impl TrialValidator for MockValidator {
        fn validate(
            &self,
            _candidate: &ExperienceCandidate,
            _execution: &TrialExecution,
        ) -> Result<ValidationComparison, EvolutionError> {
            Ok(ValidationComparison {
                baseline: vec![],
                candidate: vec![ValidationResult {
                    command: vec!["cargo".to_string(), "test".to_string()],
                    exit_code: if self.should_pass { 0 } else { 1 },
                    stdout_hash: "stdout".to_string(),
                    stderr_hash: "stderr".to_string(),
                    passed: self.should_pass,
                    duration_ms: 50,
                }],
            })
        }
    }

    fn test_candidate() -> ExperienceCandidate {
        ExperienceCandidate {
            candidate_id: "cand-1".to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            trigger_signals: vec!["test_failure".to_string()],
            proposal: VariantProposal {
                target: "src/lib.rs".to_string(),
                preconditions: vec![],
                allowed_paths: vec!["src/".to_string()],
                forbidden_actions: vec![],
                expected_benefit: "fix null check".to_string(),
                validation_command: vec!["cargo".to_string(), "test".to_string()],
                success_predicate: "all tests pass".to_string(),
                patch: None,
            },
            parent_revision_id: None,
            created_at: now_epoch(),
        }
    }

    use crate::engine::ValidationComparison;

    // TrialExecution needs to be imported from engine
    use crate::engine::TrialExecution;

    #[test]
    fn promotion_after_required_successes() {
        let store = EvolutionStore::open_memory().unwrap();
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

        let executor = MockExecutor { should_succeed: true };
        let validator = MockValidator { should_pass: true };
        let cancel = CancellationToken::new();

        let request = PromotionTrialRequest {
            experience_id: experience_id.clone(),
            origin_run_id: "run-origin".to_string(),
            validation_recipe: vec!["cargo test".to_string()],
            required_successes: 3,
            candidate: test_candidate(),
        };

        let result = execute_promotion_trials(
            &store, &request, &executor, &validator, 3, 2, &cancel,
        )
        .unwrap();
        assert!(result.promoted);
        assert_eq!(result.trials_succeeded, 3);

        let exp = store.get_experience(&experience_id).unwrap().unwrap();
        assert_eq!(exp.state, ExperienceState::Active);
    }

    #[test]
    fn executor_failure_aborts_and_does_not_promote() {
        let store = EvolutionStore::open_memory().unwrap();
        let experience_id = "exp-promo-fail".to_string();
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
                        content_hash: "def456".to_string(),
                        created_at: now,
                        updated_at: now,
                    },
                },
                None,
                Some("publish-fail"),
            )
            .unwrap();

        let executor = MockExecutor { should_succeed: false };
        let validator = MockValidator { should_pass: true };
        let cancel = CancellationToken::new();

        let request = PromotionTrialRequest {
            experience_id: experience_id.clone(),
            origin_run_id: "run-origin".to_string(),
            validation_recipe: vec!["cargo test".to_string()],
            required_successes: 3,
            candidate: test_candidate(),
        };

        let result = execute_promotion_trials(
            &store, &request, &executor, &validator, 3, 2, &cancel,
        )
        .unwrap();
        assert!(!result.promoted);
        assert_eq!(result.trials_succeeded, 0);
        assert_eq!(result.trials_run, 1);

        let exp = store.get_experience(&experience_id).unwrap().unwrap();
        assert_eq!(exp.state, ExperienceState::Candidate);
    }

    #[test]
    fn validation_failure_records_neutral_not_helped() {
        let store = EvolutionStore::open_memory().unwrap();
        let experience_id = "exp-promo-neutral".to_string();
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
                        content_hash: "ghi789".to_string(),
                        created_at: now,
                        updated_at: now,
                    },
                },
                None,
                Some("publish-neutral"),
            )
            .unwrap();

        // Executor succeeds but validator says tests failed
        let executor = MockExecutor { should_succeed: true };
        let validator = MockValidator { should_pass: false };
        let cancel = CancellationToken::new();

        let request = PromotionTrialRequest {
            experience_id: experience_id.clone(),
            origin_run_id: "run-origin".to_string(),
            validation_recipe: vec!["cargo test".to_string()],
            required_successes: 3,
            candidate: test_candidate(),
        };

        let result = execute_promotion_trials(
            &store, &request, &executor, &validator, 3, 2, &cancel,
        )
        .unwrap();
        assert!(!result.promoted);
        assert_eq!(result.trials_succeeded, 0);
        assert_eq!(result.trials_run, 3);

        // Experience stays Candidate since no Helped observations
        let exp = store.get_experience(&experience_id).unwrap().unwrap();
        assert_eq!(exp.state, ExperienceState::Candidate);
    }
}

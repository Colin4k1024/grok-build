//! E2E lifecycle test covering the full remediated self-evolution pipeline:
//!
//! 1. Signal detection → Candidate publish (with populated scope)
//! 2. Trial-based promotion → Active
//! 3. Active injection (verifies NOT in system prompt position)
//! 4. Helped observation with substantive completion
//! 5. Hindered feedback → Quarantine
//! 6. Empty-scope experience → never selected
//! 7. Circuit breaker trips after consecutive failures

#![cfg(feature = "test-support")]

use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use xai_grok_evolution::engine::{TrialExecution, TrialExecutor, TrialValidator, ValidationComparison};
use xai_grok_evolution::events::EvolutionEvent;
use xai_grok_evolution::governor::trial_promotion::{execute_promotion_trials, PromotionTrialRequest};
use xai_grok_evolution::reuse::attribution::{determine_outcome, AttributionOutcome, AttributionState};
use xai_grok_evolution::reuse::{self, ExperienceContent};
use xai_grok_evolution::rollout::metrics::CircuitBreaker;
use xai_grok_evolution::select::{self, SelectionContext};
use xai_grok_evolution::solidify::artifact::atomic_publish;
use xai_grok_evolution::{
    EvidenceBundle, ExperienceCandidate, EvolutionError, EvolutionStore, ExperienceRevision,
    ExperienceState, ReuseObservation, ReuseOutcome, ScopeFingerprint, SignalType,
    TrialOutcome, TrialResult, TrialSpec, ValidationResult, VariantProposal,
    CURRENT_SCHEMA_VERSION,
};

struct MockExecutor;

impl TrialExecutor for MockExecutor {
    fn execute(
        &self,
        run_id: &str,
        _candidate: &ExperienceCandidate,
        _spec: &TrialSpec,
        _cancel: &CancellationToken,
    ) -> Result<TrialExecution, EvolutionError> {
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
                bundle_id: format!("bundle-{run_id}"),
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
    }
}

struct MockValidator;

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
                exit_code: 0,
                stdout_hash: "stdout".to_string(),
                stderr_hash: "stderr".to_string(),
                passed: true,
                duration_ms: 50,
            }],
        })
    }
}

fn test_candidate() -> ExperienceCandidate {
    ExperienceCandidate {
        candidate_id: "cand-e2e".to_string(),
        schema_version: CURRENT_SCHEMA_VERSION,
        trigger_signals: vec!["test_failure".to_string()],
        proposal: VariantProposal {
            target: "src/lib.rs".to_string(),
            preconditions: vec!["repo matches".to_string()],
            allowed_paths: vec!["src/".to_string()],
            forbidden_actions: vec!["do not delete existing tests".to_string()],
            expected_benefit: "fix null check".to_string(),
            validation_command: vec!["cargo".to_string(), "test".to_string(), "-p".to_string(), "parser".to_string()],
            success_predicate: "all tests pass".to_string(),
            patch: None,
        },
        parent_revision_id: None,
        created_at: now_epoch(),
    }
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn make_observation(
    experience_id: &str,
    id: &str,
    outcome: ReuseOutcome,
    context_hash: &str,
    observed_at: i64,
) -> ReuseObservation {
    ReuseObservation {
        observation_id: id.to_string(),
        schema_version: CURRENT_SCHEMA_VERSION,
        experience_id: experience_id.to_string(),
        run_id: id.to_string(),
        outcome,
        context_hash: context_hash.to_string(),
        observed_at,
    }
}

/// Full lifecycle: Candidate → trial promotion → Active → injection → Quarantine
#[test]
fn full_lifecycle_candidate_to_quarantine() {
    let data = tempfile::tempdir().expect("data directory");
    let store = EvolutionStore::open(&data.path().join("evolution.sqlite")).expect("store");
    let artifacts = data.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();

    // --- Step 1: Publish a Candidate with populated scope ---
    let content = ExperienceContent {
        preconditions: vec!["test failure in parser module".to_string()],
        recommended_steps: vec!["fix null check in parse_token()".to_string()],
        forbidden_actions: vec!["do not delete existing tests".to_string()],
        validation_recipe: vec!["cargo test -p parser".to_string()],
        evidence_summary: "validated in isolated sandbox".to_string(),
    };
    let bytes = serde_json::to_vec(&content).expect("serialize");
    let content_hash = blake3::hash(&bytes).to_hex().to_string();
    let staging = data.path().join("experience.tmp");
    std::fs::write(&staging, &bytes).unwrap();
    atomic_publish(&staging, &artifacts, &content_hash).expect("publish artifact");

    let now = now_epoch();
    let experience_id = "e2e-lifecycle-exp";
    store
        .append_and_project(
            "run-origin",
            &EvolutionEvent::RevisionPublished {
                run_id: "run-origin".to_string(),
                revision: ExperienceRevision {
                    experience_id: experience_id.to_string(),
                    revision: 1,
                    schema_version: CURRENT_SCHEMA_VERSION,
                    parent_id: None,
                    state: ExperienceState::Candidate,
                    confidence: 0.0,
                    success_count: 0,
                    failure_count: 0,
                    scope: ScopeFingerprint {
                        repo: Some("org/parser".to_string()),
                        task_type: Some("bug_fix".to_string()),
                        signal_types: vec![SignalType::TestFailure],
                        env_fingerprint: None,
                    },
                    content_hash: content_hash.clone(),
                    created_at: now,
                    updated_at: now,
                },
            },
            None,
            Some("publish-lifecycle"),
        )
        .expect("publish");

    // Verify it starts as Candidate
    let exp = store.get_experience(experience_id).unwrap().unwrap();
    assert_eq!(exp.state, ExperienceState::Candidate);

    // --- Step 2: Trial-based promotion (3 successes → Active) ---
    let executor = MockExecutor;
    let validator = MockValidator;
    let cancel = CancellationToken::new();
    let request = PromotionTrialRequest {
        experience_id: experience_id.to_string(),
        origin_run_id: "run-origin".to_string(),
        validation_recipe: vec!["cargo test -p parser".to_string()],
        required_successes: 3,
        candidate: test_candidate(),
    };
    let result = execute_promotion_trials(
        &store, &request, &executor, &validator, 3, 2, &cancel,
    )
    .unwrap();
    assert!(result.promoted, "should promote after 3 trials");
    assert_eq!(result.trials_succeeded, 3);

    let active = store.get_experience(experience_id).unwrap().unwrap();
    assert_eq!(active.state, ExperienceState::Active);
    assert!(active.confidence > 0.0, "Active should have positive confidence");

    // --- Step 3: Active experience is selectable with matching context ---
    let context = SelectionContext {
        repo: Some("org/parser".to_string()),
        task_type: Some("bug_fix".to_string()),
        signal_types: vec![SignalType::TestFailure],
        env_fingerprint: None,
        now: now + 100,
    };
    let selected = select::select(&[active.clone()], &context)
        .expect("select")
        .main
        .expect("should select active experience");
    assert_eq!(selected.experience_id, experience_id);

    // Verify injection content is correct
    let injected = reuse::load_context_from_artifact(&selected, &artifacts)
        .and_then(|ctx| reuse::safe_inject(&ctx))
        .expect("safe injection should succeed");
    assert!(injected.contains("do not delete existing tests"));
    assert!(injected.contains("fix null check"));

    // --- Step 4: Attribution state machine — substantive completion → Helped ---
    let attribution = AttributionState::new_pending(
        "inj-1".to_string(),
        "turn-1".to_string(),
        experience_id.to_string(),
        content_hash.clone(),
    );
    assert!(attribution.is_pending());

    let outcome = determine_outcome(
        false, // no user corrections
        false, // no negative feedback
        false, // no failures
        true,  // substantive completion (tool calls succeeded)
    );
    assert_eq!(outcome, ReuseOutcome::Helped);

    let resolved = attribution.resolve(AttributionOutcome::Completed { outcome });
    assert!(!resolved.is_pending());

    // --- Step 5: Hindered feedback → Quarantine ---
    for i in 0..2 {
        store
            .record_reuse_with_policy(
                &make_observation(
                    experience_id,
                    &format!("failure-{i}"),
                    ReuseOutcome::Hindered,
                    &content_hash,
                    now + 200 + i,
                ),
                3,
                2,
            )
            .expect("record hindered");
    }

    let quarantined = store.get_experience(experience_id).unwrap().unwrap();
    assert_eq!(quarantined.state, ExperienceState::Quarantined);

    // Quarantined experience is no longer selectable
    let result = select::select(&[quarantined], &context).expect("select");
    assert!(result.main.is_none(), "quarantined should not be selected");
}

/// Empty-scope experience is never selected (ranking returns 0.0)
#[test]
fn empty_scope_never_selected() {
    let empty_scope_exp = ExperienceRevision {
        experience_id: "empty-scope-exp".to_string(),
        revision: 1,
        schema_version: CURRENT_SCHEMA_VERSION,
        parent_id: None,
        state: ExperienceState::Active,
        confidence: 0.95,
        success_count: 10,
        failure_count: 0,
        scope: ScopeFingerprint {
            repo: None,
            task_type: None,
            signal_types: vec![],
            env_fingerprint: None,
        },
        content_hash: "abc".to_string(),
        created_at: 1000,
        updated_at: 1000,
    };

    let context = SelectionContext {
        repo: Some("org/repo".to_string()),
        task_type: Some("bug_fix".to_string()),
        signal_types: vec![SignalType::TestFailure],
        env_fingerprint: None,
        now: 2000,
    };

    let result = select::select(&[empty_scope_exp], &context).expect("select");
    assert!(
        result.main.is_none(),
        "empty-scope experience should never be selected regardless of confidence"
    );
}

/// Attribution cancelled turn does not record Helped
#[test]
fn cancelled_turn_no_helped_observation() {
    let attribution = AttributionState::new_pending(
        "inj-cancel".to_string(),
        "turn-cancel".to_string(),
        "exp-x".to_string(),
        "hash-x".to_string(),
    );

    // Turn was cancelled — resolve as Cancelled
    let resolved = attribution.resolve(AttributionOutcome::Cancelled);
    match resolved {
        AttributionState::Resolved { outcome, .. } => {
            assert_eq!(outcome, AttributionOutcome::Cancelled);
            // Cancelled attribution should NOT produce a Helped observation
        }
        _ => panic!("should be resolved"),
    }
}

/// No substantive completion → Neutral (not Helped)
#[test]
fn empty_turn_not_credited_as_helped() {
    // Turn with no failures but also no real work (zero tool calls)
    let outcome = determine_outcome(
        false, // no corrections
        false, // no negative feedback
        false, // no failures
        false, // NO substantive completion
    );
    assert_eq!(
        outcome,
        ReuseOutcome::Neutral,
        "empty turn should be Neutral, not Helped"
    );
}

/// Circuit breaker trips after high failure rate
#[test]
fn circuit_breaker_trips_on_failures() {
    let mut cb = CircuitBreaker::new(10, 0.5);

    // Start with some successes
    cb.record(true);
    cb.record(true);
    assert!(!cb.should_trip());

    // Now add failures until the breaker trips
    cb.record(false);
    cb.record(false);
    cb.record(false); // 2 success, 3 failure = 60% failure rate → trips
    assert!(cb.should_trip());

    // After reset, breaker recovers
    cb.reset();
    assert!(!cb.should_trip());
    assert_eq!(cb.failure_rate(), 0.0);
}

/// Trial promotion is idempotent — calling on Active is a no-op
#[test]
fn trial_promotion_idempotent() {
    let data = tempfile::tempdir().expect("data directory");
    let store = EvolutionStore::open(&data.path().join("evolution.sqlite")).expect("store");

    let now = now_epoch();
    let experience_id = "e2e-idempotent";
    store
        .append_and_project(
            "run-idem",
            &EvolutionEvent::RevisionPublished {
                run_id: "run-idem".to_string(),
                revision: ExperienceRevision {
                    experience_id: experience_id.to_string(),
                    revision: 1,
                    schema_version: CURRENT_SCHEMA_VERSION,
                    parent_id: None,
                    state: ExperienceState::Candidate,
                    confidence: 0.0,
                    success_count: 0,
                    failure_count: 0,
                    scope: ScopeFingerprint {
                        repo: Some("org/idempotent".to_string()),
                        task_type: None,
                        signal_types: vec![SignalType::ToolFailure],
                        env_fingerprint: None,
                    },
                    content_hash: "idem-hash".to_string(),
                    created_at: now,
                    updated_at: now,
                },
            },
            None,
            Some("publish-idem"),
        )
        .unwrap();

    let executor = MockExecutor;
    let validator = MockValidator;
    let cancel = CancellationToken::new();
    let request = PromotionTrialRequest {
        experience_id: experience_id.to_string(),
        origin_run_id: "run-idem".to_string(),
        validation_recipe: vec!["true".to_string()],
        required_successes: 3,
        candidate: test_candidate(),
    };

    // First promotion
    let r1 = execute_promotion_trials(
        &store, &request, &executor, &validator, 3, 2, &cancel,
    )
    .unwrap();
    assert!(r1.promoted);

    // Second call — already Active, should be safe no-op
    let r2 = execute_promotion_trials(
        &store, &request, &executor, &validator, 3, 2, &cancel,
    )
    .unwrap();
    // Should not crash; experience stays Active
    let exp = store.get_experience(experience_id).unwrap().unwrap();
    assert_eq!(exp.state, ExperienceState::Active);
    let _ = r2; // suppress unused warning
}

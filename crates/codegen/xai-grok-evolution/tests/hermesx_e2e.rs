//! E2E self-evolution lifecycle test targeting the hermesx Go workspace.
//!
//! Demonstrates the full 8-stage pipeline:
//! Detect → Select → Mutate → Execute → Validate → Evaluate → Solidify → Reuse
//!
//! Scenario: A Go test failure in `hermesx/internal/evolution/` triggers the
//! evolution system. It generates a fix candidate, validates via `go test`,
//! solidifies the experience, and reuses it on the next matching signal.
//!
//! Run with:
//!   cargo test -p xai-grok-evolution --features test-support --test hermesx_e2e

#![cfg(feature = "test-support")]

use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use xai_grok_evolution::engine::{
    EngineRunResult, EvolutionEngine, TrialEvaluator, TrialExecution, TrialExecutor,
    TrialValidator, ValidationComparison, VariantGenerator,
};
use xai_grok_evolution::events::{EvaluationResult, EvolutionEvent};
use xai_grok_evolution::governor::trial_promotion::{execute_promotion_trials, PromotionTrialRequest};
use xai_grok_evolution::reuse::{self, ExperienceContent};
use xai_grok_evolution::rollout::killswitch::global_kill_switch;
use xai_grok_evolution::select::{self, SelectionContext};
use xai_grok_evolution::solidify::artifact::atomic_publish;
use xai_grok_evolution::{
    AdoptionDecision, EvolutionConfig, EvolutionError, EvolutionMode, EvolutionStore,
    EvidenceBundle, ExperienceCandidate, ExperienceRevision, ExperienceState, ReuseOutcome,
    ScopeFingerprint, SignalSeverity, SignalSource, SignalType, TrialOutcome, TrialResult,
    TrialSpec, ValidationResult, VariantProposal, CURRENT_SCHEMA_VERSION,
};
use xai_grok_evolution::types::{EvolutionSignal, TriggerInfo, TriggerType};

// ---------------------------------------------------------------------------
// Constants: realistic Go patch for hermesx
// ---------------------------------------------------------------------------

const GO_FIX_PATCH: &str = r#"--- a/internal/evolution/gene.go
+++ b/internal/evolution/gene.go
@@ -45,6 +45,7 @@ func DetectTaskClass(input string) TaskClass {
 	debugKeywords := []string{
 		"error", "fix", "bug", "issue", "crash", "fail", "broken",
 		"debug", "traceback", "panic", "exception", "not working",
+		"segfault", "nil pointer", "deadlock", "race condition",
 	}
 	lower := strings.ToLower(input)
 	for _, kw := range debugKeywords {
"#;

// ---------------------------------------------------------------------------
// Mock ports for hermesx Go scenario
// ---------------------------------------------------------------------------

struct HermesxMockGenerator;

impl VariantGenerator for HermesxMockGenerator {
    fn generate(
        &self,
        run_id: &str,
        signals: &[EvolutionSignal],
        _selected: Option<&ExperienceRevision>,
    ) -> Result<ExperienceCandidate, EvolutionError> {
        Ok(ExperienceCandidate {
            candidate_id: format!("hermesx-cand-{run_id}"),
            schema_version: CURRENT_SCHEMA_VERSION,
            trigger_signals: signals.iter().map(|s| s.signal_id.clone()).collect(),
            proposal: VariantProposal {
                target: "internal/evolution/gene.go".to_string(),
                preconditions: vec![
                    "hermesx Go workspace".to_string(),
                    "TestDetectTaskClass fails on debug keyword matching".to_string(),
                ],
                allowed_paths: vec!["internal/evolution/".to_string()],
                forbidden_actions: vec![
                    "do not modify test assertions".to_string(),
                    "do not remove existing keywords".to_string(),
                ],
                expected_benefit: "extend debug keyword list to cover additional failure patterns"
                    .to_string(),
                validation_command: vec![
                    "go".to_string(),
                    "test".to_string(),
                    "./internal/evolution/...".to_string(),
                    "-v".to_string(),
                    "-count=1".to_string(),
                ],
                success_predicate: "all Go tests in internal/evolution pass".to_string(),
                patch: Some(GO_FIX_PATCH.to_string()),
            },
            parent_revision_id: None,
            created_at: now_epoch(),
        })
    }
}

struct HermesxMockExecutor {
    evidence_dir: PathBuf,
}

impl TrialExecutor for HermesxMockExecutor {
    fn execute(
        &self,
        run_id: &str,
        _candidate: &ExperienceCandidate,
        _spec: &TrialSpec,
        _cancel: &CancellationToken,
    ) -> Result<TrialExecution, EvolutionError> {
        // Create a real evidence staging file so publish_evidence can find it
        let evidence_content = format!("evidence for run {run_id}: go test passed");
        let evidence_bytes = evidence_content.as_bytes();
        let content_hash = blake3::hash(evidence_bytes).to_hex().to_string();
        let safe_name = run_id.replace('/', "_");
        let staging_path = self.evidence_dir.join(format!("evidence-{safe_name}.bin"));
        std::fs::write(&staging_path, evidence_bytes).map_err(|e| {
            EvolutionError::Internal(format!("write mock evidence: {e}"))
        })?;

        Ok(TrialExecution {
            outcome: TrialOutcome {
                outcome_id: format!("outcome-{run_id}"),
                schema_version: CURRENT_SCHEMA_VERSION,
                spec_id: "spec-hermesx".to_string(),
                result: TrialResult::Success,
                duration_ms: 3200,
                files_changed: vec!["internal/evolution/gene.go".to_string()],
                lines_added: 1,
                lines_removed: 0,
                validation_results: vec![ValidationResult {
                    command: vec![
                        "go".to_string(),
                        "test".to_string(),
                        "./internal/evolution/...".to_string(),
                        "-v".to_string(),
                        "-count=1".to_string(),
                    ],
                    exit_code: 0,
                    stdout_hash: blake3::hash(b"ok  hermesx/internal/evolution 0.8s")
                        .to_hex()
                        .to_string(),
                    stderr_hash: blake3::hash(b"").to_hex().to_string(),
                    passed: true,
                    duration_ms: 800,
                }],
                artifact_hash: None,
                completed_at: now_epoch(),
            },
            baseline_results: vec![ValidationResult {
                command: vec![
                    "go".to_string(),
                    "test".to_string(),
                    "./internal/evolution/...".to_string(),
                    "-v".to_string(),
                    "-count=1".to_string(),
                ],
                exit_code: 1,
                stdout_hash: blake3::hash(b"FAIL hermesx/internal/evolution")
                    .to_hex()
                    .to_string(),
                stderr_hash: blake3::hash(b"TestDetectTaskClass_Debug failed")
                    .to_hex()
                    .to_string(),
                passed: false,
                duration_ms: 600,
            }],
            evidence: EvidenceBundle {
                bundle_id: format!("bundle-{run_id}"),
                schema_version: CURRENT_SCHEMA_VERSION,
                run_id: run_id.to_string(),
                refs: vec![],
                content_hash,
                total_bytes: evidence_bytes.len() as u64,
                scrubbed: true,
                created_at: now_epoch(),
            },
            staged_evidence_path: staging_path,
            diff: GO_FIX_PATCH.to_string(),
            source_hash_before: blake3::hash(b"before-hermesx").to_hex().to_string(),
            source_hash_after: blake3::hash(b"after-hermesx").to_hex().to_string(),
        })
    }
}

struct HermesxMockValidator;

impl TrialValidator for HermesxMockValidator {
    fn validate(
        &self,
        _candidate: &ExperienceCandidate,
        _execution: &TrialExecution,
    ) -> Result<ValidationComparison, EvolutionError> {
        Ok(ValidationComparison {
            baseline: vec![ValidationResult {
                command: vec![
                    "go".to_string(),
                    "test".to_string(),
                    "./internal/evolution/...".to_string(),
                ],
                exit_code: 1,
                stdout_hash: "baseline-stdout".to_string(),
                stderr_hash: "baseline-stderr".to_string(),
                passed: false,
                duration_ms: 600,
            }],
            candidate: vec![ValidationResult {
                command: vec![
                    "go".to_string(),
                    "test".to_string(),
                    "./internal/evolution/...".to_string(),
                ],
                exit_code: 0,
                stdout_hash: "candidate-stdout".to_string(),
                stderr_hash: "candidate-stderr".to_string(),
                passed: true,
                duration_ms: 800,
            }],
        })
    }
}

struct HermesxMockEvaluator;

impl TrialEvaluator for HermesxMockEvaluator {
    fn evaluate(
        &self,
        _candidate: &ExperienceCandidate,
        _execution: &TrialExecution,
        _comparison: &ValidationComparison,
    ) -> Result<EvaluationResult, EvolutionError> {
        Ok(EvaluationResult {
            signals_resolved: true,
            correctness_score: 0.9,
            generalization_score: 0.7,
            test_coverage_delta: 0,
            complexity_assessment: "minimal: adds keywords to existing list".to_string(),
            token_cost: 1500,
            time_cost_ms: 3200,
            recommendation: AdoptionDecision::PublishCandidate,
            safety_gate_passed: true,
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn hermesx_signal() -> EvolutionSignal {
    EvolutionSignal {
        signal_id: "sig-hermesx-001".to_string(),
        schema_version: CURRENT_SCHEMA_VERSION,
        signal_type: SignalType::TestFailure,
        severity: SignalSeverity::High,
        source: SignalSource {
            session_id: "hermesx-test-session".to_string(),
            turn_id: Some("turn-1".to_string()),
            tool_name: Some("terminal".to_string()),
            file_path: Some("internal/evolution/gene.go".to_string()),
        },
        description: "go test ./internal/evolution/... failed: TestDetectTaskClass_Debug"
            .to_string(),
        context_hash: blake3::hash(b"hermesx-evolution-test-failure")
            .to_hex()
            .to_string(),
        created_at: now_epoch(),
    }
}

fn hermesx_context() -> SelectionContext {
    SelectionContext {
        repo: Some("Colin4k1024/hermesx".to_string()),
        task_type: Some("bug_fix".to_string()),
        signal_types: vec![SignalType::TestFailure],
        env_fingerprint: Some("go1.25.12-darwin-arm64".to_string()),
        now: now_epoch(),
    }
}

// ---------------------------------------------------------------------------
// Test 1: Full 8-stage pipeline via EvolutionEngine::run()
// ---------------------------------------------------------------------------

#[test]
fn hermesx_engine_full_pipeline() {
    global_kill_switch().deactivate();

    let data = tempfile::tempdir().expect("temp data directory");
    let store = EvolutionStore::open(&data.path().join("evolution.sqlite")).expect("open store");
    let artifacts_dir = data.path().join("artifacts");
    let staging_dir = data.path().join("staging");
    std::fs::create_dir_all(&artifacts_dir).unwrap();
    std::fs::create_dir_all(&staging_dir).unwrap();

    let kill_switch = global_kill_switch().clone();
    let cancel = CancellationToken::new();

    let evidence_dir = data.path().join("evidence");
    std::fs::create_dir_all(&evidence_dir).unwrap();

    let engine = EvolutionEngine::new(
        store.clone(),
        artifacts_dir.clone(),
        staging_dir,
        kill_switch,
        cancel,
    )
    .with_ports(
        Arc::new(HermesxMockGenerator),
        Arc::new(HermesxMockExecutor { evidence_dir }),
        Arc::new(HermesxMockValidator),
        Arc::new(HermesxMockEvaluator),
    );

    let config = EvolutionConfig {
        mode: EvolutionMode::IsolatedAutonomous,
        ..EvolutionConfig::default()
    };

    let trigger = TriggerInfo {
        trigger_type: TriggerType::TestFailure,
        source_event_id: Some("sig-hermesx-001".to_string()),
        description: "go test ./internal/evolution/... failed: TestDetectTaskClass_Debug"
            .to_string(),
    };

    let signals = vec![hermesx_signal()];
    let context = hermesx_context();

    // Run the full 8-stage pipeline
    let result: EngineRunResult = engine.run(&config, trigger, signals, context).unwrap();

    // Verify pipeline completed successfully
    assert_eq!(
        result.decision,
        AdoptionDecision::PublishCandidate,
        "engine should decide to publish the candidate"
    );
    assert!(
        result.published_experience_id.is_some(),
        "an experience should be published after successful pipeline"
    );

    // Verify the experience was persisted in the store
    let experience_id = result.published_experience_id.unwrap();
    let experience = store.get_experience(&experience_id).unwrap().unwrap();
    assert_eq!(experience.scope.repo, Some("Colin4k1024/hermesx".to_string()));
    assert_eq!(experience.scope.task_type, Some("bug_fix".to_string()));
    assert_eq!(experience.scope.signal_types, vec![SignalType::TestFailure]);

    // Verify the run completed
    let run = store.get_run(&result.run_id).unwrap().unwrap();
    assert_eq!(
        run.state,
        xai_grok_evolution::types::RunState::Completed,
        "run should be in Completed state"
    );

    // Verify all 8 stages were recorded as events
    let events = store.events_for_run(&result.run_id).unwrap();
    let stage_names: Vec<String> = events
        .iter()
        .filter_map(|e| e.decode().ok())
        .filter_map(|e| match e {
            EvolutionEvent::StageCompleted { stage, .. } => Some(stage),
            _ => None,
        })
        .collect();
    assert!(
        stage_names.contains(&"detect".to_string()),
        "detect stage should complete"
    );
    assert!(
        stage_names.contains(&"select".to_string()),
        "select stage should complete"
    );
    assert!(
        stage_names.contains(&"mutate".to_string()),
        "mutate stage should complete"
    );
    assert!(
        stage_names.contains(&"execute".to_string()),
        "execute stage should complete"
    );
    assert!(
        stage_names.contains(&"validate".to_string()),
        "validate stage should complete"
    );
    assert!(
        stage_names.contains(&"evaluate".to_string()),
        "evaluate stage should complete"
    );
    assert!(
        stage_names.contains(&"solidify".to_string()),
        "solidify stage should complete"
    );
    assert!(
        stage_names.contains(&"reuse".to_string()),
        "reuse stage should complete"
    );
}

// ---------------------------------------------------------------------------
// Test 2: Solidified experience is reused on repeat signal
// ---------------------------------------------------------------------------

#[test]
fn hermesx_reuse_injection_on_repeat_signal() {
    global_kill_switch().deactivate();

    let data = tempfile::tempdir().expect("temp data directory");
    let store = EvolutionStore::open(&data.path().join("evolution.sqlite")).expect("open store");
    let artifacts_dir = data.path().join("artifacts");
    std::fs::create_dir_all(&artifacts_dir).unwrap();

    // --- Manually publish an Active experience for hermesx ---
    let content = ExperienceContent {
        preconditions: vec![
            "hermesx Go workspace".to_string(),
            "TestDetectTaskClass fails on debug keyword matching".to_string(),
        ],
        recommended_steps: vec![
            "extend debug keyword list in internal/evolution/gene.go".to_string(),
            "run go test ./internal/evolution/... to verify".to_string(),
        ],
        forbidden_actions: vec![
            "do not modify test assertions".to_string(),
            "do not remove existing keywords".to_string(),
        ],
        validation_recipe: vec!["go test ./internal/evolution/... -v -count=1".to_string()],
        evidence_summary: "validated in isolated sandbox; baseline failed, candidate passed"
            .to_string(),
    };
    let bytes = serde_json::to_vec(&content).expect("serialize experience content");
    let content_hash = blake3::hash(&bytes).to_hex().to_string();
    let staging = data.path().join("experience.tmp");
    std::fs::write(&staging, &bytes).unwrap();
    atomic_publish(&staging, &artifacts_dir, &content_hash).expect("publish artifact");

    let now = now_epoch();
    let experience_id = "hermesx-exp-debug-keywords";
    store
        .append_and_project(
            "run-hermesx-origin",
            &EvolutionEvent::RevisionPublished {
                run_id: "run-hermesx-origin".to_string(),
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
                        repo: Some("Colin4k1024/hermesx".to_string()),
                        task_type: Some("bug_fix".to_string()),
                        signal_types: vec![SignalType::TestFailure],
                        env_fingerprint: Some("go1.25.12-darwin-arm64".to_string()),
                    },
                    content_hash: content_hash.clone(),
                    created_at: now,
                    updated_at: now,
                },
            },
            None,
            Some("hermesx-publish"),
        )
        .expect("publish revision event");

    // --- Promote via trial promotion: 3 mock successes → Active ---
    let evidence_dir = data.path().join("evidence");
    std::fs::create_dir_all(&evidence_dir).unwrap();
    let executor = HermesxMockExecutor { evidence_dir };
    let validator = HermesxMockValidator;
    let cancel = CancellationToken::new();
    let request = PromotionTrialRequest {
        experience_id: experience_id.to_string(),
        origin_run_id: "run-hermesx-origin".to_string(),
        validation_recipe: vec![
            "go test ./internal/evolution/... -v -count=1".to_string(),
        ],
        required_successes: 3,
        candidate: ExperienceCandidate {
            candidate_id: "hermesx-promo-cand".to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            trigger_signals: vec!["sig-hermesx-001".to_string()],
            proposal: VariantProposal {
                target: "internal/evolution/gene.go".to_string(),
                preconditions: vec!["hermesx workspace".to_string()],
                allowed_paths: vec!["internal/evolution/".to_string()],
                forbidden_actions: vec!["do not modify test assertions".to_string()],
                expected_benefit: "extend debug keyword coverage".to_string(),
                validation_command: vec![
                    "go".to_string(),
                    "test".to_string(),
                    "./internal/evolution/...".to_string(),
                    "-v".to_string(),
                    "-count=1".to_string(),
                ],
                success_predicate: "all tests pass".to_string(),
                patch: Some(GO_FIX_PATCH.to_string()),
            },
            parent_revision_id: None,
            created_at: now,
        },
    };
    let promo_result =
        execute_promotion_trials(&store, &request, &executor, &validator, 3, 2, &cancel)
            .expect("promotion trials should succeed");
    assert!(
        promo_result.promoted,
        "experience should be promoted to Active (trials_run={}, trials_succeeded={})",
        promo_result.trials_run,
        promo_result.trials_succeeded,
    );

    // Verify state is now Active
    let active = store.get_experience(experience_id).unwrap().unwrap();
    assert_eq!(active.state, ExperienceState::Active);
    assert!(active.confidence > 0.0);

    // --- Verify the experience is selected for a matching context ---
    let context = hermesx_context();
    let all_experiences = store.all_experiences().unwrap();
    let selection = select::select(&all_experiences, &context).expect("select");
    assert!(
        selection.main.is_some(),
        "Active hermesx experience should be selected for matching context"
    );
    let selected = selection.main.unwrap();
    assert_eq!(selected.experience_id, experience_id);

    // --- Verify injection content ---
    let injected_ctx = reuse::load_context_from_artifact(&selected, &artifacts_dir)
        .expect("should load experience from artifact");
    let prompt = reuse::safe_inject(&injected_ctx).expect("injection should be safe");

    assert!(
        prompt.contains("do not modify test assertions"),
        "forbidden actions should appear in injected prompt"
    );
    assert!(
        prompt.contains("do not remove existing keywords"),
        "all forbidden actions preserved"
    );
    assert!(
        prompt.contains("extend debug keyword list"),
        "recommended steps should appear"
    );
    assert!(
        prompt.contains("go test ./internal/evolution"),
        "validation recipe should appear"
    );

    // --- Verify non-matching context does NOT select this experience ---
    let unrelated_context = SelectionContext {
        repo: Some("other-org/other-repo".to_string()),
        task_type: Some("feature".to_string()),
        signal_types: vec![SignalType::ToolFailure],
        env_fingerprint: None,
        now: now_epoch(),
    };
    let unrelated_selection = select::select(&all_experiences, &unrelated_context).unwrap();
    assert!(
        unrelated_selection.main.is_none(),
        "hermesx experience should NOT be selected for unrelated context"
    );

    // --- Simulate quarantine after consecutive failures ---
    for i in 0..2 {
        store
            .record_reuse_with_policy(
                &xai_grok_evolution::ReuseObservation {
                    observation_id: format!("hermesx-failure-{i}"),
                    schema_version: CURRENT_SCHEMA_VERSION,
                    experience_id: experience_id.to_string(),
                    run_id: format!("hermesx-failure-run-{i}"),
                    outcome: ReuseOutcome::Hindered,
                    context_hash: content_hash.clone(),
                    observed_at: now + 1000 + i,
                },
                3,
                2,
            )
            .expect("record hindered");
    }

    let quarantined = store.get_experience(experience_id).unwrap().unwrap();
    assert_eq!(
        quarantined.state,
        ExperienceState::Quarantined,
        "2 consecutive failures should quarantine the experience"
    );

    // Quarantined experience is no longer selectable
    let all_after = store.all_experiences().unwrap();
    let quarantine_selection = select::select(&all_after, &context).unwrap();
    assert!(
        quarantine_selection.main.is_none(),
        "quarantined experience should not be injected"
    );
}

// ---------------------------------------------------------------------------
// Test 3: Full EvolutionService reuse lifecycle (approve → inject → observe)
// ---------------------------------------------------------------------------

#[test]
fn hermesx_service_reuse_lifecycle() {
    use xai_grok_evolution::rollout::{RolloutEvidence, RolloutReadiness};
    use xai_grok_evolution::service::EvolutionService;

    global_kill_switch().deactivate();

    let workspace = tempfile::tempdir().expect("workspace dir");
    let memory = tempfile::tempdir().expect("memory dir");

    // Initialize a git repo so workspace_identity can canonicalize
    std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(workspace.path())
        .status()
        .expect("git init");

    // Open the service in Shadow mode first
    let service = EvolutionService::open_at(
        workspace.path(),
        memory.path(),
        EvolutionConfig {
            mode: EvolutionMode::Shadow,
            ..EvolutionConfig::default()
        },
    )
    .expect("open service");

    // --- Step 1: Seed an Active experience ---
    let content = ExperienceContent {
        preconditions: vec![
            "hermesx Go workspace".to_string(),
            "go test fails in internal/evolution package".to_string(),
        ],
        recommended_steps: vec![
            "check DetectTaskClass keyword list for missing patterns".to_string(),
            "add missing debug keywords to the slice".to_string(),
            "run go test ./internal/evolution/... to verify".to_string(),
        ],
        forbidden_actions: vec![
            "do not modify test assertions or expected values".to_string(),
            "do not remove existing keywords from the list".to_string(),
        ],
        validation_recipe: vec!["go test ./internal/evolution/... -v -count=1".to_string()],
        evidence_summary: "validated via 3 successful sandbox trials on 2026-07-30".to_string(),
    };
    let bytes = serde_json::to_vec(&content).unwrap();
    let content_hash = blake3::hash(&bytes).to_hex().to_string();

    // Write artifact to the service's artifact directory
    let artifacts_dir = service.data_dir().join("artifacts");
    let staging = service.data_dir().join("seed-experience.tmp");
    std::fs::write(&staging, &bytes).unwrap();
    atomic_publish(&staging, &artifacts_dir, &content_hash).unwrap();

    // Publish as Active (already promoted)
    let now = now_epoch();
    let experience_id = "hermesx-reuse-test-exp";
    service
        .store()
        .append_and_project(
            "seed-run",
            &EvolutionEvent::RevisionPublished {
                run_id: "seed-run".to_string(),
                revision: ExperienceRevision {
                    experience_id: experience_id.to_string(),
                    revision: 1,
                    schema_version: CURRENT_SCHEMA_VERSION,
                    parent_id: None,
                    state: ExperienceState::Active,
                    confidence: 0.8,
                    success_count: 3,
                    failure_count: 0,
                    scope: ScopeFingerprint {
                        repo: Some("Colin4k1024/hermesx".to_string()),
                        task_type: Some("bug_fix".to_string()),
                        signal_types: vec![SignalType::TestFailure],
                        env_fingerprint: Some("go1.25.12-darwin-arm64".to_string()),
                    },
                    content_hash: content_hash.clone(),
                    created_at: now,
                    updated_at: now,
                },
            },
            None,
            Some("seed-publish"),
        )
        .unwrap();

    // --- Step 2: Verify injection is BLOCKED without rollout approval ---
    let context = hermesx_context();

    // In Shadow mode, injection is not allowed
    let shadow_result = service.experience_injection(&context).unwrap();
    assert!(
        shadow_result.is_none(),
        "Shadow mode should not allow experience injection"
    );

    // --- Step 3: Approve rollout ---
    let readiness = RolloutReadiness {
        source_pollution_events: 0,
        sandbox_complete: true,
        evidence_complete: true,
        unexplained_network_or_writes: 0,
        safety_drills_passed: true,
        replay_regressions: 0,
        metrics_baseline_established: true,
    };
    let evidence = RolloutEvidence {
        shadow_metrics_hash: "a".repeat(64),
        sandbox_report_hash: "b".repeat(64),
        evidence_completeness_hash: "c".repeat(64),
        safety_drill_report_hash: "d".repeat(64),
        replay_report_hash: "e".repeat(64),
    };
    let approval = service
        .approve_rollout(readiness, evidence, "test-operator@hermesx".to_string())
        .expect("rollout approval should succeed");
    assert!(!approval.approval_id.is_empty());

    // Verify status shows approval
    let status = service.status().unwrap();
    assert!(status.rollout_approved, "rollout should be approved");
    assert_eq!(status.active_experiences, 1);

    // --- Step 4: Reopen service in ReuseEligible mode for injection ---
    service.shutdown();
    drop(service);

    // Reopen with ReuseEligible - this works because we're not using autonomous ports
    let service = EvolutionService::open_at(
        workspace.path(),
        memory.path(),
        EvolutionConfig {
            mode: EvolutionMode::ReuseEligible,
            ..EvolutionConfig::default()
        },
    )
    .expect("reopen service in reuse mode");

    // --- Step 5: Test injection succeeds ---
    let injection = service
        .experience_injection(&context)
        .expect("injection query should not error");
    assert!(
        injection.is_some(),
        "Active experience should be injected in ReuseEligible mode with rollout approval"
    );

    let inj = injection.unwrap();
    assert_eq!(inj.experience_id, experience_id);
    assert!(inj.prompt.contains("do not modify test assertions"));
    assert!(inj.prompt.contains("check DetectTaskClass keyword list"));
    assert!(inj.prompt.contains("go test ./internal/evolution"));

    // --- Step 6: Record successful reuse observation (Helped) ---
    let state_after_helped = service
        .record_reuse(
            experience_id,
            "reuse-run-1",
            ReuseOutcome::Helped,
            inj.context_hash.clone(),
        )
        .unwrap();
    assert_eq!(
        state_after_helped,
        ExperienceState::Active,
        "single success should keep experience Active"
    );

    // Verify observation was recorded
    let status_after = service.status().unwrap();
    assert_eq!(status_after.active_experiences, 1);

    // --- Step 7: Verify experience still injectable after success ---
    let second_injection = service.experience_injection(&context).unwrap();
    assert!(
        second_injection.is_some(),
        "experience should still be injectable after Helped observation"
    );

    // --- Step 8: Record failures and verify quarantine ---
    service
        .record_reuse(
            experience_id,
            "reuse-run-fail-1",
            ReuseOutcome::Hindered,
            content_hash.clone(),
        )
        .unwrap();
    let state_after_2_failures = service
        .record_reuse(
            experience_id,
            "reuse-run-fail-2",
            ReuseOutcome::Hindered,
            content_hash.clone(),
        )
        .unwrap();
    assert_eq!(
        state_after_2_failures,
        ExperienceState::Quarantined,
        "2 consecutive failures should quarantine"
    );

    // --- Step 9: Verify injection is blocked after quarantine ---
    let blocked = service.experience_injection(&context).unwrap();
    assert!(
        blocked.is_none(),
        "quarantined experience must not be injected"
    );

    // --- Step 10: Final status check ---
    let final_status = service.status().unwrap();
    assert_eq!(final_status.quarantined_experiences, 1);
    assert_eq!(final_status.active_experiences, 0);

    service.shutdown();
}

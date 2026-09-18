//! Persistent lifecycle E2E: Candidate → Active → injection → Quarantined.
//!
//! Run with: cargo run -p xai-grok-evolution --example e2e_pipeline

use std::process::Command;

use xai_grok_evolution::events::EvolutionEvent;
use xai_grok_evolution::reuse::{self, ExperienceContent};
use xai_grok_evolution::select::{self, SelectionContext};
use xai_grok_evolution::solidify::artifact::atomic_publish;
use xai_grok_evolution::trial::source_tree_hash;
use xai_grok_evolution::{
    EvolutionStore, ExperienceRevision, ExperienceState, ReuseObservation, ReuseOutcome,
    ScopeFingerprint, SignalType, CURRENT_SCHEMA_VERSION,
};

fn main() {
    let workspace = tempfile::tempdir().expect("workspace");
    initialize_git_repository(workspace.path());
    let source_hash_before = source_tree_hash(workspace.path()).expect("hash source tree");

    let data = tempfile::tempdir().expect("data directory");
    let store = EvolutionStore::open(&data.path().join("evolution.sqlite")).expect("store");
    let artifacts = data.path().join("artifacts");
    let staging = data.path().join("experience.tmp");
    let content = ExperienceContent {
        preconditions: vec!["a Rust validation command fails".to_string()],
        recommended_steps: vec!["apply the smallest validated correction".to_string()],
        forbidden_actions: vec!["do not delete tests".to_string()],
        validation_recipe: vec!["cargo test -p affected-crate".to_string()],
        evidence_summary: "isolated baseline/candidate comparison passed".to_string(),
    };
    let bytes = serde_json::to_vec(&content).expect("serialize experience");
    let content_hash = blake3::hash(&bytes).to_hex().to_string();
    std::fs::write(&staging, bytes).expect("stage experience");
    atomic_publish(&staging, &artifacts, &content_hash).expect("publish experience");

    let now = now_epoch();
    let experience_id = "e2e-experience";
    store
        .append_and_project(
            "publish",
            &EvolutionEvent::RevisionPublished {
                run_id: "publish".to_string(),
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
                        repo: Some("e2e/repo".to_string()),
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
            Some("publish"),
        )
        .expect("publish projection");

    for index in 0..3 {
        let state = store
            .record_reuse_with_policy(
                &observation(
                    experience_id,
                    &format!("promotion-{index}"),
                    ReuseOutcome::Helped,
                    &content_hash,
                    now + index,
                ),
                3,
                2,
            )
            .expect("record successful reuse");
        println!("successful reuse {} -> {state:?}", index + 1);
    }

    let active = store
        .get_experience(experience_id)
        .expect("query experience")
        .expect("experience projection");
    assert_eq!(active.state, ExperienceState::Active);
    let context = SelectionContext {
        repo: Some("e2e/repo".to_string()),
        task_type: Some("bug_fix".to_string()),
        signal_types: vec![SignalType::TestFailure],
        env_fingerprint: None,
        now: now + 10,
    };
    let selected = select::select(&[active.clone()], &context)
        .expect("select")
        .main
        .expect("active experience selected");
    let prompt = reuse::load_context_from_artifact(&selected, &artifacts)
        .and_then(|value| reuse::safe_inject(&value))
        .expect("verified immutable experience injection");
    assert!(prompt.contains("do not delete tests"));
    println!("injected immutable experience {}", selected.experience_id);

    for index in 0..2 {
        let state = store
            .record_reuse_with_policy(
                &observation(
                    experience_id,
                    &format!("failure-{index}"),
                    ReuseOutcome::Hindered,
                    &content_hash,
                    now + 20 + index,
                ),
                3,
                2,
            )
            .expect("record failed reuse");
        println!("failed reuse {} -> {state:?}", index + 1);
    }

    let quarantined = store
        .get_experience(experience_id)
        .expect("query quarantined experience")
        .expect("experience projection");
    assert_eq!(quarantined.state, ExperienceState::Quarantined);
    assert!(
        select::select(&[quarantined], &context)
            .expect("select after quarantine")
            .main
            .is_none()
    );
    assert_eq!(
        source_tree_hash(workspace.path()).expect("rehash source tree"),
        source_hash_before
    );
    println!("lifecycle E2E passed; source repository remained unchanged");
}

fn observation(
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

fn initialize_git_repository(path: &std::path::Path) {
    std::fs::write(path.join("lib.rs"), "pub fn value() -> u8 { 1 }\n").expect("source file");
    run_git(path, &["init", "-q"]);
    run_git(path, &["config", "user.email", "evolution-e2e@example.invalid"]);
    run_git(path, &["config", "user.name", "Evolution E2E"]);
    run_git(path, &["add", "lib.rs"]);
    run_git(path, &["commit", "-qm", "baseline"]);
}

fn run_git(path: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git command failed: {args:?}");
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

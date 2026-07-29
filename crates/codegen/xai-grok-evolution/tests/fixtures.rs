//! Fixture deserialization tests.
//!
//! P0 completion gate: all JSON fixtures must roundtrip through serde.
//! This ensures the schema is stable and all types are correctly annotated.

use xai_grok_evolution::*;

fn load_fixture(name: &str) -> String {
    let path = format!("fixtures/{}", name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("Failed to load {}: {}", path, e))
}

fn roundtrip<T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug>(json_str: &str) -> T {
    let value: T = serde_json::from_str(json_str).expect("deserialization failed");
    let serialized = serde_json::to_string(&value).expect("serialization failed");
    let roundtripped: T = serde_json::from_str(&serialized).expect("roundtrip deserialization failed");
    roundtripped
}

#[test]
fn fixture_evolution_run() {
    let v: EvolutionRun = roundtrip(&load_fixture("evolution_run.json"));
    assert_eq!(v.run_id, "run-001");
    assert_eq!(v.schema_version, 1);
    assert_eq!(v.state, RunState::Running);
    assert_eq!(v.trigger.trigger_type, TriggerType::TestFailure);
}

#[test]
fn fixture_evolution_signal() {
    let v: EvolutionSignal = roundtrip(&load_fixture("evolution_signal.json"));
    assert_eq!(v.signal_id, "sig-001");
    assert_eq!(v.signal_type, SignalType::TestFailure);
    assert_eq!(v.severity, SignalSeverity::High);
}

#[test]
fn fixture_experience_candidate() {
    let v: ExperienceCandidate = roundtrip(&load_fixture("experience_candidate.json"));
    assert_eq!(v.candidate_id, "cand-001");
    assert_eq!(v.proposal.target, "xai-grok-tools/src/config/parser.rs");
    assert_eq!(v.proposal.validation_command, vec!["cargo", "test", "-p", "xai-grok-tools", "--", "test_parse_config"]);
}

#[test]
fn fixture_experience_revision() {
    let v: ExperienceRevision = roundtrip(&load_fixture("experience_revision.json"));
    assert_eq!(v.experience_id, "exp-001");
    assert_eq!(v.state, ExperienceState::Candidate);
    assert_eq!(v.confidence, 0.0);
    assert_eq!(v.revision, 1);
}

#[test]
fn fixture_contraindication() {
    let v: Contraindication = roundtrip(&load_fixture("contraindication.json"));
    assert_eq!(v.contraindication_id, "contra-001");
    assert_eq!(v.evidence_ref.ref_type, EvidenceRefType::TestOutput);
    assert_eq!(v.ttl_secs, 2592000);
}

#[test]
fn fixture_trial_spec() {
    let v: TrialSpec = roundtrip(&load_fixture("trial_spec.json"));
    assert_eq!(v.spec_id, "spec-001");
    assert_eq!(v.max_variant_rounds, 3);
    assert_eq!(v.budget.max_files_changed, 5);
}

#[test]
fn fixture_trial_outcome() {
    let v: TrialOutcome = roundtrip(&load_fixture("trial_outcome.json"));
    assert_eq!(v.outcome_id, "outcome-001");
    assert_eq!(v.result, TrialResult::Success);
    assert_eq!(v.files_changed.len(), 1);
    assert!(v.validation_results[0].passed);
}

#[test]
fn fixture_evidence_bundle() {
    let v: EvidenceBundle = roundtrip(&load_fixture("evidence_bundle.json"));
    assert_eq!(v.bundle_id, "bundle-001");
    assert!(v.scrubbed);
    assert_eq!(v.refs.len(), 2);
}

#[test]
fn fixture_reuse_observation() {
    let v: ReuseObservation = roundtrip(&load_fixture("reuse_observation.json"));
    assert_eq!(v.observation_id, "obs-001");
    assert_eq!(v.outcome, ReuseOutcome::Helped);
}

// --- Event fixtures ---

#[test]
fn fixture_event_run_started() {
    let v: EvolutionEvent = roundtrip(&load_fixture("event_run_started.json"));
    match v {
        EvolutionEvent::RunStarted { run_id, trigger, .. } => {
            assert_eq!(run_id, "run-001");
            assert_eq!(trigger.trigger_type, TriggerType::TestFailure);
        }
        other => panic!("expected RunStarted, got {:?}", other),
    }
}

#[test]
fn fixture_event_signals_detected() {
    let v: EvolutionEvent = roundtrip(&load_fixture("event_signals_detected.json"));
    match v {
        EvolutionEvent::SignalsDetected { run_id, signals } => {
            assert_eq!(run_id, "run-001");
            assert_eq!(signals.len(), 1);
        }
        other => panic!("expected SignalsDetected, got {:?}", other),
    }
}

#[test]
fn fixture_event_adoption_decided() {
    let v: EvolutionEvent = roundtrip(&load_fixture("event_adoption_decided.json"));
    match v {
        EvolutionEvent::AdoptionDecided { decision, .. } => {
            assert_eq!(decision, AdoptionDecision::PublishCandidate);
        }
        other => panic!("expected AdoptionDecided, got {:?}", other),
    }
}

#[test]
fn fixture_event_quarantined() {
    let v: EvolutionEvent = roundtrip(&load_fixture("event_quarantined.json"));
    match v {
        EvolutionEvent::Quarantined { experience_id, reason, .. } => {
            assert_eq!(experience_id, "exp-001");
            assert_eq!(reason.reason_type, QuarantineReasonType::ConsecutiveFailures);
        }
        other => panic!("expected Quarantined, got {:?}", other),
    }
}

#[test]
fn fixture_event_confidence_transitioned() {
    let v: EvolutionEvent = roundtrip(&load_fixture("event_confidence_transitioned.json"));
    match v {
        EvolutionEvent::ConfidenceTransitioned { experience_id, from, to, .. } => {
            assert_eq!(experience_id, "exp-001");
            match from {
                ConfidenceState::Candidate { successes, failures } => {
                    assert_eq!(successes, 3);
                    assert_eq!(failures, 0);
                }
                other => panic!("expected Candidate confidence, got {:?}", other),
            }
            match to {
                ConfidenceState::Active { confidence } => {
                    assert!((confidence - 0.85).abs() < f64::EPSILON);
                }
                other => panic!("expected Active confidence, got {:?}", other),
            }
        }
        other => panic!("expected ConfidenceTransitioned, got {:?}", other),
    }
}

// --- Schema upcaster tests ---

#[test]
fn schema_version_is_current() {
    assert_eq!(xai_grok_evolution::SCHEMA_VERSION, 1);
}

// --- State machine fixture tests ---

#[test]
fn all_experience_states_deserialize() {
    let states = vec![
        r#""candidate""#,
        r#""active""#,
        r#""decaying""#,
        r#""revalidating""#,
        r#""quarantined""#,
        r#""revoked""#,
    ];
    for json in states {
        let state: ExperienceState = serde_json::from_str(json).unwrap();
        let back = serde_json::to_string(&state).unwrap();
        assert_eq!(json, back.as_str(), "roundtrip failed for {}", json);
    }
}

#[test]
fn all_run_states_deserialize() {
    let states = vec![
        r#""running""#,
        r#""completed""#,
        r#""failed""#,
        r#""abandoned""#,
    ];
    for json in states {
        let state: RunState = serde_json::from_str(json).unwrap();
        let back = serde_json::to_string(&state).unwrap();
        assert_eq!(json, back.as_str(), "roundtrip failed for {}", json);
    }
}

#[test]
fn all_adoption_decisions_deserialize() {
    let decisions = vec![
        r#""reject""#,
        r#""quarantine""#,
        r#""publish_candidate""#,
        r#""eligible_for_reuse""#,
    ];
    for json in decisions {
        let decision: AdoptionDecision = serde_json::from_str(json).unwrap();
        let back = serde_json::to_string(&decision).unwrap();
        assert_eq!(json, back.as_str(), "roundtrip failed for {}", json);
    }
}

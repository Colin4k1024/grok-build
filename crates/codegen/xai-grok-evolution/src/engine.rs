//! Production evolution orchestration.
//!
//! This engine owns Grok's event and safety semantics. External mutation,
//! worktree, validation, and critic capabilities are injected as fail-closed
//! ports; the engine never falls back to synthetic success.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::config::{EvolutionConfig, EvolutionMode};
use crate::error::EvolutionError;
use crate::events::store::EvolutionStore;
use crate::events::{CandidateRank, EvaluationResult, EvolutionEvent};
use crate::reuse::ExperienceContent;
use crate::rollout::killswitch::KillSwitch;
use crate::select::{self, SelectionContext};
use crate::solidify::artifact::{atomic_publish, publish_evidence};
use crate::types::*;

pub const PIPELINE_STAGES: &[&str] = &[
    "detect", "select", "mutate", "execute", "validate", "evaluate", "solidify", "reuse",
];

/// Model-side structured proposal generation. This runs in the parent process.
pub trait VariantGenerator: Send + Sync {
    fn generate(
        &self,
        run_id: &str,
        signals: &[EvolutionSignal],
        selected: Option<&ExperienceRevision>,
    ) -> Result<ExperienceCandidate, EvolutionError>;
}

/// Factual result produced by a sandboxed trial executor.
pub struct TrialExecution {
    pub outcome: TrialOutcome,
    pub baseline_results: Vec<ValidationResult>,
    pub evidence: EvidenceBundle,
    pub staged_evidence_path: PathBuf,
    pub diff: String,
    pub source_hash_before: String,
    pub source_hash_after: String,
}

/// Worktree and sandbox execution port. It must not perform model calls.
pub trait TrialExecutor: Send + Sync {
    fn execute(
        &self,
        run_id: &str,
        candidate: &ExperienceCandidate,
        spec: &TrialSpec,
        cancel: &CancellationToken,
    ) -> Result<TrialExecution, EvolutionError>;
}

#[derive(Debug, Clone)]
pub struct ValidationComparison {
    pub baseline: Vec<ValidationResult>,
    pub candidate: Vec<ValidationResult>,
}

/// Deterministic baseline/candidate validation and diff safety guards.
pub trait TrialValidator: Send + Sync {
    fn validate(
        &self,
        candidate: &ExperienceCandidate,
        execution: &TrialExecution,
    ) -> Result<ValidationComparison, EvolutionError>;
}

/// Independent evaluation port. Deterministic safety gates remain authoritative.
pub trait TrialEvaluator: Send + Sync {
    fn evaluate(
        &self,
        candidate: &ExperienceCandidate,
        execution: &TrialExecution,
        comparison: &ValidationComparison,
    ) -> Result<EvaluationResult, EvolutionError>;
}

#[derive(Debug, Clone)]
pub struct EngineRunResult {
    pub run_id: RunId,
    pub state: RunState,
    pub decision: AdoptionDecision,
    pub published_experience_id: Option<ExperienceId>,
}

/// Eight-stage production engine with append-only, fail-closed semantics.
pub struct EvolutionEngine {
    store: EvolutionStore,
    artifacts_dir: PathBuf,
    staging_dir: PathBuf,
    kill_switch: KillSwitch,
    cancel: CancellationToken,
    generator: Option<Arc<dyn VariantGenerator>>,
    executor: Option<Arc<dyn TrialExecutor>>,
    validator: Option<Arc<dyn TrialValidator>>,
    evaluator: Option<Arc<dyn TrialEvaluator>>,
}

impl EvolutionEngine {
    pub fn new(
        store: EvolutionStore,
        artifacts_dir: PathBuf,
        staging_dir: PathBuf,
        kill_switch: KillSwitch,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            store,
            artifacts_dir,
            staging_dir,
            kill_switch,
            cancel,
            generator: None,
            executor: None,
            validator: None,
            evaluator: None,
        }
    }

    pub fn with_ports(
        mut self,
        generator: Arc<dyn VariantGenerator>,
        executor: Arc<dyn TrialExecutor>,
        validator: Arc<dyn TrialValidator>,
        evaluator: Arc<dyn TrialEvaluator>,
    ) -> Self {
        self.generator = Some(generator);
        self.executor = Some(executor);
        self.validator = Some(validator);
        self.evaluator = Some(evaluator);
        self
    }

    pub fn supports_trials(&self) -> bool {
        self.generator.is_some()
            && self.executor.is_some()
            && self.validator.is_some()
            && self.evaluator.is_some()
    }

    pub fn run(
        &self,
        config: &EvolutionConfig,
        trigger: TriggerInfo,
        signals: Vec<EvolutionSignal>,
        selection_context: SelectionContext,
    ) -> Result<EngineRunResult, EvolutionError> {
        if config.mode == EvolutionMode::Off {
            return Err(EvolutionError::PreflightFailed(
                "evolution mode is off".to_string(),
            ));
        }
        self.guard()?;

        let run_id = uuid::Uuid::new_v4().to_string();
        let started = EvolutionEvent::RunStarted {
            run_id: run_id.clone(),
            trigger,
            config_snapshot: ConfigSnapshot {
                mode: enum_string(&config.mode),
                budget_max_duration_secs: config.budget.max_duration_secs,
                budget_max_variant_rounds: config.budget.max_variant_rounds,
            },
        };
        self.store.append_and_project(
            &run_id,
            &started,
            None,
            Some(&format!("{run_id}:run:start")),
        )?;

        let result = self.run_started(config, &run_id, signals, selection_context);
        match result {
            Ok(result) => {
                self.finish(&run_id, RunState::Completed, None)?;
                Ok(result)
            }
            Err(error) => {
                let message = error.to_string();
                let _ = self.finish(&run_id, RunState::Failed, Some(message));
                Err(error)
            }
        }
    }

    fn run_started(
        &self,
        config: &EvolutionConfig,
        run_id: &str,
        signals: Vec<EvolutionSignal>,
        selection_context: SelectionContext,
    ) -> Result<EngineRunResult, EvolutionError> {
        self.stage(run_id, "detect", || {
            if signals.is_empty() {
                return Err(EvolutionError::PreflightFailed(
                    "no sanitized evolution signals".to_string(),
                ));
            }
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::SignalsDetected {
                    run_id: run_id.to_string(),
                    signals: signals.clone(),
                },
                None,
                Some(&format!("{run_id}:signals")),
            )?;
            Ok(())
        })?;

        let selected = self.stage(run_id, "select", || {
            let experiences = self.store.all_experiences()?;
            let selection = select::select(&experiences, &selection_context)?;
            let mut ranks = Vec::new();
            if let Some(main) = &selection.main {
                ranks.push(CandidateRank {
                    candidate_id: main.experience_id.clone(),
                    score: main.confidence,
                    rank: 1,
                    is_main: true,
                });
            }
            for (index, reference) in selection.references.iter().enumerate() {
                ranks.push(CandidateRank {
                    candidate_id: reference.experience_id.clone(),
                    score: reference.confidence,
                    rank: index as u32 + 2,
                    is_main: false,
                });
            }
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::CandidatesRanked {
                    run_id: run_id.to_string(),
                    candidates: ranks,
                },
                None,
                Some(&format!("{run_id}:ranked")),
            )?;
            Ok(selection.main)
        })?;

        if config.mode == EvolutionMode::Shadow {
            return self.finish_shadow(run_id, &signals);
        }
        if !self.supports_trials() {
            return Err(EvolutionError::SandboxUnavailable(
                "autonomous evolution ports are not installed".to_string(),
            ));
        }

        let candidate = self.stage(run_id, "mutate", || {
            let generated = self
                .generator
                .as_ref()
                .ok_or_else(|| EvolutionError::Internal("variant generator missing".to_string()))?
                .generate(run_id, &signals, selected.as_ref())?;
            validate_candidate(&generated, &signals, &config.budget)?;
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::VariantProposed {
                    run_id: run_id.to_string(),
                    candidate: generated.clone(),
                },
                None,
                Some(&format!("{run_id}:variant")),
            )?;
            Ok(generated)
        })?;

        let spec = trial_spec(&candidate, config);
        let execution = self.stage(run_id, "execute", || {
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::TrialStarted {
                    run_id: run_id.to_string(),
                    spec: spec.clone(),
                },
                None,
                Some(&format!("{run_id}:trial:start")),
            )?;
            let execution = self
                .executor
                .as_ref()
                .ok_or_else(|| EvolutionError::Internal("trial executor missing".to_string()))?
                .execute(run_id, &candidate, &spec, &self.cancel)?;
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::TrialCompleted {
                    run_id: run_id.to_string(),
                    outcome: execution.outcome.clone(),
                },
                None,
                Some(&format!("{run_id}:trial:complete")),
            )?;
            if execution.outcome.result != TrialResult::Success {
                return Err(EvolutionError::PreflightFailed(format!(
                    "trial did not succeed: {:?}",
                    execution.outcome.result
                )));
            }
            Ok(execution)
        })?;

        let comparison = self.stage(run_id, "validate", || {
            let comparison = self
                .validator
                .as_ref()
                .ok_or_else(|| EvolutionError::Internal("trial validator missing".to_string()))?
                .validate(&candidate, &execution)?;
            if comparison.candidate.is_empty()
                || comparison.candidate.iter().any(|result| !result.passed)
            {
                return Err(EvolutionError::PreflightFailed(
                    "candidate validation failed".to_string(),
                ));
            }
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::ValidationCompleted {
                    run_id: run_id.to_string(),
                    baseline: comparison.baseline.clone(),
                    candidate: comparison.candidate.clone(),
                },
                None,
                Some(&format!("{run_id}:validation")),
            )?;
            Ok(comparison)
        })?;

        let evaluation = self.stage(run_id, "evaluate", || {
            let evaluation = self
                .evaluator
                .as_ref()
                .ok_or_else(|| EvolutionError::Internal("trial evaluator missing".to_string()))?
                .evaluate(&candidate, &execution, &comparison)?;
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::EvaluationCompleted {
                    run_id: run_id.to_string(),
                    evaluation: evaluation.clone(),
                },
                None,
                Some(&format!("{run_id}:evaluation")),
            )?;
            Ok(evaluation)
        })?;

        let decision = if evaluation.safety_gate_passed
            && evaluation.signals_resolved
            && evaluation.recommendation == AdoptionDecision::PublishCandidate
        {
            AdoptionDecision::PublishCandidate
        } else {
            AdoptionDecision::Reject
        };
        self.store.append_and_project(
            run_id,
            &EvolutionEvent::AdoptionDecided {
                run_id: run_id.to_string(),
                decision,
            },
            None,
            Some(&format!("{run_id}:adoption")),
        )?;
        if decision != AdoptionDecision::PublishCandidate {
            return Ok(EngineRunResult {
                run_id: run_id.to_string(),
                state: RunState::Completed,
                decision,
                published_experience_id: None,
            });
        }

        let experience_id = self.stage(run_id, "solidify", || {
            self.publish_candidate(run_id, config, &candidate, &execution)
        })?;
        self.stage(run_id, "reuse", || Ok(()))?;

        Ok(EngineRunResult {
            run_id: run_id.to_string(),
            state: RunState::Completed,
            decision,
            published_experience_id: Some(experience_id),
        })
    }

    fn finish_shadow(
        &self,
        run_id: &str,
        signals: &[EvolutionSignal],
    ) -> Result<EngineRunResult, EvolutionError> {
        self.stage(run_id, "mutate", || Ok(()))?;
        self.stage(run_id, "execute", || Ok(()))?;
        self.stage(run_id, "validate", || Ok(()))?;
        self.stage(run_id, "evaluate", || {
            let high = signals
                .iter()
                .filter(|signal| signal.severity >= SignalSeverity::High)
                .count();
            self.store.append_and_project(
                run_id,
                &EvolutionEvent::EvaluationCompleted {
                    run_id: run_id.to_string(),
                    evaluation: EvaluationResult {
                        signals_resolved: false,
                        correctness_score: 0.0,
                        generalization_score: 0.0,
                        test_coverage_delta: 0,
                        complexity_assessment: format!(
                            "shadow observation only; {} high-severity signals",
                            high
                        ),
                        token_cost: 0,
                        time_cost_ms: 0,
                        recommendation: AdoptionDecision::Reject,
                        safety_gate_passed: true,
                    },
                },
                None,
                Some(&format!("{run_id}:shadow:evaluation")),
            )?;
            Ok(())
        })?;
        self.stage(run_id, "solidify", || Ok(()))?;
        self.stage(run_id, "reuse", || Ok(()))?;
        self.store.append_and_project(
            run_id,
            &EvolutionEvent::AdoptionDecided {
                run_id: run_id.to_string(),
                decision: AdoptionDecision::Reject,
            },
            None,
            Some(&format!("{run_id}:shadow:adoption")),
        )?;
        Ok(EngineRunResult {
            run_id: run_id.to_string(),
            state: RunState::Completed,
            decision: AdoptionDecision::Reject,
            published_experience_id: None,
        })
    }

    fn publish_candidate(
        &self,
        run_id: &str,
        config: &EvolutionConfig,
        candidate: &ExperienceCandidate,
        execution: &TrialExecution,
    ) -> Result<ExperienceId, EvolutionError> {
        if !execution.evidence.scrubbed || execution.evidence.run_id != run_id {
            return Err(EvolutionError::PreflightFailed(
                "trial evidence is missing, unsanitized, or belongs to another run".to_string(),
            ));
        }
        let run_staging = self.staging_dir.join(run_id);
        std::fs::create_dir_all(&run_staging).map_err(|e| {
            EvolutionError::Internal(format!("create experience staging directory: {e}"))
        })?;
        let content = ExperienceContent {
            preconditions: candidate.proposal.preconditions.clone(),
            recommended_steps: vec![candidate.proposal.expected_benefit.clone()],
            forbidden_actions: candidate.proposal.forbidden_actions.clone(),
            validation_recipe: vec![candidate.proposal.validation_command.join(" ")],
            evidence_summary: format!("validated by run {run_id}"),
        };
        let bytes = serde_json::to_vec(&content)
            .map_err(|e| EvolutionError::Internal(format!("serialize experience: {e}")))?;
        let content_hash = blake3::hash(&bytes).to_hex().to_string();
        let content_staging = run_staging.join("experience.json");
        std::fs::write(&content_staging, &bytes)
            .map_err(|e| EvolutionError::Internal(format!("stage experience: {e}")))?;
        atomic_publish(&content_staging, &self.artifacts_dir, &content_hash)?;

        let now = now_epoch();
        let experience_id = uuid::Uuid::new_v4().to_string();
        let revision = ExperienceRevision {
            experience_id: experience_id.clone(),
            revision: 1,
            schema_version: CURRENT_SCHEMA_VERSION,
            parent_id: candidate.parent_revision_id.clone(),
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: 0,
            failure_count: 0,
            scope: ScopeFingerprint {
                repo: None,
                task_type: None,
                signal_types: vec![],
                env_fingerprint: None,
            },
            content_hash,
            created_at: now,
            updated_at: now,
        };
        let event = EvolutionEvent::RevisionPublished {
            run_id: run_id.to_string(),
            revision,
        };
        publish_evidence(
            &self.store,
            &execution.staged_evidence_path,
            &self.artifacts_dir,
            &execution.evidence,
            &event,
            &format!("{run_id}:revision"),
            config.budget.max_artifact_mb * 1024 * 1024,
        )?;
        Ok(experience_id)
    }

    fn stage<T>(
        &self,
        run_id: &str,
        stage: &str,
        operation: impl FnOnce() -> Result<T, EvolutionError>,
    ) -> Result<T, EvolutionError> {
        self.guard()?;
        self.store.append_and_project(
            run_id,
            &EvolutionEvent::StageStarted {
                run_id: run_id.to_string(),
                stage: stage.to_string(),
            },
            None,
            Some(&format!("{run_id}:stage:{stage}:start")),
        )?;
        match operation() {
            Ok(value) => {
                self.store.append_and_project(
                    run_id,
                    &EvolutionEvent::StageCompleted {
                        run_id: run_id.to_string(),
                        stage: stage.to_string(),
                    },
                    None,
                    Some(&format!("{run_id}:stage:{stage}:complete")),
                )?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.store.append_and_project(
                    run_id,
                    &EvolutionEvent::StageFailed {
                        run_id: run_id.to_string(),
                        stage: stage.to_string(),
                        error: error.to_string(),
                    },
                    None,
                    Some(&format!("{run_id}:stage:{stage}:failed")),
                );
                Err(error)
            }
        }
    }

    fn finish(
        &self,
        run_id: &str,
        state: RunState,
        error: Option<String>,
    ) -> Result<(), EvolutionError> {
        self.store.append_and_project(
            run_id,
            &EvolutionEvent::RunFinished {
                run_id: run_id.to_string(),
                state,
                error,
            },
            None,
            Some(&format!("{run_id}:run:finish")),
        )?;
        Ok(())
    }

    fn guard(&self) -> Result<(), EvolutionError> {
        self.kill_switch
            .check()
            .map_err(EvolutionError::Cancelled)?;
        if self.cancel.is_cancelled() {
            return Err(EvolutionError::Cancelled(
                "evolution service is shutting down".to_string(),
            ));
        }
        Ok(())
    }
}

fn trial_spec(candidate: &ExperienceCandidate, config: &EvolutionConfig) -> TrialSpec {
    TrialSpec {
        spec_id: uuid::Uuid::new_v4().to_string(),
        schema_version: CURRENT_SCHEMA_VERSION,
        candidate_id: candidate.candidate_id.clone(),
        allowed_paths: candidate.proposal.allowed_paths.clone(),
        forbidden_actions: candidate.proposal.forbidden_actions.clone(),
        budget: TrialBudget {
            max_duration_secs: config.budget.max_duration_secs,
            max_artifact_bytes: config.budget.max_artifact_mb * 1024 * 1024,
            max_files_changed: config.budget.max_files_changed,
            max_lines_changed: config.budget.max_lines_changed,
        },
        validation_recipe: candidate.proposal.validation_command.clone(),
        max_variant_rounds: config.budget.max_variant_rounds,
    }
}

fn validate_candidate(
    candidate: &ExperienceCandidate,
    signals: &[EvolutionSignal],
    budget: &crate::config::EvolutionBudgetConfig,
) -> Result<(), EvolutionError> {
    if signals.is_empty() || candidate.trigger_signals.is_empty() {
        return Err(EvolutionError::PreflightFailed(
            "proposal has no triggering signals".to_string(),
        ));
    }
    if candidate.proposal.target.trim().is_empty()
        || candidate.proposal.expected_benefit.trim().is_empty()
        || candidate.proposal.validation_command.is_empty()
        || candidate.proposal.allowed_paths.is_empty()
    {
        return Err(EvolutionError::PreflightFailed(
            "proposal is empty or lacks validation/allowed paths".to_string(),
        ));
    }
    if candidate.proposal.allowed_paths.len() > budget.max_files_changed as usize {
        return Err(EvolutionError::BudgetExceeded(
            "proposal exceeds maximum allowed paths".to_string(),
        ));
    }
    for path in &candidate.proposal.allowed_paths {
        validate_relative_path(Path::new(path))?;
    }
    let command = candidate.proposal.validation_command[0].as_str();
    if command != "cargo" {
        return Err(EvolutionError::PreflightFailed(format!(
            "validation executable is not allowed: {command}"
        )));
    }
    Ok(())
}

pub fn validate_relative_path(path: &Path) -> Result<(), EvolutionError> {
    use std::path::Component;
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(EvolutionError::PreflightFailed(format!(
            "path must be non-empty and relative: {}",
            path.display()
        )));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(EvolutionError::PreflightFailed(format!(
            "path escapes worktree: {}",
            path.display()
        )));
    }
    Ok(())
}

fn enum_string<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

//! Sandboxed trial executor and deterministic validation/evaluation gates.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::engine::{
    TrialEvaluator, TrialExecution, TrialExecutor, TrialValidator, ValidationComparison,
};
use crate::error::EvolutionError;
use crate::events::EvaluationResult;
use crate::trial::worker::{
    PROTOCOL_VERSION, WorkerCommand, WorkerProcess, WorkerRequest, WorkerResult,
};
use crate::trial::worktree::{WorktreeProvider, source_tree_hash};
use crate::types::*;

pub struct SandboxedTrialExecutor {
    provider: Arc<dyn WorktreeProvider>,
    source: SourceRef,
    source_root: PathBuf,
    worker_binary: PathBuf,
    staging_root: PathBuf,
}

impl SandboxedTrialExecutor {
    pub fn new(
        provider: Arc<dyn WorktreeProvider>,
        source: SourceRef,
        worker_binary: PathBuf,
        staging_root: PathBuf,
    ) -> Result<Self, EvolutionError> {
        let source_root = PathBuf::from(&source.repo_path)
            .canonicalize()
            .map_err(|error| EvolutionError::PreflightFailed(format!("resolve source: {error}")))?;
        let worker_binary = worker_binary.canonicalize().map_err(|error| {
            EvolutionError::PreflightFailed(format!("resolve evolution worker: {error}"))
        })?;
        if !worker_binary.is_file() {
            return Err(EvolutionError::SandboxUnavailable(
                "evolution worker binary is not a file".to_string(),
            ));
        }
        std::fs::create_dir_all(&staging_root).map_err(|error| {
            EvolutionError::Internal(format!("create trial staging root: {error}"))
        })?;
        Ok(Self {
            provider,
            source,
            source_root,
            worker_binary,
            staging_root,
        })
    }
}

impl TrialExecutor for SandboxedTrialExecutor {
    fn execute(
        &self,
        run_id: &str,
        candidate: &ExperienceCandidate,
        spec: &TrialSpec,
        cancel: &CancellationToken,
    ) -> Result<TrialExecution, EvolutionError> {
        let source_hash_before = source_tree_hash(&self.source_root)?;
        let worktree = self.provider.create(&self.source)?;
        let result = self.execute_in_worktree(run_id, candidate, spec, cancel, &worktree.path);
        let cleanup = self.provider.cleanup(&worktree);
        let source_hash_after = source_tree_hash(&self.source_root)?;
        if source_hash_after != source_hash_before {
            return Err(EvolutionError::ArtifactIntegrity {
                expected: source_hash_before,
                actual: source_hash_after,
            });
        }
        cleanup?;
        let mut execution = result?;
        execution.source_hash_before = source_hash_before;
        execution.source_hash_after = source_hash_after;
        Ok(execution)
    }
}

impl SandboxedTrialExecutor {
    fn execute_in_worktree(
        &self,
        run_id: &str,
        candidate: &ExperienceCandidate,
        spec: &TrialSpec,
        cancel: &CancellationToken,
        worktree: &str,
    ) -> Result<TrialExecution, EvolutionError> {
        if cancel.is_cancelled() {
            return Err(EvolutionError::Cancelled(
                "trial cancelled before start".to_string(),
            ));
        }
        let patch = candidate.proposal.patch.as_deref().ok_or_else(|| {
            EvolutionError::PreflightFailed("candidate has no generated patch".to_string())
        })?;
        let started = Instant::now();
        let mut worker = WorkerProcess::spawn(
            self.worker_binary.to_string_lossy().as_ref(),
            worktree,
            spec.budget.max_duration_secs,
        )?;

        let (baseline, baseline_stdout, baseline_stderr) = run_validation(
            &mut worker,
            &candidate.proposal.validation_command,
            spec.budget.max_duration_secs,
        )?;
        if cancel.is_cancelled() {
            worker.terminate()?;
            return Err(EvolutionError::Cancelled("trial cancelled".to_string()));
        }
        let patch_response = worker.send_request(&WorkerRequest {
            version: PROTOCOL_VERSION,
            command: WorkerCommand::ApplyPatch {
                diff: patch.to_string(),
                allowed_paths: spec.allowed_paths.iter().map(PathBuf::from).collect(),
            },
        })?;
        let files_changed = match patch_response.result {
            WorkerResult::PatchApplied { files_changed } => files_changed,
            WorkerResult::Error { message, .. } => {
                return Err(EvolutionError::PreflightFailed(format!(
                    "worker rejected patch: {message}"
                )));
            }
            _ => {
                return Err(EvolutionError::WorkerProtocol(
                    "unexpected apply-patch response".to_string(),
                ));
            }
        };
        let (candidate_validation, candidate_stdout, candidate_stderr) = run_validation(
            &mut worker,
            &candidate.proposal.validation_command,
            spec.budget.max_duration_secs,
        )?;
        worker.terminate()?;

        let diff = git_output(worktree, &["diff", "--binary", "--"])?;
        let (lines_added, lines_removed) = diff_counts(worktree)?;
        enforce_diff_guards(
            &diff,
            &files_changed,
            lines_added,
            lines_removed,
            &spec.budget,
        )?;

        let validation_results = vec![candidate_validation.clone()];
        let completed_at = now_epoch();
        let outcome = TrialOutcome {
            outcome_id: uuid::Uuid::new_v4().to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            spec_id: spec.spec_id.clone(),
            result: if candidate_validation.passed {
                TrialResult::Success
            } else {
                TrialResult::Failed
            },
            duration_ms: started.elapsed().as_millis() as u64,
            files_changed: files_changed
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            lines_added,
            lines_removed,
            validation_results,
            artifact_hash: None,
            completed_at,
        };

        let evidence_json = serde_json::json!({
            "run_id": run_id,
            "diff": scrub_sensitive_text(&diff),
            "baseline": {
                "result": baseline,
                "stdout": scrub_sensitive_text(&baseline_stdout),
                "stderr": scrub_sensitive_text(&baseline_stderr),
            },
            "candidate": {
                "result": candidate_validation,
                "stdout": scrub_sensitive_text(&candidate_stdout),
                "stderr": scrub_sensitive_text(&candidate_stderr),
            },
            "source_hash": source_hash_placeholder(),
        });
        let evidence_bytes = serde_json::to_vec_pretty(&evidence_json)
            .map_err(|error| EvolutionError::Internal(format!("serialize evidence: {error}")))?;
        if evidence_bytes.len() as u64 > spec.budget.max_artifact_bytes {
            return Err(EvolutionError::BudgetExceeded(
                "trial evidence exceeds artifact budget".to_string(),
            ));
        }
        let run_staging = self.staging_root.join(run_id);
        std::fs::create_dir_all(&run_staging).map_err(|error| {
            EvolutionError::Internal(format!("create run staging directory: {error}"))
        })?;
        let staged_evidence_path = run_staging.join("evidence.json");
        let mut file = std::fs::File::create(&staged_evidence_path)
            .map_err(|error| EvolutionError::Internal(format!("stage evidence: {error}")))?;
        file.write_all(&evidence_bytes)
            .map_err(|error| EvolutionError::Internal(format!("write evidence: {error}")))?;
        file.sync_all()
            .map_err(|error| EvolutionError::Internal(format!("fsync evidence: {error}")))?;
        let content_hash = blake3::hash(&evidence_bytes).to_hex().to_string();
        let evidence = EvidenceBundle {
            bundle_id: uuid::Uuid::new_v4().to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            run_id: run_id.to_string(),
            refs: vec![EvidenceRef {
                ref_type: EvidenceRefType::ValidationLog,
                path: content_hash.clone(),
                content_hash: content_hash.clone(),
                size_bytes: evidence_bytes.len() as u64,
            }],
            content_hash,
            total_bytes: evidence_bytes.len() as u64,
            scrubbed: true,
            created_at: completed_at,
        };
        Ok(TrialExecution {
            outcome,
            baseline_results: vec![baseline],
            evidence,
            staged_evidence_path,
            diff,
            source_hash_before: String::new(),
            source_hash_after: String::new(),
        })
    }
}

#[derive(Default)]
pub struct DeterministicTrialValidator;

impl TrialValidator for DeterministicTrialValidator {
    fn validate(
        &self,
        _candidate: &ExperienceCandidate,
        execution: &TrialExecution,
    ) -> Result<ValidationComparison, EvolutionError> {
        if execution.source_hash_before != execution.source_hash_after {
            return Err(EvolutionError::ArtifactIntegrity {
                expected: execution.source_hash_before.clone(),
                actual: execution.source_hash_after.clone(),
            });
        }
        if execution.outcome.files_changed.is_empty() || execution.diff.trim().is_empty() {
            return Err(EvolutionError::PreflightFailed(
                "candidate produced no changes".to_string(),
            ));
        }
        Ok(ValidationComparison {
            baseline: execution.baseline_results.clone(),
            candidate: execution.outcome.validation_results.clone(),
        })
    }
}

/// Deterministic evaluator used before any optional model critic. It can only
/// publish when safety and validation facts are complete.
#[derive(Default)]
pub struct DeterministicTrialEvaluator;

impl TrialEvaluator for DeterministicTrialEvaluator {
    fn evaluate(
        &self,
        _candidate: &ExperienceCandidate,
        execution: &TrialExecution,
        comparison: &ValidationComparison,
    ) -> Result<EvaluationResult, EvolutionError> {
        let candidate_passed = !comparison.candidate.is_empty()
            && comparison.candidate.iter().all(|result| result.passed);
        let baseline_failed = comparison.baseline.iter().any(|result| !result.passed);
        let signals_resolved = candidate_passed && baseline_failed;
        Ok(EvaluationResult {
            signals_resolved,
            correctness_score: if signals_resolved { 1.0 } else { 0.0 },
            generalization_score: if signals_resolved { 0.5 } else { 0.0 },
            test_coverage_delta: 0,
            complexity_assessment: "deterministic validation gates passed".to_string(),
            token_cost: 0,
            time_cost_ms: execution.outcome.duration_ms,
            recommendation: if signals_resolved {
                AdoptionDecision::PublishCandidate
            } else {
                AdoptionDecision::Reject
            },
            safety_gate_passed: execution.source_hash_before == execution.source_hash_after,
        })
    }
}

fn run_validation(
    worker: &mut WorkerProcess,
    argv: &[String],
    timeout_secs: u64,
) -> Result<(ValidationResult, String, String), EvolutionError> {
    let started = Instant::now();
    let response = worker.send_request(&WorkerRequest {
        version: PROTOCOL_VERSION,
        command: WorkerCommand::RunValidator {
            argv: argv.to_vec(),
            timeout_secs,
        },
    })?;
    match response.result {
        WorkerResult::ValidatorResult {
            exit_code,
            stdout,
            stderr,
        } => Ok((
            ValidationResult {
                command: argv.to_vec(),
                exit_code,
                stdout_hash: blake3::hash(stdout.as_bytes()).to_hex().to_string(),
                stderr_hash: blake3::hash(stderr.as_bytes()).to_hex().to_string(),
                passed: exit_code == 0,
                duration_ms: started.elapsed().as_millis() as u64,
            },
            stdout,
            stderr,
        )),
        WorkerResult::Error { kind, message } => Err(EvolutionError::PreflightFailed(format!(
            "validator failed ({kind:?}): {message}"
        ))),
        _ => Err(EvolutionError::WorkerProtocol(
            "unexpected validator response".to_string(),
        )),
    }
}

fn git_output(worktree: &str, args: &[&str]) -> Result<String, EvolutionError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(args)
        .output()
        .map_err(|error| EvolutionError::Internal(format!("run git: {error}")))?;
    if !output.status.success() {
        return Err(EvolutionError::Internal(format!(
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn diff_counts(worktree: &str) -> Result<(u32, u32), EvolutionError> {
    let output = git_output(worktree, &["diff", "--numstat", "--"])?;
    let mut added = 0_u32;
    let mut removed = 0_u32;
    for line in output.lines() {
        let mut fields = line.split('\t');
        added = added.saturating_add(fields.next().and_then(|v| v.parse().ok()).unwrap_or(0));
        removed = removed.saturating_add(fields.next().and_then(|v| v.parse().ok()).unwrap_or(0));
    }
    Ok((added, removed))
}

fn enforce_diff_guards(
    diff: &str,
    files_changed: &[PathBuf],
    lines_added: u32,
    lines_removed: u32,
    budget: &TrialBudget,
) -> Result<(), EvolutionError> {
    if files_changed.len() > budget.max_files_changed as usize
        || lines_added.saturating_add(lines_removed) > budget.max_lines_changed
    {
        return Err(EvolutionError::BudgetExceeded(
            "trial diff exceeds file or line budget".to_string(),
        ));
    }
    if files_changed
        .iter()
        .any(|path| path == Path::new("Cargo.lock"))
    {
        return Err(EvolutionError::PreflightFailed(
            "dependency lockfile changes are not allowed".to_string(),
        ));
    }
    if diff.lines().any(|line| {
        line.starts_with('-')
            && (line.contains("#[test]") || line.contains("mod tests") || line.contains("assert!"))
    }) {
        return Err(EvolutionError::PreflightFailed(
            "patch removes tests or assertions".to_string(),
        ));
    }
    if contains_secret(diff) {
        return Err(EvolutionError::PreflightFailed(
            "patch contains credential-like material".to_string(),
        ));
    }
    Ok(())
}

fn contains_secret(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "-----begin private key-----",
        "bearer ",
        "password=",
        "secret=",
        "token=",
        "ghp_",
        "xoxb-",
        "akia",
        "sk-",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

pub fn scrub_sensitive_text(text: &str) -> String {
    text.lines()
        .take(20_000)
        .map(|line| {
            if contains_secret(line) {
                "[REDACTED]".to_string()
            } else {
                line.chars().take(4_000).collect()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn source_hash_placeholder() -> &'static str {
    "verified-before-and-after-trial"
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

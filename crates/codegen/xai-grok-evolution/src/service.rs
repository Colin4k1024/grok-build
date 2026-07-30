//! Workspace-scoped runtime service and product-facing query surface.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use tokio_util::sync::CancellationToken;

use crate::acp::{
    EventSummary, LineageEdgeDto, LineageNode, LineageResponse, RunSummary, StatusResponse,
};
use crate::config::{EvolutionConfig, EvolutionMode};
use crate::engine::{
    EngineRunResult, EvolutionEngine, TrialEvaluator, TrialExecutor, TrialValidator,
    VariantGenerator,
};
use crate::error::EvolutionError;
use crate::events::EvolutionEvent;
use crate::events::store::{EvolutionStore, StoredEvent};
use crate::reuse;
use crate::rollout::killswitch::{KillSwitch, global_kill_switch};
use crate::rollout::{RolloutApproval, RolloutEvidence, RolloutReadiness};
use crate::select::SelectionContext;
use crate::signal::{DefaultSignalCollector, SessionSignalsDelta, SignalCollector};
use crate::solidify::artifact::gc_orphans;
use crate::trial::preflight::{IsolationPreflight, PreflightResult};
use crate::types::*;

const SIGNAL_QUEUE_CAPACITY: usize = 64;

pub struct EvolutionPorts {
    pub generator: Arc<dyn VariantGenerator>,
    pub executor: Arc<dyn TrialExecutor>,
    pub validator: Arc<dyn TrialValidator>,
    pub evaluator: Arc<dyn TrialEvaluator>,
    pub preflight: Arc<dyn IsolationPreflight>,
}

struct QueuedRun {
    trigger: TriggerInfo,
    signals: Vec<EvolutionSignal>,
    selection_context: SelectionContext,
}

struct ServiceInner {
    config: Arc<RwLock<EvolutionConfig>>,
    store: EvolutionStore,
    engine: Arc<EvolutionEngine>,
    data_dir: PathBuf,
    artifacts_dir: PathBuf,
    sender: std::sync::mpsc::SyncSender<QueuedRun>,
    pending: Arc<AtomicUsize>,
    kill_switch: KillSwitch,
    circuit_breaker: std::sync::Mutex<crate::rollout::metrics::CircuitBreaker>,
    cancel: CancellationToken,
    preflight: Option<Arc<dyn IsolationPreflight>>,
    last_preflight: RwLock<Option<PreflightResult>>,
}

#[derive(Clone)]
pub struct EvolutionService {
    inner: Arc<ServiceInner>,
}

#[derive(Debug, Clone)]
pub struct ExperienceInjection {
    pub injection_id: String,
    pub experience_id: ExperienceId,
    pub context_hash: ContentHash,
    pub prompt: String,
}

impl EvolutionService {
    pub fn open_at(
        workspace_root: &Path,
        memory_root: &Path,
        config: EvolutionConfig,
    ) -> Result<Self, EvolutionError> {
        Self::open_at_with_ports(workspace_root, memory_root, config, None)
    }

    pub fn open_at_with_ports(
        workspace_root: &Path,
        memory_root: &Path,
        config: EvolutionConfig,
        ports: Option<EvolutionPorts>,
    ) -> Result<Self, EvolutionError> {
        config.validate()?;
        if config.mode.can_run_trials() {
            return Err(EvolutionError::PreflightFailed(
                "autonomous/reuse modes cannot be enabled directly at startup; start in Shadow and use the gated set_mode transition"
                    .to_string(),
            ));
        }
        let workspace_id = workspace_identity(workspace_root)?;
        let data_dir = memory_root.join(workspace_id).join("evolution");
        let artifacts_dir = data_dir.join("artifacts");
        let staging_dir = data_dir.join("staging");
        std::fs::create_dir_all(&artifacts_dir).map_err(|error| {
            EvolutionError::Internal(format!("create evolution artifacts directory: {error}"))
        })?;
        std::fs::create_dir_all(&staging_dir).map_err(|error| {
            EvolutionError::Internal(format!("create evolution staging directory: {error}"))
        })?;

        let store = EvolutionStore::open(&data_dir.join("evolution.sqlite"))?;
        store.verify_event_hashes()?;
        store.rebuild_projection()?;
        let recovery_age = config.budget.max_duration_secs.saturating_mul(2).max(3600);
        store.recover_stale_runs(recovery_age)?;
        let known_hashes = store.known_artifact_hashes()?;
        gc_orphans(&artifacts_dir, &known_hashes)?;

        let kill_switch = global_kill_switch().clone();
        let cancel = CancellationToken::new();
        let mut engine = EvolutionEngine::new(
            store.clone(),
            artifacts_dir.clone(),
            staging_dir,
            kill_switch.clone(),
            cancel.clone(),
        );
        let mut preflight = None;
        if let Some(ports) = ports {
            preflight = Some(ports.preflight);
            engine = engine.with_ports(
                ports.generator,
                ports.executor,
                ports.validator,
                ports.evaluator,
            );
        }
        let engine = Arc::new(engine);
        let config = Arc::new(RwLock::new(config));
        let pending = Arc::new(AtomicUsize::new(0));
        let (sender, receiver) = std::sync::mpsc::sync_channel(SIGNAL_QUEUE_CAPACITY);
        spawn_consumer(
            receiver,
            Arc::clone(&engine),
            Arc::clone(&config),
            Arc::clone(&pending),
            cancel.clone(),
        );

        Ok(Self {
            inner: Arc::new(ServiceInner {
                config,
                store,
                engine,
                data_dir,
                artifacts_dir,
                sender,
                pending,
                kill_switch,
                circuit_breaker: std::sync::Mutex::new(
                    crate::rollout::metrics::CircuitBreaker::new(10, 0.5),
                ),
                cancel,
                preflight,
                last_preflight: RwLock::new(None),
            }),
        })
    }

    /// Non-blocking turn-end ingestion. Returns false when disabled, sampled
    /// out, empty, or the bounded queue is full.
    pub fn on_turn_end(
        &self,
        delta: &SessionSignalsDelta,
        selection_context: SelectionContext,
    ) -> bool {
        let config = match self.inner.config.read() {
            Ok(config) => config.clone(),
            Err(_) => return false,
        };
        if config.mode == EvolutionMode::Off || self.inner.kill_switch.is_active() {
            return false;
        }
        if config.mode == EvolutionMode::Shadow && !sample_shadow(delta, config.shadow_sample_rate)
        {
            return false;
        }
        let signals = DefaultSignalCollector.collect(delta);
        if signals.is_empty() {
            return false;
        }
        let trigger = trigger_from_signals(&signals);
        self.inner.pending.fetch_add(1, Ordering::AcqRel);
        if self
            .inner
            .sender
            .try_send(QueuedRun {
                trigger,
                signals,
                selection_context,
            })
            .is_err()
        {
            self.inner.pending.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        true
    }

    pub fn run_manual(
        &self,
        description: String,
        selection_context: SelectionContext,
    ) -> Result<EngineRunResult, EvolutionError> {
        let config = self.config()?;
        let now = now_epoch();
        let signal = EvolutionSignal {
            signal_id: uuid::Uuid::new_v4().to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            signal_type: SignalType::UserCorrection,
            severity: SignalSeverity::Low,
            source: SignalSource {
                session_id: "manual".to_string(),
                turn_id: None,
                tool_name: None,
                file_path: None,
            },
            description: crate::signal::classifier::sanitize_description(&description),
            context_hash: blake3::hash(description.as_bytes()).to_hex().to_string(),
            created_at: now,
        };
        self.inner.engine.run(
            &config,
            TriggerInfo {
                trigger_type: TriggerType::Manual,
                source_event_id: None,
                description,
            },
            vec![signal],
            selection_context,
        )
    }

    pub fn set_mode(
        &self,
        target: EvolutionMode,
        preflight: Option<&PreflightResult>,
    ) -> Result<EvolutionMode, EvolutionError> {
        let mut config = self.inner.config.write().map_err(|error| {
            EvolutionError::Internal(format!("evolution config lock poisoned: {error}"))
        })?;
        let current = config.mode;
        if target == current {
            return Ok(current);
        }
        if current.can_downgrade_to(target) {
            config.mode = target;
            return Ok(target);
        }
        if !current.can_upgrade_to(target) {
            return Err(EvolutionError::InvalidTransition {
                from: format!("{current:?}"),
                to: format!("{target:?}"),
            });
        }
        if target.can_run_trials() {
            if !self.inner.engine.supports_trials() {
                return Err(EvolutionError::SandboxUnavailable(
                    "trial ports are not installed".to_string(),
                ));
            }
            let owned_preflight = self
                .inner
                .preflight
                .as_ref()
                .map(|runner| runner.run())
                .transpose()?;
            let result = owned_preflight.as_ref().or(preflight).ok_or_else(|| {
                EvolutionError::PreflightFailed("autonomous mode requires preflight".to_string())
            })?;
            *self.inner.last_preflight.write().map_err(|error| {
                EvolutionError::Internal(format!("preflight result lock poisoned: {error}"))
            })? = Some(result.clone());
            if !result.all_passed() {
                return Err(EvolutionError::PreflightFailed(
                    result.failure_reasons.join("; "),
                ));
            }
        }
        if target == EvolutionMode::ReuseEligible {
            self.inner
                .store
                .current_rollout_approval()?
                .ok_or_else(|| {
                    EvolutionError::PreflightFailed(
                        "reuse rollout gates have not been approved".to_string(),
                    )
                })?;
        }
        config.mode = target;
        Ok(target)
    }

    pub fn approve_rollout(
        &self,
        readiness: RolloutReadiness,
        evidence: RolloutEvidence,
        approved_by: String,
    ) -> Result<RolloutApproval, EvolutionError> {
        let approval = RolloutApproval::new(readiness, evidence, approved_by, now_epoch())?;
        self.inner.store.save_rollout_approval(&approval)?;
        Ok(approval)
    }

    pub fn rollout_approval(&self) -> Result<Option<RolloutApproval>, EvolutionError> {
        self.inner.store.current_rollout_approval()
    }

    pub fn revoke_rollout_approval(&self, reason: &str) -> Result<bool, EvolutionError> {
        self.inner.store.revoke_rollout_approval(reason, now_epoch())
    }

    pub fn last_preflight(&self) -> Result<Option<PreflightResult>, EvolutionError> {
        self.inner
            .last_preflight
            .read()
            .map(|result| result.clone())
            .map_err(|error| {
                EvolutionError::Internal(format!("preflight result lock poisoned: {error}"))
            })
    }

    pub fn experience_context(
        &self,
        context: &SelectionContext,
    ) -> Result<Option<String>, EvolutionError> {
        Ok(self
            .experience_injection(context)?
            .map(|injection| injection.prompt))
    }

    pub fn experience_injection(
        &self,
        context: &SelectionContext,
    ) -> Result<Option<ExperienceInjection>, EvolutionError> {
        let config = self.config()?;
        if !config.mode.can_inject() || self.inner.kill_switch.is_active() {
            return Ok(None);
        }
        // Check circuit breaker
        if let Ok(cb) = self.inner.circuit_breaker.lock() {
            if cb.should_trip() {
                tracing::warn!("experience injection blocked by circuit breaker");
                return Ok(None);
            }
        }
        if self.inner.store.current_rollout_approval()?.is_none() {
            return Ok(None);
        }
        let candidates = self
            .inner
            .store
            .experiences_by_state(ExperienceState::Active)?;
        let selected = crate::select::select(&candidates, context)?;
        let Some(revision) = selected.main else {
            return Ok(None);
        };
        let Some(experience) =
            reuse::load_context_from_artifact(&revision, &self.inner.artifacts_dir)
        else {
            return Ok(None);
        };
        let Some(prompt) = reuse::safe_inject(&experience) else {
            return Ok(None);
        };
        Ok(Some(ExperienceInjection {
            injection_id: uuid::Uuid::new_v4().to_string(),
            experience_id: revision.experience_id,
            context_hash: revision.content_hash,
            prompt,
        }))
    }

    pub fn record_reuse(
        &self,
        experience_id: &str,
        run_id: &str,
        outcome: ReuseOutcome,
        context_hash: ContentHash,
    ) -> Result<ExperienceState, EvolutionError> {
        let config = self.config()?;
        let observation = ReuseObservation {
            observation_id: uuid::Uuid::new_v4().to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            experience_id: experience_id.to_string(),
            run_id: run_id.to_string(),
            outcome,
            context_hash,
            observed_at: now_epoch(),
        };
        let state = self.inner.store.record_reuse_with_policy(
            &observation,
            config.governor.promote_after_successes,
            config.governor.quarantine_after_failures,
        )?;
        // Feed outcome to circuit breaker
        if let Ok(mut cb) = self.inner.circuit_breaker.lock() {
            let success = matches!(outcome, ReuseOutcome::Helped | ReuseOutcome::Neutral);
            if cb.record(success) {
                // Circuit breaker tripped — activate kill switch
                self.inner.kill_switch.activate(
                    "circuit breaker tripped: high failure rate in recent observations".to_string(),
                );
                tracing::error!("evolution kill switch activated by circuit breaker");
            }
        }
        Ok(state)
    }

    pub fn status(&self) -> Result<StatusResponse, EvolutionError> {
        let config = self.config()?;
        let active = self
            .inner
            .store
            .experiences_by_state(ExperienceState::Active)?;
        let quarantined = self
            .inner
            .store
            .experiences_by_state(ExperienceState::Quarantined)?;
        let all = self.inner.store.all_experiences()?;
        let rollout_approval = self.inner.store.current_rollout_approval()?;
        Ok(StatusResponse {
            mode: config.mode,
            active_runs: self.inner.store.count_runs(Some("running"))?,
            total_experiences: all.len() as u32,
            active_experiences: active.len() as u32,
            quarantined_experiences: quarantined.len() as u32,
            pending_signals: self.inner.pending.load(Ordering::Acquire) as u32,
            circuit_breaker_state: if self.inner.kill_switch.is_active() {
                "open".to_string()
            } else {
                "closed".to_string()
            },
            rollout_approved: rollout_approval.is_some(),
            rollout_approval_id: rollout_approval.map(|approval| approval.approval_id),
        })
    }

    pub fn list_runs(
        &self,
        state: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<RunSummary>, EvolutionError> {
        self.inner
            .store
            .list_runs(state, limit, offset)?
            .into_iter()
            .map(|run| {
                let events = self.inner.store.events_for_run(&run.run_id)?;
                let signals_count = events
                    .iter()
                    .filter_map(|event| event.decode().ok())
                    .find_map(|event| match event {
                        EvolutionEvent::SignalsDetected { signals, .. } => {
                            Some(signals.len() as u32)
                        }
                        _ => None,
                    })
                    .unwrap_or(0);
                let outcome = events
                    .iter()
                    .filter_map(|event| event.decode().ok())
                    .find_map(|event| match event {
                        EvolutionEvent::AdoptionDecided { decision, .. } => Some(decision),
                        _ => None,
                    });
                Ok(RunSummary {
                    run_id: run.run_id,
                    state: run.state,
                    trigger_type: run.trigger.trigger_type,
                    started_at: run.started_at,
                    completed_at: run.completed_at,
                    signals_count,
                    outcome,
                })
            })
            .collect()
    }

    pub fn inspect_run(
        &self,
        run_id: &str,
    ) -> Result<(EvolutionRun, Vec<EventSummary>, Option<EvidenceBundle>), EvolutionError> {
        let run = self
            .inner
            .store
            .get_run(run_id)?
            .ok_or_else(|| EvolutionError::Internal(format!("run not found: {run_id}")))?;
        let events = self
            .inner
            .store
            .events_for_run(run_id)?
            .into_iter()
            .map(|event| EventSummary {
                description: describe_event(&event),
                event_type: event.event_type,
                timestamp: event.timestamp,
            })
            .collect();
        let evidence = self.inner.store.evidence_for_run(run_id)?;
        Ok((run, events, evidence))
    }

    pub fn lineage(
        &self,
        experience_id: &str,
        depth: u32,
    ) -> Result<LineageResponse, EvolutionError> {
        let revisions = self.inner.store.all_experiences()?;
        if !revisions
            .iter()
            .any(|revision| revision.experience_id == experience_id)
        {
            return Err(EvolutionError::Internal(format!(
                "experience not found: {experience_id}"
            )));
        }
        let mut frontier = vec![experience_id.to_string()];
        let mut included = std::collections::HashSet::new();
        for _ in 0..=depth.min(64) {
            let current = std::mem::take(&mut frontier);
            if current.is_empty() {
                break;
            }
            for id in current {
                if !included.insert(id.clone()) {
                    continue;
                }
                for revision in &revisions {
                    if revision.experience_id == id {
                        if let Some(parent) = &revision.parent_id {
                            frontier.push(parent.clone());
                        }
                    } else if revision.parent_id.as_deref() == Some(id.as_str()) {
                        frontier.push(revision.experience_id.clone());
                    }
                }
            }
        }
        let nodes = revisions
            .iter()
            .filter(|revision| included.contains(&revision.experience_id))
            .map(|revision| LineageNode {
                experience_id: revision.experience_id.clone(),
                state: revision.state,
                confidence: revision.confidence,
                success_count: revision.success_count,
                failure_count: revision.failure_count,
                created_at: revision.created_at,
            })
            .collect();
        let edges = revisions
            .iter()
            .filter_map(|revision| {
                let parent = revision.parent_id.as_ref()?;
                (included.contains(parent) && included.contains(&revision.experience_id)).then(
                    || LineageEdgeDto {
                        parent_id: parent.clone(),
                        child_id: revision.experience_id.clone(),
                        edge_type: LineageEdgeType::DerivesFrom,
                    },
                )
            })
            .collect();
        Ok(LineageResponse { nodes, edges })
    }

    pub fn retry_run(&self, run_id: &str) -> Result<EngineRunResult, EvolutionError> {
        let config = self.config()?;
        if !config.mode.can_run_trials() {
            return Err(EvolutionError::SandboxUnavailable(
                "trial retry requires isolated_autonomous mode".to_string(),
            ));
        }
        let run = self
            .inner
            .store
            .get_run(run_id)?
            .ok_or_else(|| EvolutionError::Internal(format!("run not found: {run_id}")))?;
        if !crate::state::run::is_terminal(run.state) {
            return Err(EvolutionError::InvalidTransition {
                from: format!("{:?}", run.state),
                to: "retry".to_string(),
            });
        }
        let signals = self
            .inner
            .store
            .events_for_run(run_id)?
            .into_iter()
            .filter_map(|event| event.decode().ok())
            .find_map(|event| match event {
                EvolutionEvent::SignalsDetected { signals, .. } => Some(signals),
                _ => None,
            })
            .ok_or_else(|| {
                EvolutionError::Internal(format!("run has no replayable signals: {run_id}"))
            })?;
        self.inner.engine.run(
            &config,
            run.trigger,
            signals.clone(),
            SelectionContext {
                repo: None,
                task_type: None,
                signal_types: signals.iter().map(|signal| signal.signal_type).collect(),
                env_fingerprint: None,
                now: now_epoch(),
            },
        )
    }

    pub fn export_evidence_json(
        &self,
        run_id: &str,
        output_dir: &Path,
    ) -> Result<PathBuf, EvolutionError> {
        let evidence = self
            .inner
            .store
            .evidence_for_run(run_id)?
            .ok_or_else(|| EvolutionError::Internal(format!("no evidence for run {run_id}")))?;
        std::fs::create_dir_all(output_dir)
            .map_err(|error| EvolutionError::Internal(format!("create export dir: {error}")))?;
        let path = output_dir.join(format!("evolution-{run_id}.json"));
        let bytes = serde_json::to_vec_pretty(&evidence)
            .map_err(|error| EvolutionError::Internal(format!("serialize evidence: {error}")))?;
        std::fs::write(&path, bytes)
            .map_err(|error| EvolutionError::Internal(format!("write evidence export: {error}")))?;
        Ok(path)
    }

    pub fn config(&self) -> Result<EvolutionConfig, EvolutionError> {
        self.inner
            .config
            .read()
            .map(|config| config.clone())
            .map_err(|error| {
                EvolutionError::Internal(format!("evolution config lock poisoned: {error}"))
            })
    }

    pub fn store(&self) -> &EvolutionStore {
        &self.inner.store
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    pub fn shutdown(&self) {
        self.inner.cancel.cancel();
    }
}

fn spawn_consumer(
    receiver: std::sync::mpsc::Receiver<QueuedRun>,
    engine: Arc<EvolutionEngine>,
    config: Arc<RwLock<EvolutionConfig>>,
    pending: Arc<AtomicUsize>,
    cancel: CancellationToken,
) {
    std::thread::Builder::new()
        .name("grok-evolution".to_string())
        .spawn(move || {
            while !cancel.is_cancelled() {
                let queued = match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
                    Ok(queued) => queued,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let current = config.read().ok().map(|value| value.clone());
                if let Some(current) = current {
                    if let Err(error) = engine.run(
                        &current,
                        queued.trigger,
                        queued.signals,
                        queued.selection_context,
                    ) {
                        tracing::warn!(%error, "background evolution run failed closed");
                    }
                }
                pending.fetch_sub(1, Ordering::AcqRel);
            }
        })
        .expect("failed to spawn evolution consumer");
}

fn workspace_identity(workspace_root: &Path) -> Result<String, EvolutionError> {
    let canonical = workspace_root.canonicalize().map_err(|error| {
        EvolutionError::PreflightFailed(format!(
            "cannot resolve workspace {}: {error}",
            workspace_root.display()
        ))
    })?;
    Ok(blake3::hash(canonical.to_string_lossy().as_bytes()).to_hex()[..24].to_string())
}

fn sample_shadow(delta: &SessionSignalsDelta, rate: f64) -> bool {
    if rate >= 1.0 {
        return true;
    }
    if rate <= 0.0 {
        return false;
    }
    let key = format!(
        "{}:{}",
        delta.session_id,
        delta.turn_id.as_deref().unwrap_or("")
    );
    let bytes = blake3::hash(key.as_bytes());
    let mut prefix = [0_u8; 8];
    prefix.copy_from_slice(&bytes.as_bytes()[..8]);
    let value = u64::from_le_bytes(prefix) as f64 / u64::MAX as f64;
    value < rate
}

fn trigger_from_signals(signals: &[EvolutionSignal]) -> TriggerInfo {
    let first = &signals[0];
    let trigger_type = match first.signal_type {
        SignalType::ToolFailure | SignalType::Timeout | SignalType::RetryExhausted => {
            TriggerType::ToolFailure
        }
        SignalType::TestFailure | SignalType::CompilationError | SignalType::Panic => {
            TriggerType::TestFailure
        }
        SignalType::UserCorrection | SignalType::NegativeFeedback => TriggerType::UserFeedback,
        SignalType::PerformanceRegression => TriggerType::PerformanceRegression,
    };
    TriggerInfo {
        trigger_type,
        source_event_id: Some(first.signal_id.clone()),
        description: first.description.clone(),
    }
}

fn describe_event(event: &StoredEvent) -> String {
    match event.decode() {
        Ok(EvolutionEvent::StageStarted { stage, .. }) => format!("stage {stage} started"),
        Ok(EvolutionEvent::StageCompleted { stage, .. }) => format!("stage {stage} completed"),
        Ok(EvolutionEvent::StageFailed { stage, error, .. }) => {
            format!("stage {stage} failed: {error}")
        }
        Ok(EvolutionEvent::RunFinished { state, error, .. }) => error
            .map(|error| format!("run finished as {state:?}: {error}"))
            .unwrap_or_else(|| format!("run finished as {state:?}")),
        Ok(_) => event.event_type.clone(),
        Err(error) => format!("invalid event payload: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{TrialExecution, ValidationComparison};

    struct UnusedTrialPort;

    impl VariantGenerator for UnusedTrialPort {
        fn generate(
            &self,
            _run_id: &str,
            _signals: &[EvolutionSignal],
            _selected: Option<&ExperienceRevision>,
        ) -> Result<ExperienceCandidate, EvolutionError> {
            Err(EvolutionError::Internal(
                "unexpected variant generation during preflight".to_string(),
            ))
        }
    }

    impl TrialExecutor for UnusedTrialPort {
        fn execute(
            &self,
            _run_id: &str,
            _candidate: &ExperienceCandidate,
            _spec: &TrialSpec,
            _cancel: &CancellationToken,
        ) -> Result<TrialExecution, EvolutionError> {
            Err(EvolutionError::Internal(
                "unexpected trial execution during preflight".to_string(),
            ))
        }
    }

    impl TrialValidator for UnusedTrialPort {
        fn validate(
            &self,
            _candidate: &ExperienceCandidate,
            _execution: &TrialExecution,
        ) -> Result<ValidationComparison, EvolutionError> {
            Err(EvolutionError::Internal(
                "unexpected validation during preflight".to_string(),
            ))
        }
    }

    impl TrialEvaluator for UnusedTrialPort {
        fn evaluate(
            &self,
            _candidate: &ExperienceCandidate,
            _execution: &TrialExecution,
            _comparison: &ValidationComparison,
        ) -> Result<crate::events::EvaluationResult, EvolutionError> {
            Err(EvolutionError::Internal(
                "unexpected evaluation during preflight".to_string(),
            ))
        }
    }

    struct DeniedPreflight {
        calls: Arc<AtomicUsize>,
    }

    impl IsolationPreflight for DeniedPreflight {
        fn run(&self) -> Result<PreflightResult, EvolutionError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            Ok(PreflightResult {
                source_dir_write_blocked: true,
                network_blocked: false,
                symlink_escape_blocked: true,
                worktree_outside_write_blocked: true,
                sandbox_available: true,
                disk_space_sufficient: true,
                vcs_clean: true,
                failure_reasons: vec!["network isolation probe failed".to_string()],
            })
        }
    }

    fn selection_context() -> SelectionContext {
        SelectionContext {
            repo: Some("test/repo".to_string()),
            task_type: Some("coding".to_string()),
            signal_types: vec![SignalType::ToolFailure],
            env_fingerprint: None,
            now: now_epoch(),
        }
    }

    fn passing_readiness() -> RolloutReadiness {
        RolloutReadiness {
            source_pollution_events: 0,
            sandbox_complete: true,
            evidence_complete: true,
            unexplained_network_or_writes: 0,
            safety_drills_passed: true,
            replay_regressions: 0,
            metrics_baseline_established: true,
        }
    }

    fn rollout_evidence() -> RolloutEvidence {
        RolloutEvidence {
            shadow_metrics_hash: "1".repeat(64),
            sandbox_report_hash: "2".repeat(64),
            evidence_completeness_hash: "3".repeat(64),
            safety_drill_report_hash: "4".repeat(64),
            replay_report_hash: "5".repeat(64),
        }
    }

    #[test]
    fn shadow_turn_creates_real_run_without_touching_workspace() {
        global_kill_switch().deactivate();
        let workspace = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        let source = workspace.path().join("source.txt");
        std::fs::write(&source, "unchanged").unwrap();
        let mut config = EvolutionConfig {
            mode: EvolutionMode::Shadow,
            shadow_sample_rate: 1.0,
            ..EvolutionConfig::default()
        };
        config.max_trials_per_session = 1;
        let service = EvolutionService::open_at(workspace.path(), memory.path(), config).unwrap();
        let accepted = service.on_turn_end(
            &SessionSignalsDelta {
                session_id: "session-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                tool_failures: vec![crate::signal::ToolFailure {
                    tool_name: "cargo".to_string(),
                    error_message: "check failed".to_string(),
                    file_path: None,
                    exit_code: Some(1),
                }],
                test_failures: Vec::new(),
                timeouts: Vec::new(),
                panics: Vec::new(),
                user_corrections: Vec::new(),
                negative_feedback: Vec::new(),
                performance_regressions: Vec::new(),
                retries_exhausted: Vec::new(),
                compilation_errors: Vec::new(),
            },
            selection_context(),
        );
        assert!(accepted);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while service.status().unwrap().pending_signals > 0 && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let runs = service.list_runs(None, 10, 0).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].state, RunState::Completed);
        assert_eq!(std::fs::read_to_string(source).unwrap(), "unchanged");
        service.shutdown();
    }

    #[test]
    fn autonomous_mode_cannot_bypass_runtime_preflight_at_startup() {
        let workspace = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        let config = EvolutionConfig {
            mode: EvolutionMode::IsolatedAutonomous,
            ..EvolutionConfig::default()
        };
        assert!(matches!(
            EvolutionService::open_at(workspace.path(), memory.path(), config),
            Err(EvolutionError::PreflightFailed(_))
        ));
    }

    #[test]
    fn internal_preflight_denial_cannot_be_overridden_by_caller_report() {
        global_kill_switch().deactivate();
        let workspace = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let trial_port = Arc::new(UnusedTrialPort);
        let service = EvolutionService::open_at_with_ports(
            workspace.path(),
            memory.path(),
            EvolutionConfig {
                mode: EvolutionMode::Shadow,
                ..EvolutionConfig::default()
            },
            Some(EvolutionPorts {
                generator: trial_port.clone(),
                executor: trial_port.clone(),
                validator: trial_port.clone(),
                evaluator: trial_port,
                preflight: Arc::new(DeniedPreflight {
                    calls: calls.clone(),
                }),
            }),
        )
        .unwrap();
        let forged_pass = PreflightResult {
            source_dir_write_blocked: true,
            network_blocked: true,
            symlink_escape_blocked: true,
            worktree_outside_write_blocked: true,
            sandbox_available: true,
            disk_space_sufficient: true,
            vcs_clean: true,
            failure_reasons: Vec::new(),
        };

        assert!(matches!(
            service.set_mode(EvolutionMode::IsolatedAutonomous, Some(&forged_pass)),
            Err(EvolutionError::PreflightFailed(message))
                if message.contains("network isolation probe failed")
        ));
        assert_eq!(calls.load(Ordering::Acquire), 1);
        assert_eq!(service.config().unwrap().mode, EvolutionMode::Shadow);
        assert!(!service.last_preflight().unwrap().unwrap().all_passed());
        service.shutdown();
    }

    #[test]
    fn rollout_approval_persists_and_revocation_is_immediate() {
        let workspace = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        let service = EvolutionService::open_at(
            workspace.path(),
            memory.path(),
            EvolutionConfig {
                mode: EvolutionMode::Shadow,
                ..EvolutionConfig::default()
            },
        )
        .unwrap();
        let approval = service
            .approve_rollout(
                passing_readiness(),
                rollout_evidence(),
                "release-operator@example.com".to_string(),
            )
            .unwrap();
        assert_eq!(
            service
                .rollout_approval()
                .unwrap()
                .unwrap()
                .approval_id,
            approval.approval_id
        );
        assert!(service.status().unwrap().rollout_approved);
        service.shutdown();
        drop(service);

        let reopened = EvolutionService::open_at(
            workspace.path(),
            memory.path(),
            EvolutionConfig {
                mode: EvolutionMode::Shadow,
                ..EvolutionConfig::default()
            },
        )
        .unwrap();
        assert_eq!(
            reopened
                .rollout_approval()
                .unwrap()
                .unwrap()
                .approval_id,
            approval.approval_id
        );
        assert!(reopened.revoke_rollout_approval("replay baseline changed").unwrap());
        assert!(reopened.rollout_approval().unwrap().is_none());
        assert!(!reopened.status().unwrap().rollout_approved);
        reopened.shutdown();
    }

    #[test]
    fn lifecycle_promotes_injects_and_quarantines_immediately() {
        global_kill_switch().deactivate();
        let workspace = tempfile::tempdir().unwrap();
        let memory = tempfile::tempdir().unwrap();
        let source = workspace.path().join("source.txt");
        std::fs::write(&source, "unchanged").unwrap();
        let service = EvolutionService::open_at(
            workspace.path(),
            memory.path(),
            EvolutionConfig {
                mode: EvolutionMode::Shadow,
                ..EvolutionConfig::default()
            },
        )
        .unwrap();

        let content = crate::reuse::ExperienceContent {
            preconditions: vec!["tool failure in coding task".to_string()],
            recommended_steps: vec!["apply the validated bounded change".to_string()],
            forbidden_actions: vec!["do not delete tests".to_string()],
            validation_recipe: vec!["cargo test -p affected-crate".to_string()],
            evidence_summary: "validated in an isolated trial".to_string(),
        };
        let bytes = serde_json::to_vec(&content).unwrap();
        let content_hash = blake3::hash(&bytes).to_hex().to_string();
        let staging = service.inner.data_dir.join("candidate.tmp");
        std::fs::write(&staging, bytes).unwrap();
        crate::solidify::artifact::atomic_publish(
            &staging,
            &service.inner.artifacts_dir,
            &content_hash,
        )
        .unwrap();
        let now = now_epoch();
        let experience_id = "experience-lifecycle";
        service
            .store()
            .append_and_project(
                "publish-lifecycle",
                &EvolutionEvent::RevisionPublished {
                    run_id: "publish-lifecycle".to_string(),
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
                            repo: Some("test/repo".to_string()),
                            task_type: Some("coding".to_string()),
                            signal_types: vec![SignalType::ToolFailure],
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
            .unwrap();

        for index in 0..3 {
            assert_eq!(
                service
                    .record_reuse(
                        experience_id,
                        &format!("promotion-{index}"),
                        ReuseOutcome::Helped,
                        content_hash.clone(),
                    )
                    .unwrap(),
                if index == 2 {
                    ExperienceState::Active
                } else {
                    ExperienceState::Candidate
                }
            );
        }
        service
            .approve_rollout(
                passing_readiness(),
                rollout_evidence(),
                "test-operator".to_string(),
            )
            .unwrap();
        service.inner.config.write().unwrap().mode = EvolutionMode::ReuseEligible;
        let first = service
            .experience_injection(&selection_context())
            .unwrap()
            .expect("active experience should be injected");
        assert_eq!(first.experience_id, experience_id);
        assert!(first.prompt.contains("do not delete tests"));
        assert!(
            service
                .revoke_rollout_approval("safety drill requested")
                .unwrap()
        );
        assert!(
            service
                .experience_injection(&selection_context())
                .unwrap()
                .is_none()
        );
        service
            .approve_rollout(
                passing_readiness(),
                rollout_evidence(),
                "test-operator".to_string(),
            )
            .unwrap();
        assert_eq!(
            service
                .record_reuse(
                    experience_id,
                    &first.injection_id,
                    ReuseOutcome::Hindered,
                    first.context_hash,
                )
                .unwrap(),
            ExperienceState::Active
        );
        let second = service
            .experience_injection(&selection_context())
            .unwrap()
            .expect("one failure must not quarantine yet");
        assert_eq!(
            service
                .record_reuse(
                    experience_id,
                    &second.injection_id,
                    ReuseOutcome::Hindered,
                    second.context_hash,
                )
                .unwrap(),
            ExperienceState::Quarantined
        );
        assert!(
            service
                .experience_injection(&selection_context())
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_to_string(source).unwrap(), "unchanged");
        service.shutdown();
    }
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

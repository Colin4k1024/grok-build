//! CLI command logic for `grok evolution`.
//!
//! Provides the business logic for headless CLI commands. The actual
//! CLI argument parsing (clap) lives in `xai-grok-shell`; this module
//! provides the functions that shell calls.
//!
//! All commands support `--json` output via the `OutputFormat` enum.

use serde::Serialize;

use crate::acp::*;
use crate::config::EvolutionConfig;
use crate::error::EvolutionError;
use crate::events::store::EvolutionStore;
use crate::types::*;

/// Output format for CLI results.
#[derive(Debug, Clone, Copy)]
pub enum OutputFormat {
    /// Human-readable text.
    Text,
    /// JSON output.
    Json,
}

/// `grok evolution status`
pub fn cmd_status(
    store: &EvolutionStore,
    config: &EvolutionConfig,
) -> Result<StatusResponse, EvolutionError> {
    let active = store.experiences_by_state(ExperienceState::Active)?;
    let quarantined = store.experiences_by_state(ExperienceState::Quarantined)?;
    let candidates = store.experiences_by_state(ExperienceState::Candidate)?;
    let rollout_approval = store.current_rollout_approval()?;

    Ok(StatusResponse {
        mode: config.mode,
        active_runs: store.count_runs(Some("running"))?,
        total_experiences: (active.len() + quarantined.len() + candidates.len()) as u32,
        active_experiences: active.len() as u32,
        quarantined_experiences: quarantined.len() as u32,
        pending_signals: 0,
        circuit_breaker_state: if crate::rollout::killswitch::global_kill_switch().is_active() {
            "open".to_string()
        } else {
            "closed".to_string()
        },
        rollout_approved: rollout_approval.is_some(),
        rollout_approval_id: rollout_approval.map(|approval| approval.approval_id),
    })
}

/// `grok evolution list [--state <state>] [--limit <n>]`
pub fn cmd_list(
    store: &EvolutionStore,
    request: &ListRunsRequest,
) -> Result<ListRunsResponse, EvolutionError> {
    let limit = request.limit.unwrap_or(20);
    let offset = request.offset.unwrap_or(0);
    let runs = store
        .list_runs(request.state_filter.as_deref(), limit, offset)?
        .into_iter()
        .map(|run| {
            let events = store.events_for_run(&run.run_id)?;
            let signals_count = events
                .iter()
                .filter_map(|event| event.decode().ok())
                .find_map(|event| match event {
                    crate::events::EvolutionEvent::SignalsDetected { signals, .. } => {
                        Some(signals.len() as u32)
                    }
                    _ => None,
                })
                .unwrap_or(0);
            let outcome = events
                .iter()
                .filter_map(|event| event.decode().ok())
                .find_map(|event| match event {
                    crate::events::EvolutionEvent::AdoptionDecided { decision, .. } => {
                        Some(decision)
                    }
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
        .collect::<Result<Vec<_>, EvolutionError>>()?;
    Ok(ListRunsResponse {
        runs,
        total: store.count_runs(request.state_filter.as_deref())?,
    })
}

/// `grok evolution inspect <run-id>`
pub fn cmd_inspect(
    store: &EvolutionStore,
    request: &InspectRunRequest,
) -> Result<InspectRunResponse, EvolutionError> {
    let stored_events = store.events_for_run(&request.run_id)?;
    let run = store
        .get_run(&request.run_id)?
        .ok_or_else(|| EvolutionError::Internal(format!("run not found: {}", request.run_id)))?;

    let event_summaries: Vec<EventSummary> = stored_events
        .iter()
        .map(|e| EventSummary {
            event_type: e.event_type.clone(),
            timestamp: e.timestamp,
            description: format!("{} at {}", e.event_type, e.timestamp),
        })
        .collect();

    let decoded = stored_events
        .iter()
        .filter_map(|event| event.decode().ok())
        .collect::<Vec<_>>();
    let experience = decoded.iter().find_map(|event| match event {
        crate::events::EvolutionEvent::RevisionPublished { revision, .. } => Some(revision.clone()),
        _ => None,
    });
    let trial_outcome = decoded.iter().find_map(|event| match event {
        crate::events::EvolutionEvent::TrialCompleted { outcome, .. } => Some(outcome.clone()),
        _ => None,
    });
    Ok(InspectRunResponse {
        run,
        events: event_summaries,
        experience,
        trial_outcome,
        evidence: store.evidence_for_run(&request.run_id)?,
    })
}

/// `grok evolution run`
///
/// Requires an active EvolutionService with trial ports (executor, validator,
/// evaluator). These are only available within a full session context where the
/// workspace service is running in IsolatedAutonomous mode or above.
pub fn cmd_run(_config: &EvolutionConfig) -> Result<RetryTrialResponse, EvolutionError> {
    Err(EvolutionError::SandboxUnavailable(
        "isolated trials require an active workspace service with trial ports \
         (executor, validator, evaluator). Run from within an active session \
         where evolution is enabled in IsolatedAutonomous mode."
            .to_string(),
    ))
}

/// `grok evolution export <run-id> [--json]`
pub fn cmd_export(
    _store: &EvolutionStore,
    request: &ExportEvidenceRequest,
) -> Result<ExportEvidenceResponse, EvolutionError> {
    let _ = request;
    Err(EvolutionError::PreflightFailed(
        "evidence export requires EvolutionService and an explicit output directory".to_string(),
    ))
}

/// Format a result for CLI output.
pub fn format_output<T: Serialize>(result: &T, format: OutputFormat) -> String {
    match format {
        OutputFormat::Json => serde_json::to_string_pretty(result)
            .unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e)),
        OutputFormat::Text => {
            // Default text formatting — callers can override
            serde_json::to_string_pretty(result)
                .unwrap_or_else(|e| format!("Error formatting output: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_returns_mode() {
        let store = EvolutionStore::open_memory().unwrap();
        let config = EvolutionConfig::default();
        let resp = cmd_status(&store, &config).unwrap();
        assert_eq!(resp.mode, crate::config::EvolutionMode::Off);
        assert_eq!(resp.active_experiences, 0);
    }

    #[test]
    fn list_returns_empty_initially() {
        let store = EvolutionStore::open_memory().unwrap();
        let resp = cmd_list(
            &store,
            &ListRunsRequest {
                state_filter: None,
                limit: None,
                offset: None,
            },
        )
        .unwrap();
        assert_eq!(resp.total, 0);
    }

    #[test]
    fn inspect_rejects_missing_run() {
        let store = EvolutionStore::open_memory().unwrap();
        let resp = cmd_inspect(
            &store,
            &InspectRunRequest {
                run_id: "nonexistent".to_string(),
            },
        );
        assert!(resp.is_err());
    }

    #[test]
    fn run_requires_workspace_service() {
        let config = EvolutionConfig::default();
        assert!(cmd_run(&config).is_err());
    }

    #[test]
    fn export_requires_explicit_service_path() {
        let store = EvolutionStore::open_memory().unwrap();
        let resp = cmd_export(
            &store,
            &ExportEvidenceRequest {
                run_id: "run-1".to_string(),
                format: Some("json".to_string()),
            },
        );
        assert!(resp.is_err());
    }

    #[test]
    fn format_json_output() {
        let data = serde_json::json!({"key": "value"});
        let output = format_output(&data, OutputFormat::Json);
        assert!(output.contains("\"key\""));
    }
}

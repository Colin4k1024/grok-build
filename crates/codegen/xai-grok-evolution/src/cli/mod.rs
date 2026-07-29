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
use crate::events::schema::SCHEMA_VERSION;
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

    Ok(StatusResponse {
        mode: config.mode,
        active_runs: 0, // Would query runs table
        total_experiences: (active.len() + quarantined.len() + candidates.len()) as u32,
        active_experiences: active.len() as u32,
        quarantined_experiences: quarantined.len() as u32,
        pending_signals: 0, // Would query signal queue
        circuit_breaker_state: "closed".to_string(),
    })
}

/// `grok evolution list [--state <state>] [--limit <n>]`
pub fn cmd_list(
    _store: &EvolutionStore,
    request: &ListRunsRequest,
) -> Result<ListRunsResponse, EvolutionError> {
    // In a full implementation, this would query the runs table
    // with state filter, limit, and offset
    let _ = request;
    Ok(ListRunsResponse {
        runs: vec![],
        total: 0,
    })
}

/// `grok evolution inspect <run-id>`
pub fn cmd_inspect(
    store: &EvolutionStore,
    request: &InspectRunRequest,
) -> Result<InspectRunResponse, EvolutionError> {
    let events = store.events_for_run(&request.run_id)?;

    let event_summaries: Vec<EventSummary> = events
        .iter()
        .map(|e| EventSummary {
            event_type: e.event_type.clone(),
            timestamp: e.timestamp,
            description: format!("{} at {}", e.event_type, e.timestamp),
        })
        .collect();

    Ok(InspectRunResponse {
        run: EvolutionRun {
            run_id: request.run_id.clone(),
            schema_version: SCHEMA_VERSION,
            state: RunState::Running,
            trigger: TriggerInfo {
                trigger_type: TriggerType::Manual,
                source_event_id: None,
                description: String::new(),
            },
            config_snapshot: ConfigSnapshot {
                mode: "unknown".to_string(),
                budget_max_duration_secs: 0,
                budget_max_variant_rounds: 0,
            },
            started_at: 0,
            completed_at: None,
            error: None,
        },
        events: event_summaries,
        experience: None,
        trial_outcome: None,
        evidence: None,
    })
}

/// `grok evolution run` (create isolated trial)
pub fn cmd_run(
    _config: &EvolutionConfig,
) -> Result<RetryTrialResponse, EvolutionError> {
    let run_id = uuid::Uuid::new_v4().to_string();
    Ok(RetryTrialResponse {
        new_run_id: run_id,
        status: "created".to_string(),
    })
}

/// `grok evolution export <run-id> [--json]`
pub fn cmd_export(
    _store: &EvolutionStore,
    request: &ExportEvidenceRequest,
) -> Result<ExportEvidenceResponse, EvolutionError> {
    let format = request.format.as_deref().unwrap_or("json");
    Ok(ExportEvidenceResponse {
        path: format!("/tmp/evolution-export-{}.{}", request.run_id, format),
        size_bytes: 0,
        format: format.to_string(),
    })
}

/// Format a result for CLI output.
pub fn format_output<T: Serialize>(result: &T, format: OutputFormat) -> String {
    match format {
        OutputFormat::Json => serde_json::to_string_pretty(result).unwrap_or_else(|e| {
            format!("{{\"error\": \"{}\"}}", e)
        }),
        OutputFormat::Text => {
            // Default text formatting — callers can override
            serde_json::to_string_pretty(result).unwrap_or_else(|e| {
                format!("Error formatting output: {}", e)
            })
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
        let resp = cmd_list(&store, &ListRunsRequest {
            state_filter: None,
            limit: None,
            offset: None,
        })
        .unwrap();
        assert_eq!(resp.total, 0);
    }

    #[test]
    fn inspect_returns_events() {
        let store = EvolutionStore::open_memory().unwrap();
        let resp = cmd_inspect(&store, &InspectRunRequest {
            run_id: "nonexistent".to_string(),
        })
        .unwrap();
        assert!(resp.events.is_empty());
    }

    #[test]
    fn run_creates_new_id() {
        let config = EvolutionConfig::default();
        let resp = cmd_run(&config).unwrap();
        assert!(!resp.new_run_id.is_empty());
        assert_eq!(resp.status, "created");
    }

    #[test]
    fn export_returns_path() {
        let store = EvolutionStore::open_memory().unwrap();
        let resp = cmd_export(&store, &ExportEvidenceRequest {
            run_id: "run-1".to_string(),
            format: Some("json".to_string()),
        })
        .unwrap();
        assert!(resp.path.contains("run-1"));
        assert_eq!(resp.format, "json");
    }

    #[test]
    fn format_json_output() {
        let data = serde_json::json!({"key": "value"});
        let output = format_output(&data, OutputFormat::Json);
        assert!(output.contains("\"key\""));
    }
}

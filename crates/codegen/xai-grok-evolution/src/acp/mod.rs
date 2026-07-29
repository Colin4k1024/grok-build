//! ACP (Agent Client Protocol) DTO definitions for evolution endpoints.
//!
//! Defines request/response types for the 7 evolution ACP endpoints
//! and 3 notification types. These types use `x.ai/evolution/*` method
//! names following the existing ACP extension pattern.
//!
//! ## Endpoints
//!
//! | Method | Direction | Description |
//! |--------|-----------|-------------|
//! | `x.ai/evolution/status` | client → agent | Current mode and state |
//! | `x.ai/evolution/list_runs` | client → agent | List evolution runs |
//! | `x.ai/evolution/inspect_run` | client → agent | Inspect a single run |
//! | `x.ai/evolution/lineage` | client → agent | Query experience lineage |
//! | `x.ai/evolution/set_mode` | client → agent | Switch evolution mode |
//! | `x.ai/evolution/retry_trial` | client → agent | Retry a failed trial |
//! | `x.ai/evolution/export_evidence` | client → agent | Export evidence bundle |
//!
//! ## Notifications
//!
//! | Method | Direction | Trigger |
//! |--------|-----------|---------|
//! | `EvolutionRunUpdated` | agent → client | Run state changed |
//! | `EvolutionModeChanged` | agent → client | Mode switched |
//! | `EvolutionCircuitBreakerTripped` | agent → client | Circuit breaker fired |

use serde::{Deserialize, Serialize};

use crate::config::EvolutionMode;
use crate::types::*;

// ---------------------------------------------------------------------------
// Method name constants
// ---------------------------------------------------------------------------

pub const METHOD_STATUS: &str = "x.ai/evolution/status";
pub const METHOD_LIST_RUNS: &str = "x.ai/evolution/list_runs";
pub const METHOD_INSPECT_RUN: &str = "x.ai/evolution/inspect_run";
pub const METHOD_LINEAGE: &str = "x.ai/evolution/lineage";
pub const METHOD_SET_MODE: &str = "x.ai/evolution/set_mode";
pub const METHOD_RETRY_TRIAL: &str = "x.ai/evolution/retry_trial";
pub const METHOD_EXPORT_EVIDENCE: &str = "x.ai/evolution/export_evidence";

pub const NOTIFY_RUN_UPDATED: &str = "x.ai/evolution/run_updated";
pub const NOTIFY_MODE_CHANGED: &str = "x.ai/evolution/mode_changed";
pub const NOTIFY_CIRCUIT_BREAKER: &str = "x.ai/evolution/circuit_breaker_tripped";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusRequest;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusResponse {
    pub mode: EvolutionMode,
    pub active_runs: u32,
    pub total_experiences: u32,
    pub active_experiences: u32,
    pub quarantined_experiences: u32,
    pub pending_signals: u32,
    pub circuit_breaker_state: String,
    pub rollout_approved: bool,
    pub rollout_approval_id: Option<String>,
}

// ---------------------------------------------------------------------------
// List Runs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListRunsRequest {
    #[serde(default)]
    pub state_filter: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListRunsResponse {
    pub runs: Vec<RunSummary>,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub state: RunState,
    pub trigger_type: TriggerType,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub signals_count: u32,
    pub outcome: Option<AdoptionDecision>,
}

// ---------------------------------------------------------------------------
// Inspect Run
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectRunRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectRunResponse {
    pub run: EvolutionRun,
    pub events: Vec<EventSummary>,
    pub experience: Option<ExperienceRevision>,
    pub trial_outcome: Option<TrialOutcome>,
    pub evidence: Option<EvidenceBundle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSummary {
    pub event_type: String,
    pub timestamp: i64,
    pub description: String,
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageRequest {
    pub experience_id: String,
    #[serde(default)]
    pub depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageResponse {
    pub nodes: Vec<LineageNode>,
    pub edges: Vec<LineageEdgeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageNode {
    pub experience_id: String,
    pub state: ExperienceState,
    pub confidence: f64,
    pub success_count: u32,
    pub failure_count: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageEdgeDto {
    pub parent_id: String,
    pub child_id: String,
    pub edge_type: LineageEdgeType,
}

// ---------------------------------------------------------------------------
// Set Mode
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetModeRequest {
    pub target_mode: EvolutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetModeResponse {
    pub previous_mode: EvolutionMode,
    pub new_mode: EvolutionMode,
    pub preflight_passed: bool,
    pub failure_reasons: Vec<String>,
}

// ---------------------------------------------------------------------------
// Retry Trial
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryTrialRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryTrialResponse {
    pub new_run_id: String,
    pub status: String,
}

// ---------------------------------------------------------------------------
// Export Evidence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportEvidenceRequest {
    pub run_id: String,
    #[serde(default)]
    pub format: Option<String>, // "json" | "tar.gz"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportEvidenceResponse {
    pub path: String,
    pub size_bytes: u64,
    pub format: String,
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunUpdatedNotification {
    pub run_id: String,
    pub new_state: RunState,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeChangedNotification {
    pub previous_mode: EvolutionMode,
    pub new_mode: EvolutionMode,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerTrippedNotification {
    pub reason: String,
    pub affected_experience_id: Option<String>,
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_request_serializes() {
        let req = StatusRequest;
        let json = serde_json::to_string(&req).unwrap();
        let _: StatusRequest = serde_json::from_str(&json).unwrap();
    }

    #[test]
    fn status_response_serializes() {
        let resp = StatusResponse {
            mode: EvolutionMode::Shadow,
            active_runs: 1,
            total_experiences: 10,
            active_experiences: 5,
            quarantined_experiences: 2,
            pending_signals: 3,
            circuit_breaker_state: "closed".to_string(),
            rollout_approved: false,
            rollout_approval_id: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: StatusResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.mode, EvolutionMode::Shadow);
        assert_eq!(parsed.active_experiences, 5);
    }

    #[test]
    fn list_runs_with_filters() {
        let req = ListRunsRequest {
            state_filter: Some("running".to_string()),
            limit: Some(10),
            offset: Some(0),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("running"));
    }

    #[test]
    fn set_mode_request_roundtrip() {
        let req = SetModeRequest {
            target_mode: EvolutionMode::IsolatedAutonomous,
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SetModeRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.target_mode, EvolutionMode::IsolatedAutonomous);
    }

    #[test]
    fn notification_serialization() {
        let notifications: Vec<serde_json::Value> = vec![
            serde_json::to_value(RunUpdatedNotification {
                run_id: "r1".to_string(),
                new_state: RunState::Completed,
                timestamp: 1000,
            })
            .unwrap(),
            serde_json::to_value(ModeChangedNotification {
                previous_mode: EvolutionMode::Off,
                new_mode: EvolutionMode::Shadow,
                timestamp: 1000,
            })
            .unwrap(),
            serde_json::to_value(CircuitBreakerTrippedNotification {
                reason: "too many failures".to_string(),
                affected_experience_id: Some("exp-1".to_string()),
                timestamp: 1000,
            })
            .unwrap(),
        ];
        assert_eq!(notifications.len(), 3);
    }

    #[test]
    fn all_method_names_are_x_ai_prefixed() {
        let methods = [
            METHOD_STATUS,
            METHOD_LIST_RUNS,
            METHOD_INSPECT_RUN,
            METHOD_LINEAGE,
            METHOD_SET_MODE,
            METHOD_RETRY_TRIAL,
            METHOD_EXPORT_EVIDENCE,
        ];
        for m in methods {
            assert!(
                m.starts_with("x.ai/evolution/"),
                "method {} missing prefix",
                m
            );
        }
    }
}

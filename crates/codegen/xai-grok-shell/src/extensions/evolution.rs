//! ACP adapter for the workspace-scoped evolution service.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol as acp;
use agent_client_protocol::Client as _;
use xai_grok_evolution::acp::*;

use crate::agent::MvpAgent;
use crate::extensions::{ExtResult, to_raw_response};

fn params_value(args: &acp::ExtRequest) -> Result<serde_json::Value, acp::Error> {
    serde_json::from_str(args.params.get())
        .map_err(|error| acp::Error::invalid_params().data(error.to_string()))
}

struct SelectedEvolution {
    service_slot: crate::session::handle::EvolutionServiceSlot,
    workspace: PathBuf,
    cmd_tx: tokio::sync::mpsc::UnboundedSender<crate::session::SessionCommand>,
}

impl SelectedEvolution {
    fn service(&self) -> Option<Arc<xai_grok_evolution::EvolutionService>> {
        self.service_slot.read().clone()
    }
}

fn selected_evolution(
    agent: &MvpAgent,
    params: &serde_json::Value,
) -> Result<Option<SelectedEvolution>, acp::Error> {
    let session_id = params
        .get("sessionId")
        .or_else(|| params.get("session_id"))
        .and_then(serde_json::Value::as_str);
    let to_selected = |handle: &crate::session::handle::SessionHandle| SelectedEvolution {
        service_slot: handle.evolution_service.clone(),
        workspace: PathBuf::from(&handle.info.cwd),
        cmd_tx: handle.cmd_tx.clone(),
    };
    if let Some(session_id) = session_id {
        let handle = agent
            .resident_handle(&acp::SessionId::new(session_id.to_owned()))
            .ok_or_else(|| acp::Error::invalid_params().data("unknown evolution session"))?;
        return Ok(Some(to_selected(&handle)));
    }
    // No explicit sessionId: unambiguous only when exactly one session is resident.
    let mut residents = Vec::new();
    agent.for_each_resident(|_, handle| residents.push(to_selected(handle)));
    match residents.len() {
        0 => Ok(None),
        1 => Ok(residents.pop()),
        _ => Err(acp::Error::invalid_params()
            .data("sessionId is required when multiple sessions are resident")),
    }
}

fn service_required(
    service: Option<Arc<xai_grok_evolution::EvolutionService>>,
) -> Result<Arc<xai_grok_evolution::EvolutionService>, acp::Error> {
    service.ok_or_else(|| {
        acp::Error::invalid_request()
            .data("evolution is Off for this workspace; enable Shadow before using this endpoint")
    })
}

pub async fn handle(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let params = params_value(args)?;
    let selected = selected_evolution(agent, &params)?;
    let service = selected.as_ref().and_then(SelectedEvolution::service);
    match args.method.as_ref() {
        METHOD_STATUS => {
            let status = match service {
                Some(service) => service
                    .status()
                    .map_err(|error| acp::Error::internal_error().data(error.to_string()))?,
                None => StatusResponse {
                    mode: xai_grok_evolution::EvolutionMode::Off,
                    active_runs: 0,
                    total_experiences: 0,
                    active_experiences: 0,
                    quarantined_experiences: 0,
                    pending_signals: 0,
                    circuit_breaker_state: "closed".to_string(),
                    rollout_approved: false,
                    rollout_approval_id: None,
                },
            };
            to_raw_response(&status)
        }
        METHOD_LIST_RUNS => {
            let service = service_required(service)?;
            let request: ListRunsRequest = serde_json::from_value(params)
                .map_err(|error| acp::Error::invalid_params().data(error.to_string()))?;
            let limit = request.limit.unwrap_or(20).min(200);
            let offset = request.offset.unwrap_or(0);
            let runs = service
                .list_runs(request.state_filter.as_deref(), limit, offset)
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
            let total = service
                .store()
                .count_runs(request.state_filter.as_deref())
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
            to_raw_response(&ListRunsResponse { runs, total })
        }
        METHOD_INSPECT_RUN => {
            let service = service_required(service)?;
            let request: InspectRunRequest = serde_json::from_value(params)
                .map_err(|error| acp::Error::invalid_params().data(error.to_string()))?;
            let (run, events, evidence) = service
                .inspect_run(&request.run_id)
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
            let stored = service
                .store()
                .events_for_run(&request.run_id)
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
            let experience = stored
                .iter()
                .filter_map(|event| event.decode().ok())
                .find_map(|event| match event {
                    xai_grok_evolution::EvolutionEvent::RevisionPublished { revision, .. } => {
                        Some(revision)
                    }
                    _ => None,
                });
            let trial_outcome = stored
                .iter()
                .filter_map(|event| event.decode().ok())
                .find_map(|event| match event {
                    xai_grok_evolution::EvolutionEvent::TrialCompleted { outcome, .. } => {
                        Some(outcome)
                    }
                    _ => None,
                });
            to_raw_response(&InspectRunResponse {
                run,
                events,
                experience,
                trial_outcome,
                evidence,
            })
        }
        METHOD_LINEAGE => {
            let service = service_required(service)?;
            let request: LineageRequest = serde_json::from_value(params)
                .map_err(|error| acp::Error::invalid_params().data(error.to_string()))?;
            let response = service
                .lineage(&request.experience_id, request.depth.unwrap_or(8))
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
            to_raw_response(&response)
        }
        METHOD_SET_MODE => {
            let confirmed = params
                .get("confirm")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let request: SetModeRequest = serde_json::from_value(params)
                .map_err(|error| acp::Error::invalid_params().data(error.to_string()))?;
            let selected = selected.ok_or_else(|| {
                acp::Error::invalid_request().data("no resident session for evolution mode change")
            })?;
            let previous_mode = match &service {
                Some(service) => {
                    service
                        .config()
                        .map_err(|error| acp::Error::internal_error().data(error.to_string()))?
                        .mode
                }
                None => xai_grok_evolution::EvolutionMode::Off,
            };
            if request.target_mode.level() > previous_mode.level() && !confirmed {
                return Err(acp::Error::invalid_request()
                    .data("risk confirmation is required for evolution mode upgrades"));
            }
            let new_mode = if let Some(service) = service {
                let new_mode = service
                    .set_mode(request.target_mode, None)
                    .map_err(|error| acp::Error::invalid_request().data(error.to_string()))?;
                if new_mode == xai_grok_evolution::EvolutionMode::Off {
                    service.shutdown();
                    selected.service_slot.write().take();
                }
                new_mode
            } else if request.target_mode == xai_grok_evolution::EvolutionMode::Off {
                xai_grok_evolution::EvolutionMode::Off
            } else if request.target_mode == xai_grok_evolution::EvolutionMode::Shadow {
                let config = xai_grok_evolution::EvolutionConfig {
                    mode: xai_grok_evolution::EvolutionMode::Shadow,
                    ..xai_grok_evolution::EvolutionConfig::default()
                };
                let memory_root = crate::util::grok_home::grok_home().join("memory");
                let ports = crate::session::evolution::build_evolution_ports(
                    selected.cmd_tx.clone(),
                    &selected.workspace,
                    &memory_root,
                    config.budget.max_duration_secs,
                )
                .ok();
                let service = xai_grok_evolution::EvolutionService::open_at_with_ports(
                    &selected.workspace,
                    &memory_root,
                    config,
                    ports,
                )
                .map_err(|error| acp::Error::invalid_request().data(error.to_string()))?;
                *selected.service_slot.write() = Some(Arc::new(service));
                xai_grok_evolution::EvolutionMode::Shadow
            } else {
                return Err(acp::Error::invalid_request()
                    .data("enable Shadow before requesting an autonomous evolution mode"));
            };
            let preflight = selected
                .service()
                .and_then(|service| service.last_preflight().ok().flatten());
            if let Ok(raw) = serde_json::value::to_raw_value(&ModeChangedNotification {
                previous_mode,
                new_mode,
                timestamp: chrono::Utc::now().timestamp(),
            }) {
                let _ = agent
                    .gateway
                    .ext_notification(acp::ExtNotification::new(NOTIFY_MODE_CHANGED, raw.into()))
                    .await;
            }
            to_raw_response(&SetModeResponse {
                previous_mode,
                new_mode,
                preflight_passed: preflight.as_ref().is_none_or(|result| result.all_passed()),
                failure_reasons: preflight
                    .map(|result| result.failure_reasons)
                    .unwrap_or_default(),
            })
        }
        METHOD_RETRY_TRIAL => {
            let service = service_required(service)?;
            let request: RetryTrialRequest = serde_json::from_value(params)
                .map_err(|error| acp::Error::invalid_params().data(error.to_string()))?;
            let result = service
                .retry_run(&request.run_id)
                .map_err(|error| acp::Error::invalid_request().data(error.to_string()))?;
            to_raw_response(&RetryTrialResponse {
                new_run_id: result.run_id,
                status: format!("{:?}", result.state).to_ascii_lowercase(),
            })
        }
        METHOD_EXPORT_EVIDENCE => {
            let service = service_required(service)?;
            let request: ExportEvidenceRequest = serde_json::from_value(params)
                .map_err(|error| acp::Error::invalid_params().data(error.to_string()))?;
            let format = request.format.unwrap_or_else(|| "json".to_string());
            if format != "json" {
                return Err(acp::Error::invalid_params()
                    .data("only scrubbed JSON evidence export is supported"));
            }
            let path = service
                .export_evidence_json(&request.run_id, &service.data_dir().join("exports"))
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?;
            let size_bytes = std::fs::metadata(&path)
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))?
                .len();
            to_raw_response(&ExportEvidenceResponse {
                path: path.to_string_lossy().into_owned(),
                size_bytes,
                format,
            })
        }
        _ => Err(acp::Error::method_not_found()),
    }
}

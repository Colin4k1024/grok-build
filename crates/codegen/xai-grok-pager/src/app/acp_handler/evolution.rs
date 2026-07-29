//! ACP handler for evolution endpoints.
//!
//! Handles `x.ai/evolution/*` extension requests and notifications.

use crate::app::app_view::AppView;
use crate::views::evolution_modal::EvolutionModalState;
use crate::views::modal::ActiveModal;
use agent_client_protocol as acp;
use xai_acp_lib::AcpArgs;

/// Handle `x.ai/evolution/status` blocking request.
pub fn handle_evolution_status(
    ext: AcpArgs<acp::ExtRequest>,
    _app: &mut AppView,
) -> bool {
    let response = serde_json::json!({
        "mode": "off",
        "active_runs": 0,
        "total_experiences": 0,
        "active_experiences": 0,
        "quarantined_experiences": 0,
        "pending_signals": 0,
        "circuit_breaker_state": "closed",
    });
    let raw = serde_json::value::to_raw_value(&response).unwrap_or_default();
    ext.response_tx.send(Ok(acp::ExtResponse::new(std::sync::Arc::from(raw)))).ok();
    true
}

/// Handle `x.ai/evolution/update` notification.
///
/// Updates the evolution modal state if it's currently open.
pub fn handle_evolution_update(
    notif: &acp::ExtNotification,
    app: &mut AppView,
) -> bool {
    // If the evolution modal is open, update its state
    if let crate::app::app_view::ActiveView::Agent(id) = app.active_view {
        if let Some(agent) = app.agents.get_mut(&id) {
            if let Some(ActiveModal::Evolution { ref mut state }) = agent.active_modal {
                // Parse the notification params and update state
                if let Ok(data) = serde_json::from_str::<EvolutionUpdateData>(notif.params.get()) {
                    state.mode_label = data.mode;
                    return true;
                }
            }
        }
    }
    false
}

/// Parsed evolution update notification data.
#[derive(serde::Deserialize)]
struct EvolutionUpdateData {
    mode: String,
}

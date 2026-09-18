//! ACP handler for evolution endpoints.
//!
//! Handles `x.ai/evolution/*` extension requests and notifications.

use crate::app::app_view::AppView;
use crate::views::modal::ActiveModal;
use agent_client_protocol as acp;

/// Handle `x.ai/evolution/update` notification.
///
/// Updates the evolution modal state if it's currently open.
pub fn handle_evolution_update(notif: &acp::ExtNotification, app: &mut AppView) -> bool {
    // If the evolution modal is open, update its state
    if let crate::app::app_view::ActiveView::Agent(id) = app.active_view {
        if let Some(agent) = app.agents.get_mut(&id) {
            if let Some(ActiveModal::Evolution { ref mut state }) = agent.active_modal {
                // Parse the notification params and update state
                if let Ok(data) = serde_json::from_str::<EvolutionUpdateData>(notif.params.get()) {
                    if let Some(mode) = data.new_mode.or(data.mode) {
                        state.mode_label = mode;
                    }
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
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    new_mode: Option<String>,
}

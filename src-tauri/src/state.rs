use std::sync::Arc;
use parking_lot::RwLock;

#[derive(Default)]
pub struct AppState {
    pub sessions: Arc<RwLock<Vec<crate::acp_bridge::SessionHandle>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}

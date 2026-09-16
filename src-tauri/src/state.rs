use crate::acp_bridge::SessionPool;

#[derive(Default)]
pub struct AppState {
    pub pool: SessionPool,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}

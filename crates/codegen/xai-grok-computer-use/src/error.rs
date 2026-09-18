#[derive(Debug, thiserror::Error)]
pub enum ComputerUseError {
    #[error("screenshot failed: {0}")]
    ScreenshotFailed(String),

    #[error("action failed: {0}")]
    ActionFailed(String),

    #[error("browser not available: {0}")]
    BrowserUnavailable(String),

    #[error("desktop API not available: {0}")]
    DesktopUnavailable(String),

    #[error("timeout after {0}ms")]
    Timeout(u64),

    #[error("invalid navigation URL: {0}")]
    InvalidUrl(String),

    #[error("CDP protocol error: {0}")]
    Protocol(String),

    #[error("coordinate out of bounds: ({x}, {y}) for screen {width}x{height}")]
    OutOfBounds {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

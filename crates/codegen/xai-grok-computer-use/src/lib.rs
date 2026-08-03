//! Computer Use capabilities for grok-build.
//!
//! Provides two backends:
//! - **Browser**: headless Chromium via CDP (Chrome DevTools Protocol)
//! - **Desktop**: native OS interaction (macOS: screencapture + AppleScript)
//!
//! Both return base64-encoded screenshots and accept coordinate-based actions.

pub mod browser;
pub mod desktop;
pub mod error;
pub mod types;

pub use error::ComputerUseError;
pub use types::{Action, Coordinate, ScreenSize, Screenshot};

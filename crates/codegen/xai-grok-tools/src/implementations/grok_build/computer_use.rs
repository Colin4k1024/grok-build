//! `ComputerUse` tool — bridge to the xai-grok-computer-use crate.
//!
//! Exposes screenshot, click, type, scroll, and navigate actions as a tool.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerUseInput {
    /// The action to perform.
    pub action: String,
    /// Coordinate for click/scroll/move actions.
    #[serde(default)]
    pub coordinate: Option<Coordinate>,
    /// Text for type action.
    #[serde(default)]
    pub text: Option<String>,
    /// Key name for key_press action.
    #[serde(default)]
    pub key: Option<String>,
    /// URL for navigate action.
    #[serde(default)]
    pub url: Option<String>,
    /// Scroll direction.
    #[serde(default)]
    pub direction: Option<String>,
    /// Scroll amount.
    #[serde(default)]
    pub amount: Option<u32>,
    /// Wait duration in ms.
    #[serde(default)]
    pub ms: Option<u64>,
    /// Mouse button (left/right/middle).
    #[serde(default)]
    pub button: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coordinate {
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerUseOutput {
    pub success: bool,
    /// Base64 screenshot data (only for screenshot action).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    /// Screen dimensions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_size: Option<ScreenSize>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

/// Validate a computer-use action request.
pub fn validate(input: &ComputerUseInput) -> Result<(), String> {
    match input.action.as_str() {
        "screenshot" => Ok(()),
        "click" | "double_click" | "move_mouse" | "scroll" => {
            if input.coordinate.is_none() {
                return Err(format!("'coordinate' required for action '{}'", input.action));
            }
            if input.action == "scroll" && input.direction.is_none() {
                return Err("'direction' required for scroll action".to_string());
            }
            Ok(())
        }
        "type" => {
            if input.text.is_none() {
                return Err("'text' required for type action".to_string());
            }
            Ok(())
        }
        "key_press" => {
            if input.key.is_none() {
                return Err("'key' required for key_press action".to_string());
            }
            Ok(())
        }
        "navigate" => {
            if input.url.is_none() {
                return Err("'url' required for navigate action".to_string());
            }
            Ok(())
        }
        "wait" => {
            if input.ms.is_none() {
                return Err("'ms' required for wait action".to_string());
            }
            Ok(())
        }
        other => Err(format!("unknown action: '{other}'. Valid: screenshot, click, double_click, type, key_press, scroll, move_mouse, navigate, wait")),
    }
}

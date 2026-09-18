use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Coordinate {
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Screenshot {
    pub data_base64: String,
    pub size: ScreenSize,
    pub format: ImageFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    /// Report whether the configured backend is usable without performing input.
    CapabilityStatus,
    Screenshot,
    Click {
        coordinate: Coordinate,
        #[serde(default)]
        button: MouseButton,
    },
    DoubleClick {
        coordinate: Coordinate,
    },
    Type {
        text: String,
    },
    KeyPress {
        key: String,
    },
    Scroll {
        coordinate: Coordinate,
        direction: ScrollDirection,
        #[serde(default = "default_scroll_amount")]
        amount: u32,
    },
    MoveMouse {
        coordinate: Coordinate,
    },
    Navigate {
        url: String,
    },
    Wait {
        ms: u64,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

fn default_scroll_amount() -> u32 {
    3
}

//! Desktop backend: native OS interaction for screenshot + input simulation.
//!
//! macOS: screencapture + cliclick/AppleScript
//! Linux: scrot/gnome-screenshot + xdotool

use std::path::Path;
use std::process::Command;

use crate::error::ComputerUseError;
use crate::types::{Action, Coordinate, ImageFormat, ScreenSize, Screenshot};

pub struct DesktopBackend {
    screen_size: ScreenSize,
}

impl DesktopBackend {
    pub fn new() -> Result<Self, ComputerUseError> {
        let screen_size = detect_screen_size()?;
        Ok(Self { screen_size })
    }

    pub fn screen_size(&self) -> &ScreenSize {
        &self.screen_size
    }

    pub async fn execute(&self, action: &Action) -> Result<Option<Screenshot>, ComputerUseError> {
        match action {
            Action::Screenshot => self.screenshot().await.map(Some),
            Action::Click { coordinate, button } => {
                self.validate_coordinate(coordinate)?;
                click(coordinate, *button).await?;
                Ok(None)
            }
            Action::DoubleClick { coordinate } => {
                self.validate_coordinate(coordinate)?;
                double_click(coordinate).await?;
                Ok(None)
            }
            Action::Type { text } => {
                type_text(text).await?;
                Ok(None)
            }
            Action::KeyPress { key } => {
                key_press(key).await?;
                Ok(None)
            }
            Action::Scroll {
                coordinate,
                direction,
                amount,
            } => {
                self.validate_coordinate(coordinate)?;
                scroll(coordinate, *direction, *amount).await?;
                Ok(None)
            }
            Action::MoveMouse { coordinate } => {
                self.validate_coordinate(coordinate)?;
                move_mouse(coordinate).await?;
                Ok(None)
            }
            Action::Wait { ms } => {
                tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
                Ok(None)
            }
            Action::Navigate { .. } => Err(ComputerUseError::ActionFailed(
                "navigate is only supported in browser mode".to_string(),
            )),
        }
    }

    async fn screenshot(&self) -> Result<Screenshot, ComputerUseError> {
        let tmp = std::env::temp_dir().join(format!("grok-screenshot-{}.png", std::process::id()));
        capture_screen(&tmp).await?;
        let data = tokio::fs::read(&tmp).await?;
        let _ = tokio::fs::remove_file(&tmp).await;
        Ok(Screenshot {
            data_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data),
            size: self.screen_size.clone(),
            format: ImageFormat::Png,
        })
    }

    fn validate_coordinate(&self, coord: &Coordinate) -> Result<(), ComputerUseError> {
        if coord.x >= self.screen_size.width || coord.y >= self.screen_size.height {
            return Err(ComputerUseError::OutOfBounds {
                x: coord.x,
                y: coord.y,
                width: self.screen_size.width,
                height: self.screen_size.height,
            });
        }
        Ok(())
    }
}

fn detect_screen_size() -> Result<ScreenSize, ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("system_profiler")
            .args(["SPDisplaysDataType", "-json"])
            .output()
            .map_err(|e| ComputerUseError::DesktopUnavailable(format!("system_profiler: {e}")))?;
        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| ComputerUseError::DesktopUnavailable(format!("parse display info: {e}")))?;
        if let Some(resolution) = json
            .pointer("/SPDisplaysDataType/0/spdisplays_ndrvs/0/_spdisplays_resolution")
            .and_then(|v| v.as_str())
        {
            let parts: Vec<&str> = resolution.split(" x ").collect();
            if parts.len() == 2 {
                let width = parts[0].trim().parse().unwrap_or(1920);
                let height = parts[1].trim().split(' ').next().unwrap_or("1080").parse().unwrap_or(1080);
                return Ok(ScreenSize { width, height });
            }
        }
        Ok(ScreenSize {
            width: 1920,
            height: 1080,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let output = Command::new("xdpyinfo")
            .output()
            .map_err(|e| ComputerUseError::DesktopUnavailable(format!("xdpyinfo: {e}")))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("dimensions:") {
                if let Some(dim) = line.split_whitespace().nth(1) {
                    let parts: Vec<&str> = dim.split('x').collect();
                    if parts.len() == 2 {
                        let width = parts[0].parse().unwrap_or(1920);
                        let height = parts[1].parse().unwrap_or(1080);
                        return Ok(ScreenSize { width, height });
                    }
                }
            }
        }
        Ok(ScreenSize { width: 1920, height: 1080 })
    }
}

async fn capture_screen(output_path: &Path) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("screencapture")
            .args(["-x", "-C", &output_path.to_string_lossy()])
            .status()
            .await?;
        if !status.success() {
            return Err(ComputerUseError::ScreenshotFailed(
                "screencapture returned non-zero".to_string(),
            ));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let status = tokio::process::Command::new("scrot")
            .args([&output_path.to_string_lossy()])
            .status()
            .await?;
        if !status.success() {
            return Err(ComputerUseError::ScreenshotFailed(
                "scrot returned non-zero".to_string(),
            ));
        }
    }
    Ok(())
}

async fn click(coord: &Coordinate, button: crate::types::MouseButton) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let btn = match button {
            crate::types::MouseButton::Left => "1",
            crate::types::MouseButton::Right => "2",
            crate::types::MouseButton::Middle => "3",
        };
        let script = format!(
            r#"tell application "System Events" to click at {{{}, {}}}"#,
            coord.x, coord.y
        );
        // Use cliclick if available (more reliable), fallback to AppleScript
        let status = tokio::process::Command::new("cliclick")
            .args([&format!("c:{},{}", coord.x, coord.y)])
            .status()
            .await
            .or_else(|_| {
                std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .status()
                    .map(|s| s.into())
            })
            .map_err(|e| ComputerUseError::ActionFailed(format!("click: {e}")))?;
        let _ = (btn, status);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let btn = match button {
            crate::types::MouseButton::Left => "1",
            crate::types::MouseButton::Right => "3",
            crate::types::MouseButton::Middle => "2",
        };
        tokio::process::Command::new("xdotool")
            .args(["mousemove", &coord.x.to_string(), &coord.y.to_string(), "click", btn])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool click: {e}")))?;
    }
    Ok(())
}

async fn double_click(coord: &Coordinate) -> Result<(), ComputerUseError> {
    click(coord, crate::types::MouseButton::Left).await?;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    click(coord, crate::types::MouseButton::Left).await
}

async fn type_text(text: &str) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("cliclick")
            .args([&format!("t:{text}")])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("type: {e}")))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        tokio::process::Command::new("xdotool")
            .args(["type", "--clearmodifiers", text])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool type: {e}")))?;
    }
    Ok(())
}

async fn key_press(key: &str) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("cliclick")
            .args([&format!("kp:{key}")])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("key_press: {e}")))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        tokio::process::Command::new("xdotool")
            .args(["key", key])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool key: {e}")))?;
    }
    Ok(())
}

async fn scroll(
    coord: &Coordinate,
    direction: crate::types::ScrollDirection,
    amount: u32,
) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let delta = match direction {
            crate::types::ScrollDirection::Up => format!("{}:0", amount),
            crate::types::ScrollDirection::Down => format!("-{}:0", amount),
            crate::types::ScrollDirection::Left => format!("0:{}", amount),
            crate::types::ScrollDirection::Right => format!("0:-{}", amount),
        };
        let _ = coord; // cliclick scroll is global
        tokio::process::Command::new("cliclick")
            .args([&format!("sc:{delta}")])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("scroll: {e}")))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let btn = match direction {
            crate::types::ScrollDirection::Up => "4",
            crate::types::ScrollDirection::Down => "5",
            crate::types::ScrollDirection::Left => "6",
            crate::types::ScrollDirection::Right => "7",
        };
        move_mouse(coord).await?;
        for _ in 0..amount {
            tokio::process::Command::new("xdotool")
                .args(["click", btn])
                .status()
                .await
                .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool scroll: {e}")))?;
        }
    }
    Ok(())
}

async fn move_mouse(coord: &Coordinate) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("cliclick")
            .args([&format!("m:{},{}", coord.x, coord.y)])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("move: {e}")))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        tokio::process::Command::new("xdotool")
            .args(["mousemove", &coord.x.to_string(), &coord.y.to_string()])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool mousemove: {e}")))?;
    }
    Ok(())
}

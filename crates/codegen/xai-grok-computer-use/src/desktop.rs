//! Desktop backend: native OS interaction for screenshot + input simulation.
//!
//! macOS: screencapture + cliclick
//! Linux/X11: scrot + xdotool

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::ComputerUseError;
use crate::types::{Action, Coordinate, ImageFormat, ScreenSize, Screenshot};

pub struct DesktopBackend {
    screen_size: ScreenSize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopCapability {
    pub available: bool,
    pub screen_size: Option<ScreenSize>,
    pub reason: Option<String>,
}

impl DesktopBackend {
    pub fn new() -> Result<Self, ComputerUseError> {
        verify_desktop_commands()?;
        let screen_size = detect_screen_size()?;
        Ok(Self { screen_size })
    }

    pub fn probe() -> DesktopCapability {
        match Self::new() {
            Ok(backend) => DesktopCapability {
                available: true,
                screen_size: Some(backend.screen_size),
                reason: None,
            },
            Err(error) => DesktopCapability {
                available: false,
                screen_size: None,
                reason: Some(error.to_string()),
            },
        }
    }

    pub fn screen_size(&self) -> &ScreenSize {
        &self.screen_size
    }

    pub async fn execute(&self, action: &Action) -> Result<Option<Screenshot>, ComputerUseError> {
        match action {
            Action::CapabilityStatus => Ok(None),
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
        let tmp = tempfile::Builder::new()
            .prefix("grok-screenshot-")
            .suffix(".png")
            .tempfile()
            .map_err(ComputerUseError::Io)?;
        capture_screen(tmp.path()).await?;
        let data = tokio::fs::read(tmp.path()).await?;
        if data.is_empty() {
            return Err(ComputerUseError::ScreenshotFailed(
                "desktop capture returned an empty image".to_owned(),
            ));
        }
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
        if !output.status.success() {
            return Err(ComputerUseError::DesktopUnavailable(format!(
                "system_profiler exited with {}",
                output.status
            )));
        }
        let json: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| {
            ComputerUseError::DesktopUnavailable(format!("parse display info: {e}"))
        })?;
        if let Some(resolution) = json
            .pointer("/SPDisplaysDataType/0/spdisplays_ndrvs/0/_spdisplays_resolution")
            .and_then(|v| v.as_str())
        {
            let parts: Vec<&str> = resolution.split(" x ").collect();
            if parts.len() == 2 {
                if let (Ok(width), Ok(height)) = (
                    parts[0].trim().parse(),
                    parts[1]
                        .trim()
                        .split(' ')
                        .next()
                        .unwrap_or_default()
                        .parse(),
                ) {
                    return Ok(ScreenSize { width, height });
                }
            }
        }
        Err(ComputerUseError::DesktopUnavailable(
            "could not determine the active display resolution".to_owned(),
        ))
    }
    #[cfg(target_os = "linux")]
    {
        let output = Command::new("xdpyinfo")
            .output()
            .map_err(|e| ComputerUseError::DesktopUnavailable(format!("xdpyinfo: {e}")))?;
        if !output.status.success() {
            return Err(ComputerUseError::DesktopUnavailable(format!(
                "xdpyinfo exited with {}",
                output.status
            )));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("dimensions:") {
                if let Some(dim) = line.split_whitespace().nth(1) {
                    let parts: Vec<&str> = dim.split('x').collect();
                    if parts.len() == 2 {
                        if let (Ok(width), Ok(height)) = (parts[0].parse(), parts[1].parse()) {
                            return Ok(ScreenSize { width, height });
                        }
                    }
                }
            }
        }
        Err(ComputerUseError::DesktopUnavailable(
            "xdpyinfo did not report display dimensions".to_owned(),
        ))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(ComputerUseError::DesktopUnavailable(
            "desktop control is only implemented for macOS and Linux/X11".to_owned(),
        ))
    }
}

fn verify_desktop_commands() -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        for command in ["screencapture", "system_profiler", "cliclick"] {
            if executable_on_path(command).is_none() {
                return Err(ComputerUseError::DesktopUnavailable(format!(
                    "required command not found: {command}"
                )));
            }
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("DISPLAY").is_none() {
            return Err(ComputerUseError::DesktopUnavailable(
                "DISPLAY is not set; only X11 desktop control is supported".to_owned(),
            ));
        }
        for command in ["xdpyinfo", "xdotool", "scrot"] {
            if executable_on_path(command).is_none() {
                return Err(ComputerUseError::DesktopUnavailable(format!(
                    "required command not found: {command}"
                )));
            }
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(ComputerUseError::DesktopUnavailable(
            "desktop control is only implemented for macOS and Linux/X11".to_owned(),
        ))
    }
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    let fixed = [
        PathBuf::from("/usr/bin").join(name),
        PathBuf::from("/usr/sbin").join(name),
    ];
    fixed
        .into_iter()
        .chain(
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
                .map(|directory| directory.join(name)),
        )
        .find(|path| path.metadata().is_ok_and(|metadata| metadata.is_file()))
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
    #[cfg(target_os = "linux")]
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

async fn click(
    coord: &Coordinate,
    button: crate::types::MouseButton,
) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let command = match button {
            crate::types::MouseButton::Left => "c",
            crate::types::MouseButton::Right => "rc",
            crate::types::MouseButton::Middle => "mc",
        };
        let status = tokio::process::Command::new("cliclick")
            .args([&format!("{command}:{},{}", coord.x, coord.y)])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("click: {e}")))?;
        ensure_success(status, "cliclick click")?;
    }
    #[cfg(target_os = "linux")]
    {
        let btn = match button {
            crate::types::MouseButton::Left => "1",
            crate::types::MouseButton::Right => "3",
            crate::types::MouseButton::Middle => "2",
        };
        let status = tokio::process::Command::new("xdotool")
            .args([
                "mousemove",
                &coord.x.to_string(),
                &coord.y.to_string(),
                "click",
                btn,
            ])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool click: {e}")))?;
        ensure_success(status, "xdotool click")?;
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
        let status = tokio::process::Command::new("cliclick")
            .args([&format!("t:{text}")])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("type: {e}")))?;
        ensure_success(status, "cliclick type")?;
    }
    #[cfg(target_os = "linux")]
    {
        let status = tokio::process::Command::new("xdotool")
            .args(["type", "--clearmodifiers", text])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool type: {e}")))?;
        ensure_success(status, "xdotool type")?;
    }
    Ok(())
}

async fn key_press(key: &str) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("cliclick")
            .args([&format!("kp:{key}")])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("key_press: {e}")))?;
        ensure_success(status, "cliclick key press")?;
    }
    #[cfg(target_os = "linux")]
    {
        let status = tokio::process::Command::new("xdotool")
            .args(["key", key])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool key: {e}")))?;
        ensure_success(status, "xdotool key press")?;
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
        let status = tokio::process::Command::new("cliclick")
            .args([&format!("sc:{delta}")])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("scroll: {e}")))?;
        ensure_success(status, "cliclick scroll")?;
    }
    #[cfg(target_os = "linux")]
    {
        let btn = match direction {
            crate::types::ScrollDirection::Up => "4",
            crate::types::ScrollDirection::Down => "5",
            crate::types::ScrollDirection::Left => "6",
            crate::types::ScrollDirection::Right => "7",
        };
        move_mouse(coord).await?;
        for _ in 0..amount {
            let status = tokio::process::Command::new("xdotool")
                .args(["click", btn])
                .status()
                .await
                .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool scroll: {e}")))?;
            ensure_success(status, "xdotool scroll")?;
        }
    }
    Ok(())
}

async fn move_mouse(coord: &Coordinate) -> Result<(), ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("cliclick")
            .args([&format!("m:{},{}", coord.x, coord.y)])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("move: {e}")))?;
        ensure_success(status, "cliclick move")?;
    }
    #[cfg(target_os = "linux")]
    {
        let status = tokio::process::Command::new("xdotool")
            .args(["mousemove", &coord.x.to_string(), &coord.y.to_string()])
            .status()
            .await
            .map_err(|e| ComputerUseError::ActionFailed(format!("xdotool mousemove: {e}")))?;
        ensure_success(status, "xdotool mouse move")?;
    }
    Ok(())
}

fn ensure_success(status: std::process::ExitStatus, action: &str) -> Result<(), ComputerUseError> {
    if status.success() {
        Ok(())
    } else {
        Err(ComputerUseError::ActionFailed(format!(
            "{action} exited with {status}"
        )))
    }
}

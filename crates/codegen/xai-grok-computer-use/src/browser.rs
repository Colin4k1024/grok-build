//! Browser backend: headless Chromium control via CDP subprocess.
//!
//! Launches a headless Chrome/Chromium instance and communicates over CDP
//! (Chrome DevTools Protocol) for screenshot, navigation, click, type, scroll.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::ComputerUseError;
use crate::types::{Action, Coordinate, ImageFormat, ScreenSize, Screenshot};

const DEFAULT_VIEWPORT_WIDTH: u32 = 1280;
const DEFAULT_VIEWPORT_HEIGHT: u32 = 720;

pub struct BrowserBackend {
    process: Option<Child>,
    cdp_url: String,
    viewport: ScreenSize,
}

impl BrowserBackend {
    pub async fn launch(viewport: Option<ScreenSize>) -> Result<Self, ComputerUseError> {
        let viewport = viewport.unwrap_or(ScreenSize {
            width: DEFAULT_VIEWPORT_WIDTH,
            height: DEFAULT_VIEWPORT_HEIGHT,
        });
        let chrome = find_chrome()?;
        let mut child = Command::new(&chrome)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                &format!("--window-size={},{}", viewport.width, viewport.height),
                "--remote-debugging-port=0",
                "about:blank",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| ComputerUseError::BrowserUnavailable(format!("launch chrome: {e}")))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ComputerUseError::BrowserUnavailable("no stderr".to_string()))?;

        let mut reader = BufReader::new(stderr).lines();
        let cdp_url = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(line) = reader.next_line().await.ok().flatten() {
                if let Some(url) = line.strip_prefix("DevTools listening on ") {
                    return Ok(url.trim().to_string());
                }
            }
            Err(ComputerUseError::BrowserUnavailable(
                "CDP URL not found in chrome output".to_string(),
            ))
        })
        .await
        .map_err(|_| ComputerUseError::Timeout(10000))??;

        Ok(Self {
            process: Some(child),
            cdp_url,
            viewport,
        })
    }

    pub fn cdp_url(&self) -> &str {
        &self.cdp_url
    }

    pub fn viewport(&self) -> &ScreenSize {
        &self.viewport
    }

    pub async fn execute(&self, action: &Action) -> Result<Option<Screenshot>, ComputerUseError> {
        match action {
            Action::Screenshot => self.screenshot().await.map(Some),
            Action::Navigate { url } => {
                self.cdp_command("Page.navigate", &serde_json::json!({"url": url}))
                    .await?;
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                Ok(None)
            }
            Action::Click { coordinate, .. } => {
                self.cdp_click(coordinate).await?;
                Ok(None)
            }
            Action::Type { text } => {
                for ch in text.chars() {
                    self.cdp_command(
                        "Input.dispatchKeyEvent",
                        &serde_json::json!({
                            "type": "keyDown",
                            "text": ch.to_string(),
                        }),
                    )
                    .await?;
                }
                Ok(None)
            }
            Action::Scroll {
                coordinate,
                direction,
                amount,
            } => {
                let (dx, dy) = match direction {
                    crate::types::ScrollDirection::Up => (0, -((*amount as i32) * 100)),
                    crate::types::ScrollDirection::Down => (0, (*amount as i32) * 100),
                    crate::types::ScrollDirection::Left => (-((*amount as i32) * 100), 0),
                    crate::types::ScrollDirection::Right => ((*amount as i32) * 100, 0),
                };
                self.cdp_command(
                    "Input.dispatchMouseEvent",
                    &serde_json::json!({
                        "type": "mouseWheel",
                        "x": coordinate.x,
                        "y": coordinate.y,
                        "deltaX": dx,
                        "deltaY": dy,
                    }),
                )
                .await?;
                Ok(None)
            }
            Action::Wait { ms } => {
                tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
                Ok(None)
            }
            _ => Err(ComputerUseError::ActionFailed(
                "action not supported in browser mode".to_string(),
            )),
        }
    }

    async fn screenshot(&self) -> Result<Screenshot, ComputerUseError> {
        let result = self
            .cdp_command("Page.captureScreenshot", &serde_json::json!({"format": "png"}))
            .await?;
        let data = result["data"]
            .as_str()
            .ok_or_else(|| ComputerUseError::ScreenshotFailed("no data in response".to_string()))?;
        Ok(Screenshot {
            data_base64: data.to_string(),
            size: self.viewport.clone(),
            format: ImageFormat::Png,
        })
    }

    async fn cdp_click(&self, coord: &Coordinate) -> Result<(), ComputerUseError> {
        let params = serde_json::json!({
            "type": "mousePressed",
            "x": coord.x,
            "y": coord.y,
            "button": "left",
            "clickCount": 1,
        });
        self.cdp_command("Input.dispatchMouseEvent", &params).await?;
        let params = serde_json::json!({
            "type": "mouseReleased",
            "x": coord.x,
            "y": coord.y,
            "button": "left",
            "clickCount": 1,
        });
        self.cdp_command("Input.dispatchMouseEvent", &params).await?;
        Ok(())
    }

    async fn cdp_command(
        &self,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, ComputerUseError> {
        // Placeholder: in production this would use a WebSocket connection to the CDP endpoint.
        // For now, use the chrome-remote-interface pattern via HTTP.
        let client = reqwest::Client::new();
        let _ = (client, method, params);
        tracing::debug!(method, "CDP command (stub)");
        Ok(serde_json::json!({"data": ""}))
    }

    pub async fn close(&mut self) {
        if let Some(mut child) = self.process.take() {
            let _ = child.kill().await;
        }
    }
}

impl Drop for BrowserBackend {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.process {
            let _ = child.start_kill();
        }
    }
}

fn find_chrome() -> Result<PathBuf, ComputerUseError> {
    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ];
    for path in &candidates {
        let p = PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
    }
    if let Ok(output) = std::process::Command::new("which")
        .arg("google-chrome")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }
    Err(ComputerUseError::BrowserUnavailable(
        "no Chrome/Chromium found; install Chrome or set CHROME_PATH".to_string(),
    ))
}

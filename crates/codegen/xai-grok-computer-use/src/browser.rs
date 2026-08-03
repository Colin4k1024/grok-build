//! Browser backend: isolated headless Chromium controlled through real CDP.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::Message;

use crate::error::ComputerUseError;
use crate::types::{
    Action, Coordinate, ImageFormat, MouseButton, ScreenSize, Screenshot, ScrollDirection,
};

const DEFAULT_VIEWPORT_WIDTH: u32 = 1280;
const DEFAULT_VIEWPORT_HEIGHT: u32 = 720;
const CDP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserCapability {
    pub available: bool,
    pub executable: Option<PathBuf>,
    pub reason: Option<String>,
}

pub struct BrowserBackend {
    process: Option<Child>,
    browser_cdp_url: String,
    page_cdp_url: String,
    viewport: ScreenSize,
    // Chrome must not inherit or mutate the user's normal browser profile.
    _profile: tempfile::TempDir,
}

impl BrowserBackend {
    pub fn probe() -> BrowserCapability {
        match find_chrome() {
            Ok(executable) => BrowserCapability {
                available: true,
                executable: Some(executable),
                reason: None,
            },
            Err(error) => BrowserCapability {
                available: false,
                executable: None,
                reason: Some(error.to_string()),
            },
        }
    }

    pub async fn launch(viewport: Option<ScreenSize>) -> Result<Self, ComputerUseError> {
        let viewport = viewport.unwrap_or(ScreenSize {
            width: DEFAULT_VIEWPORT_WIDTH,
            height: DEFAULT_VIEWPORT_HEIGHT,
        });
        if viewport.width == 0 || viewport.height == 0 {
            return Err(ComputerUseError::BrowserUnavailable(
                "viewport dimensions must be greater than zero".to_owned(),
            ));
        }
        let chrome = find_chrome()?;
        let profile = tempfile::Builder::new()
            .prefix("grok-computer-use-")
            .tempdir()
            .map_err(|error| {
                ComputerUseError::BrowserUnavailable(format!(
                    "create isolated Chrome profile: {error}"
                ))
            })?;
        let window_size = format!("--window-size={},{}", viewport.width, viewport.height);
        let user_data_dir = format!("--user-data-dir={}", profile.path().display());
        let mut command = Command::new(&chrome);
        command
            .kill_on_drop(true)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                &window_size,
                &user_data_dir,
                "--remote-debugging-port=0",
                "about:blank",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            ComputerUseError::BrowserUnavailable(format!("launch Chrome: {error}"))
        })?;

        let stderr = child.stderr.take().ok_or_else(|| {
            ComputerUseError::BrowserUnavailable("Chrome stderr was not captured".to_owned())
        })?;
        let mut lines = BufReader::new(stderr).lines();
        let browser_cdp_url = tokio::time::timeout(CDP_TIMEOUT, async {
            while let Some(line) = lines.next_line().await.map_err(ComputerUseError::Io)? {
                if let Some(url) = line.strip_prefix("DevTools listening on ") {
                    return Ok(url.trim().to_owned());
                }
            }
            Err(ComputerUseError::BrowserUnavailable(
                "Chrome exited before publishing a CDP endpoint".to_owned(),
            ))
        })
        .await
        .map_err(|_| ComputerUseError::Timeout(CDP_TIMEOUT.as_millis() as u64))??;
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

        let page_cdp_url = match discover_page_endpoint(&browser_cdp_url).await {
            Ok(url) => url,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error);
            }
        };
        Ok(Self {
            process: Some(child),
            browser_cdp_url,
            page_cdp_url,
            viewport,
            _profile: profile,
        })
    }

    pub fn cdp_url(&self) -> &str {
        &self.browser_cdp_url
    }

    pub fn viewport(&self) -> &ScreenSize {
        &self.viewport
    }

    pub async fn execute(&self, action: &Action) -> Result<Option<Screenshot>, ComputerUseError> {
        match action {
            Action::CapabilityStatus => Ok(None),
            Action::Screenshot => self.screenshot().await.map(Some),
            Action::Navigate { url } => {
                validate_navigation_url(url)?;
                let result = self
                    .cdp_command("Page.navigate", &serde_json::json!({"url": url}))
                    .await?;
                if let Some(error) = result.get("errorText").and_then(serde_json::Value::as_str) {
                    return Err(ComputerUseError::ActionFailed(format!(
                        "navigation failed: {error}"
                    )));
                }
                self.wait_until_ready().await?;
                Ok(None)
            }
            Action::Click { coordinate, button } => {
                self.validate_coordinate(coordinate)?;
                self.cdp_click(coordinate, *button, 1).await?;
                Ok(None)
            }
            Action::DoubleClick { coordinate } => {
                self.validate_coordinate(coordinate)?;
                self.cdp_click(coordinate, MouseButton::Left, 2).await?;
                Ok(None)
            }
            Action::Type { text } => {
                self.cdp_command("Input.insertText", &serde_json::json!({"text": text}))
                    .await?;
                Ok(None)
            }
            Action::KeyPress { key } => {
                self.cdp_command(
                    "Input.dispatchKeyEvent",
                    &serde_json::json!({"type": "keyDown", "key": key}),
                )
                .await?;
                self.cdp_command(
                    "Input.dispatchKeyEvent",
                    &serde_json::json!({"type": "keyUp", "key": key}),
                )
                .await?;
                Ok(None)
            }
            Action::Scroll {
                coordinate,
                direction,
                amount,
            } => {
                self.validate_coordinate(coordinate)?;
                let pixels = amount.saturating_mul(100).min(i32::MAX as u32) as i32;
                let (delta_x, delta_y) = match direction {
                    ScrollDirection::Up => (0, -pixels),
                    ScrollDirection::Down => (0, pixels),
                    ScrollDirection::Left => (-pixels, 0),
                    ScrollDirection::Right => (pixels, 0),
                };
                self.cdp_command(
                    "Input.dispatchMouseEvent",
                    &serde_json::json!({
                        "type": "mouseWheel",
                        "x": coordinate.x,
                        "y": coordinate.y,
                        "deltaX": delta_x,
                        "deltaY": delta_y,
                    }),
                )
                .await?;
                Ok(None)
            }
            Action::MoveMouse { coordinate } => {
                self.validate_coordinate(coordinate)?;
                self.cdp_command(
                    "Input.dispatchMouseEvent",
                    &serde_json::json!({
                        "type": "mouseMoved",
                        "x": coordinate.x,
                        "y": coordinate.y,
                    }),
                )
                .await?;
                Ok(None)
            }
            Action::Wait { ms } => {
                tokio::time::sleep(Duration::from_millis(*ms)).await;
                Ok(None)
            }
        }
    }

    async fn screenshot(&self) -> Result<Screenshot, ComputerUseError> {
        let result = self
            .cdp_command(
                "Page.captureScreenshot",
                &serde_json::json!({"format": "png", "fromSurface": true}),
            )
            .await?;
        let data = result
            .get("data")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ComputerUseError::ScreenshotFailed("CDP response omitted image data".to_owned())
            })?;
        if data.is_empty() {
            return Err(ComputerUseError::ScreenshotFailed(
                "CDP returned an empty image".to_owned(),
            ));
        }
        Ok(Screenshot {
            data_base64: data.to_owned(),
            size: self.viewport.clone(),
            format: ImageFormat::Png,
        })
    }

    async fn cdp_click(
        &self,
        coordinate: &Coordinate,
        button: MouseButton,
        click_count: u8,
    ) -> Result<(), ComputerUseError> {
        let button = match button {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
        };
        for event_type in ["mousePressed", "mouseReleased"] {
            self.cdp_command(
                "Input.dispatchMouseEvent",
                &serde_json::json!({
                    "type": event_type,
                    "x": coordinate.x,
                    "y": coordinate.y,
                    "button": button,
                    "clickCount": click_count,
                }),
            )
            .await?;
        }
        Ok(())
    }

    async fn wait_until_ready(&self) -> Result<(), ComputerUseError> {
        let deadline = tokio::time::Instant::now() + CDP_TIMEOUT;
        loop {
            let result = self
                .cdp_command(
                    "Runtime.evaluate",
                    &serde_json::json!({"expression": "document.readyState", "returnByValue": true}),
                )
                .await?;
            let state = result
                .pointer("/result/value")
                .and_then(serde_json::Value::as_str);
            if matches!(state, Some("interactive" | "complete")) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ComputerUseError::Timeout(CDP_TIMEOUT.as_millis() as u64));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn validate_coordinate(&self, coordinate: &Coordinate) -> Result<(), ComputerUseError> {
        if coordinate.x >= self.viewport.width || coordinate.y >= self.viewport.height {
            return Err(ComputerUseError::OutOfBounds {
                x: coordinate.x,
                y: coordinate.y,
                width: self.viewport.width,
                height: self.viewport.height,
            });
        }
        Ok(())
    }

    async fn cdp_command(
        &self,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, ComputerUseError> {
        cdp_command_at(&self.page_cdp_url, method, params).await
    }

    pub async fn close(&mut self) {
        if let Some(mut child) = self.process.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

impl Drop for BrowserBackend {
    fn drop(&mut self) {
        if let Some(child) = &mut self.process {
            let _ = child.start_kill();
        }
    }
}

async fn cdp_command_at(
    endpoint: &str,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, ComputerUseError> {
    let (mut socket, _) =
        tokio::time::timeout(CDP_TIMEOUT, tokio_tungstenite::connect_async(endpoint))
            .await
            .map_err(|_| ComputerUseError::Timeout(CDP_TIMEOUT.as_millis() as u64))?
            .map_err(|error| ComputerUseError::Protocol(format!("connect: {error}")))?;
    let request = serde_json::json!({"id": 1, "method": method, "params": params});
    socket
        .send(Message::Text(request.to_string().into()))
        .await
        .map_err(|error| ComputerUseError::Protocol(format!("send {method}: {error}")))?;

    let response = tokio::time::timeout(CDP_TIMEOUT, async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| {
                ComputerUseError::Protocol(format!("receive {method}: {error}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: serde_json::Value = serde_json::from_str(text.as_str())
                .map_err(|error| ComputerUseError::Protocol(format!("decode {method}: {error}")))?;
            if value.get("id").and_then(serde_json::Value::as_u64) != Some(1) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(ComputerUseError::Protocol(format!("{method}: {error}")));
            }
            return value.get("result").cloned().ok_or_else(|| {
                ComputerUseError::Protocol(format!("{method}: response omitted result"))
            });
        }
        Err(ComputerUseError::Protocol(format!(
            "{method}: connection closed before a response"
        )))
    })
    .await
    .map_err(|_| ComputerUseError::Timeout(CDP_TIMEOUT.as_millis() as u64))??;
    let _ = socket.close(None).await;
    Ok(response)
}

async fn discover_page_endpoint(browser_cdp_url: &str) -> Result<String, ComputerUseError> {
    let mut endpoint = reqwest::Url::parse(browser_cdp_url)
        .map_err(|error| ComputerUseError::Protocol(format!("invalid browser CDP URL: {error}")))?;
    endpoint
        .set_scheme("http")
        .map_err(|_| ComputerUseError::Protocol("could not convert CDP URL to HTTP".to_owned()))?;
    endpoint.set_path("/json/list");
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| ComputerUseError::Protocol(format!("build CDP client: {error}")))?;
    let deadline = tokio::time::Instant::now() + CDP_TIMEOUT;
    loop {
        if let Ok(response) = client.get(endpoint.clone()).send().await
            && let Ok(targets) = response.json::<Vec<serde_json::Value>>().await
            && let Some(url) = targets.iter().find_map(|target| {
                (target.get("type").and_then(serde_json::Value::as_str) == Some("page"))
                    .then(|| {
                        target
                            .get("webSocketDebuggerUrl")
                            .and_then(serde_json::Value::as_str)
                    })
                    .flatten()
            })
        {
            return Ok(url.to_owned());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ComputerUseError::BrowserUnavailable(
                "Chrome did not expose a page CDP endpoint".to_owned(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub fn validate_navigation_url(raw: &str) -> Result<(), ComputerUseError> {
    if raw.len() > 2_000 {
        return Err(ComputerUseError::InvalidUrl(
            "URL exceeds 2,000 characters".to_owned(),
        ));
    }
    let url = reqwest::Url::parse(raw)
        .map_err(|error| ComputerUseError::InvalidUrl(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ComputerUseError::InvalidUrl(
            "only http and https are allowed".to_owned(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ComputerUseError::InvalidUrl(
            "embedded credentials are not allowed".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ComputerUseError::InvalidUrl("URL must include a host".to_owned()))?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(ComputerUseError::InvalidUrl(
            "loopback hosts are blocked".to_owned(),
        ));
    }
    if let Ok(ip) = host.parse::<IpAddr>()
        && is_non_public_ip(ip)
    {
        return Err(ComputerUseError::InvalidUrl(
            "private, loopback, link-local, and unspecified addresses are blocked".to_owned(),
        ));
    }
    Ok(())
}

fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

fn find_chrome() -> Result<PathBuf, ComputerUseError> {
    if let Some(path) = std::env::var_os("CHROME_PATH") {
        let path = PathBuf::from(path);
        if is_executable_file(&path) {
            return Ok(path);
        }
        return Err(ComputerUseError::BrowserUnavailable(format!(
            "CHROME_PATH is not an executable file: {}",
            path.display()
        )));
    }
    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ];
    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if is_executable_file(&path) {
            return Ok(path);
        }
    }
    for name in ["google-chrome", "chromium", "chromium-browser"] {
        if let Some(path) = executable_on_path(name) {
            return Ok(path);
        }
    }
    Err(ComputerUseError::BrowserUnavailable(
        "no Chrome/Chromium found; install Chrome or set CHROME_PATH".to_owned(),
    ))
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| is_executable_file(path))
}

fn is_executable_file(path: &Path) -> bool {
    path.metadata().is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn navigation_rejects_unsafe_urls() {
        for url in [
            "file:///etc/passwd",
            "http://localhost/admin",
            "http://127.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "https://user:secret@example.com/",
        ] {
            assert!(validate_navigation_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_navigation_url("https://example.com/path").is_ok());
    }

    #[tokio::test]
    async fn cdp_transport_returns_matching_result() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request = socket.next().await.unwrap().unwrap();
            let Message::Text(text) = request else {
                panic!("expected text request");
            };
            let request: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
            assert_eq!(request["method"], "Page.captureScreenshot");
            socket
                .send(Message::Text(
                    serde_json::json!({"method": "Page.event"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    serde_json::json!({"id": 1, "result": {"data": "cG5n"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let result = cdp_command_at(
            &format!("ws://{address}"),
            "Page.captureScreenshot",
            &serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(result["data"], "cG5n");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cdp_transport_propagates_protocol_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let _ = socket.next().await;
            socket
                .send(Message::Text(
                    serde_json::json!({"id": 1, "error": {"message": "denied"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let error = cdp_command_at(
            &format!("ws://{address}"),
            "Page.navigate",
            &serde_json::json!({}),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("denied"));
    }

    #[tokio::test]
    #[ignore = "requires an installed Chrome/Chromium binary"]
    async fn real_chrome_produces_a_nonempty_png() {
        use base64::Engine as _;

        let mut backend = BrowserBackend::launch(Some(ScreenSize {
            width: 640,
            height: 360,
        }))
        .await
        .expect("launch installed Chrome");
        let screenshot = backend
            .execute(&Action::Screenshot)
            .await
            .expect("real CDP screenshot")
            .expect("screenshot action returns image");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(screenshot.data_base64)
            .expect("valid base64 screenshot");
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(bytes.len() > 100);
        backend.close().await;
    }
}

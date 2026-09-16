use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::oneshot;
use xai_grok_login::{AuthManager, LoginTransportOverride, run_auth_flow, try_ensure_fresh_auth};
use xai_grok_shell::agent::config::Config as AgentConfig;

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub username: Option<String>,
}

#[tauri::command]
pub async fn check_auth_status() -> Result<AuthStatus, String> {
    let raw_config = xai_grok_shell::config::load_effective_config()
        .map_err(|e| format!("Failed to load config: {e}"))?;
    let agent_config = AgentConfig::new_from_toml_cfg(&raw_config)
        .map_err(|e| format!("Failed to create agent config: {e}"))?;

    let grok_com_config = agent_config.grok_com_config.clone();
    let proxy_base_url = String::new();

    let auth = try_ensure_fresh_auth(&grok_com_config, proxy_base_url).await;

    Ok(AuthStatus {
        authenticated: auth.is_some(),
        username: auth.and_then(|a| a.email),
    })
}

/// Initiate the OAuth/device-flow login.
///
/// `run_auth_flow` uses `Rc<RefCell<…>>` and `Box<dyn Fn>` internally (non-`Send`),
/// so it cannot run on Tauri's multi-threaded runtime. We spawn a dedicated OS
/// thread with a single-threaded tokio runtime + `LocalSet` — the same pattern
/// used by the ACP bridge — and communicate the result back via a oneshot channel.
#[tauri::command]
pub async fn login(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    let raw_config = xai_grok_shell::config::load_effective_config()
        .map_err(|e| format!("Failed to load config: {e}"))?;
    let agent_config = AgentConfig::new_from_toml_cfg(&raw_config)
        .map_err(|e| format!("Failed to create agent config: {e}"))?;

    let grok_com_config = agent_config.grok_com_config.clone();
    let proxy_base_url = String::new();

    let auth_manager = Arc::new(AuthManager::new_with_proxy_base_url(
        &xai_dirs::grok_home(),
        grok_com_config.clone(),
        proxy_base_url,
    ));

    let (result_tx, result_rx) = oneshot::channel::<Result<Option<String>, String>>();
    let config_clone = grok_com_config.clone();
    let app_clone = app.clone();

    std::thread::Builder::new()
        .name("grok-auth".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = result_tx.send(Err(format!("Failed to create runtime: {e}")));
                    return;
                }
            };

            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                let app_for_stderr = app_clone.clone();
                let on_stderr: Box<dyn Fn(&str)> = Box::new(move |line: &str| {
                    let _ = app_for_stderr.emit("auth_message", line);
                });

                let result = run_auth_flow(
                    &auth_manager,
                    &config_clone,
                    Some(true), // force device flow — auto-polls, no stdin needed
                    true,       // reauth
                    Some(on_stderr),
                    None,       // url_tx  — CLI mode (device flow polls)
                    None,       // code_rx — CLI mode
                    LoginTransportOverride::None,
                )
                .await;

                match result {
                    Ok((auth, _did_browser)) => {
                        let _ = result_tx.send(Ok(auth.email));
                    }
                    Err(e) => {
                        let _ = result_tx.send(Err(format!("Login failed: {e}")));
                    }
                }
            });
        })
        .map_err(|e| format!("Failed to spawn auth thread: {e}"))?;

    let email = result_rx
        .await
        .map_err(|_| "Auth thread died before responding".to_string())?
        .map_err(|e| e)?;

    Ok(AuthStatus {
        authenticated: true,
        username: email,
    })
}

#[tauri::command]
pub async fn logout() -> Result<(), String> {
    let grok_home = xai_dirs::grok_home();
    let auth_path = grok_home.join("auth.json");
    if auth_path.exists() {
        std::fs::remove_file(&auth_path)
            .map_err(|e| format!("Failed to remove auth file: {e}"))?;
    }
    Ok(())
}

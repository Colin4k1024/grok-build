//! `ptyctl run` — spawn a PTY session and start the HTTP server.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use tokio::net::TcpListener;

use ptyctl::pty::PtyConfig;
use ptyctl::server;
use ptyctl::session::{PtySession, SessionConfig};

use crate::registry;

/// Run the `ptyctl run` command.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    command: Vec<String>,
    width: u16,
    height: u16,
    cwd: Option<PathBuf>,
    env_vars: Vec<String>,
    port: u16,
    name: Option<String>,
    force: bool,
    timeout: Option<u64>,
    linger: bool,
    quiet: bool,
) -> Result<()> {
    // Refuse to take over a name whose server is still reachable unless --force; stale entries are replaced.
    if let Some(ref session_name) = name
        && !force
        && let Ok(existing) = registry::lookup_session(session_name)
        && registry::server_alive(existing.port).await
    {
        bail!(
            "session '{session_name}' is already running on port {} (use --force to replace it)",
            existing.port
        );
    }

    // Parse env vars.
    let mut env = HashMap::new();
    for var in &env_vars {
        if let Some((k, v)) = var.split_once('=') {
            env.insert(k.to_string(), v.to_string());
        }
    }

    let cwd_str = cwd
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| ".".into());

    let config = SessionConfig {
        pty: PtyConfig {
            command: command.clone(),
            cols: width,
            rows: height,
            cwd,
            env,
        },
        timeout,
        linger,
    };

    // Start the session.
    let session = PtySession::start(config).await?;
    let pid = session.status_basic().1;
    // The controller owns its PTY child group: whichever way this process
    // goes down (SIGTERM/SIGINT, parent death), the child is reaped here.
    let termination = session.termination_handle();

    // Per-process unguessable token: every endpoint requires it, so a
    // discovered loopback port alone grants no shell control.
    let auth_token = uuid::Uuid::new_v4().simple().to_string();

    // Build the HTTP server.
    let router = server::build_router(session, auth_token.clone());

    // Bind to the requested port.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .context("failed to bind TCP listener")?;
    let actual_addr = listener.local_addr()?;
    let actual_port = actual_addr.port();

    // Register named session.
    if let Some(ref session_name) = name {
        let info = registry::SessionInfo {
            port: actual_port,
            pid,
            command: command.clone(),
            cwd: cwd_str,
            started_at: chrono::Utc::now().to_rfc3339(),
        };
        registry::register_session(session_name, &info)?;
    }

    if !quiet {
        eprintln!("Command: {}", command.join(" "));
        if let Some(p) = pid {
            eprintln!("PID: {p}");
        }
        eprintln!("Server listening on port: {actual_port}");
        eprintln!("Auth token: {auth_token}");
    } else {
        // Machine-readable handshake: "<port> <token>" on one stdout line.
        println!("{actual_port} {auth_token}");
    }

    // Serve until shutdown (SIGTERM/SIGINT, or the parent app disappearing).
    let shutdown_result = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_trigger())
        .await
        .context("HTTP server error");

    // Reap the PTY child group no matter how the server stopped (R5-09):
    // TERM the group, escalate to KILL after a short grace, wait for exit.
    if let Err(e) = termination
        .terminate(std::time::Duration::from_secs(2))
        .await
    {
        log::warn!("failed to reap PTY child on shutdown: {e:#}");
    }

    // Clean up only a registration that still points at this server; a --force takeover may have replaced it.
    if let Some(ref session_name) = name
        && let Ok(info) = registry::lookup_session(session_name)
        && info.port == actual_port
    {
        let _ = registry::unregister_session(session_name);
    }

    shutdown_result
}

/// Resolves when this controller should shut down: the owner sent
/// SIGTERM/SIGINT, or the parent process vanished (reparented to init —
/// covers the owning app dying without signalling us). Non-unix builds use
/// the console Ctrl-C path only.
#[cfg(unix)]
async fn shutdown_trigger() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::signal::unix::{SignalKind, signal};

    let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut sigint = signal(SignalKind::interrupt()).expect("install SIGINT handler");

    // Parent-death watch: once our parent is gone, getppid() reports init.
    // The watcher stops as soon as any trigger wins (no live polling thread
    // is left running while termination proceeds).
    let cancelled = Arc::new(AtomicBool::new(false));
    let watcher_cancelled = cancelled.clone();
    let (parent_dead_tx, parent_dead) = tokio::sync::oneshot::channel::<()>();
    std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || {
            loop {
                if watcher_cancelled.load(Ordering::SeqCst) {
                    return;
                }
                // Safety: getppid is always safe to call.
                if unsafe { libc::getppid() } == 1 {
                    let _ = parent_dead_tx.send(());
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        })
        .expect("spawn parent-death watcher");

    tokio::select! {
        _ = sigterm.recv() => log::debug!("SIGTERM received"),
        _ = sigint.recv() => log::debug!("SIGINT received"),
        _ = parent_dead => log::info!("parent process gone — reaping PTY child and exiting"),
    }
    cancelled.store(true, Ordering::SeqCst);
}

#[cfg(not(unix))]
async fn shutdown_trigger() {
    let _ = tokio::signal::ctrl_c().await;
}

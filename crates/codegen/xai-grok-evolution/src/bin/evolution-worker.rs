use std::io::{BufRead, Write};
use std::path::PathBuf;

use xai_grok_evolution::trial::worker::{
    InProcessWorker, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, WorkerCommand, WorkerError,
    WorkerMessage, WorkerRequest, WorkerResponse, WorkerResult,
};
use xai_grok_sandbox::{ProfileName, SandboxManager};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--network-probe") {
        let connected = std::net::TcpStream::connect_timeout(
            &"1.1.1.1:80".parse().expect("static socket address"),
            std::time::Duration::from_secs(2),
        )
        .is_ok();
        std::process::exit(if connected { 0 } else { 42 });
    }
    if let Err(error) = run() {
        eprintln!("evolution worker startup failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let (worktree, protocol, read_only) = parse_args()?;
    if protocol != PROTOCOL_VERSION {
        return Err(format!(
            "unsupported protocol version {protocol}; expected {PROTOCOL_VERSION}"
        ));
    }
    let worktree = worktree
        .canonicalize()
        .map_err(|error| format!("resolve worktree: {error}"))?;
    if !worktree.is_dir() {
        return Err("worktree is not a directory".to_string());
    }

    let mut sandbox = SandboxManager::new(ProfileName::Strict, &worktree);
    sandbox
        .apply_worker_isolation(&worktree, &read_only)
        .map_err(|error| format!("apply strict sandbox: {error}"))?;
    if !sandbox.is_applied() {
        return Err("kernel sandbox unavailable; refusing to run".to_string());
    }
    sandbox.install();
    // SAFETY: worker startup is single-threaded at this point; the marker is
    // consumed only by the in-process preflight probes.
    unsafe {
        std::env::set_var("GROK_EVOLUTION_SANDBOX_ACTIVE", "1");
        std::env::set_var("GROK_EVOLUTION_NETWORK_SANDBOX", "1");
    }

    let worker = InProcessWorker::new(worktree);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("read request: {error}"))?;
        let message = if line.len() > MAX_MESSAGE_BYTES {
            WorkerMessage::Response(error_response(
                WorkerError::InvalidRequest,
                "request exceeds protocol size limit".to_string(),
            ))
        } else {
            match serde_json::from_str::<WorkerRequest>(&line) {
                Ok(request) if request.version == PROTOCOL_VERSION => match request.command {
                    WorkerCommand::Ping => WorkerMessage::Pong,
                    command => WorkerMessage::Response(WorkerResponse {
                        version: PROTOCOL_VERSION,
                        result: worker.execute(&command),
                        duration_ms: 0,
                    }),
                },
                Ok(request) => WorkerMessage::Response(error_response(
                    WorkerError::InvalidRequest,
                    format!("unsupported protocol version {}", request.version),
                )),
                Err(error) => WorkerMessage::Response(error_response(
                    WorkerError::InvalidRequest,
                    format!("invalid request: {error}"),
                )),
            }
        };
        serde_json::to_writer(&mut stdout, &message)
            .map_err(|error| format!("serialize response: {error}"))?;
        stdout
            .write_all(b"\n")
            .map_err(|error| format!("write response: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("flush response: {error}"))?;
    }
    Ok(())
}

fn parse_args() -> Result<(PathBuf, u32, Vec<PathBuf>), String> {
    let mut args = std::env::args().skip(1);
    let mut worktree = None;
    let mut protocol = None;
    let mut read_only = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--worktree" => worktree = args.next().map(PathBuf::from),
            "--protocol-version" => {
                protocol = args.next().and_then(|value| value.parse::<u32>().ok())
            }
            "--read-only" => {
                let path = args
                    .next()
                    .map(PathBuf::from)
                    .ok_or_else(|| "--read-only requires a path".to_string())?;
                let path = path
                    .canonicalize()
                    .map_err(|error| format!("resolve read-only path: {error}"))?;
                if !path.is_dir() {
                    return Err("--read-only paths must be directories".to_string());
                }
                read_only.push(path);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok((
        worktree.ok_or_else(|| "--worktree is required".to_string())?,
        protocol.ok_or_else(|| "--protocol-version is required".to_string())?,
        read_only,
    ))
}

fn error_response(kind: WorkerError, message: String) -> WorkerResponse {
    WorkerResponse {
        version: PROTOCOL_VERSION,
        result: WorkerResult::Error { kind, message },
        duration_ms: 0,
    }
}

use std::path::Path;

use xai_grok_evolution::trial::worker::{
    PROTOCOL_VERSION, WorkerCommand, WorkerProcess, WorkerRequest, WorkerResult,
};

#[test]
fn actual_worker_runs_offline_validator_without_credentials() {
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("src")).unwrap();
    std::fs::write(
        project.path().join("Cargo.toml"),
        "[package]\nname = \"worker-smoke\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    std::fs::write(
        project.path().join("src/lib.rs"),
        "pub fn answer() -> u8 { 42 }\n",
    )
    .unwrap();

    let worker_binary = env!("CARGO_BIN_EXE_xai-grok-evolution-worker");
    let mut worker =
        WorkerProcess::spawn(worker_binary, project.path().to_string_lossy().as_ref(), 30).unwrap();
    let response = worker
        .send_request(&WorkerRequest {
            version: PROTOCOL_VERSION,
            command: WorkerCommand::RunValidator {
                argv: vec![
                    "cargo".to_string(),
                    "check".to_string(),
                    "--offline".to_string(),
                ],
                timeout_secs: 20,
            },
        })
        .unwrap();
    match response.result {
        WorkerResult::ValidatorResult {
            exit_code, stderr, ..
        } => assert_eq!(exit_code, 0, "sandboxed cargo check failed: {stderr}"),
        other => panic!("unexpected worker result: {other:?}"),
    }

    let cargo_home = project.path().join(".evolution-home/.cargo");
    assert!(!cargo_home.join("credentials").exists());
    assert!(!cargo_home.join("credentials.toml").exists());
    assert!(only_sanitized_cache_links(&cargo_home));
    worker.terminate().unwrap();
}

#[test]
fn actual_worker_passes_all_isolation_probes() {
    let cargo_tmp = Path::new(env!("CARGO_TARGET_TMPDIR"));
    std::fs::create_dir_all(cargo_tmp).unwrap();
    let root = tempfile::tempdir_in(cargo_tmp).unwrap();
    let source = root.path().join("source");
    let worktree = root.path().join("pool/worktrees/trial");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(source.join("Cargo.toml"), "[workspace]\nmembers = []\n").unwrap();

    let worker_binary = env!("CARGO_BIN_EXE_xai-grok-evolution-worker");
    let mut worker =
        WorkerProcess::spawn(worker_binary, worktree.to_string_lossy().as_ref(), 30).unwrap();
    let response = worker
        .send_request(&WorkerRequest {
            version: PROTOCOL_VERSION,
            command: WorkerCommand::IsolationPreflight {
                source_dir: source.clone(),
                temp_dir: source.clone(),
                source_vcs_verified: true,
            },
        })
        .unwrap();
    match response.result {
        WorkerResult::IsolationPreflight { result } => assert!(
            result.all_passed(),
            "isolation preflight failed: {:?}",
            result.failure_reasons
        ),
        other => panic!("unexpected preflight result: {other:?}"),
    }
    assert!(!source.join(".evolution-preflight-probe").exists());
    worker.terminate().unwrap();
}

fn only_sanitized_cache_links(cargo_home: &Path) -> bool {
    std::fs::read_dir(cargo_home).unwrap().all(|entry| {
        let entry = entry.unwrap();
        !entry.file_type().unwrap().is_symlink()
            || matches!(entry.file_name().to_str(), Some("registry" | "git"))
    })
}

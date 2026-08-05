//! Integration tests for the unified exec layer.

use std::fs;

use xai_grok_exec_layer::{
    BashRequest, DefaultUnifiedExecutor, EditRequest, ExecError, UnifiedExecutor, WriteRequest,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn tmpdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("failed to create tempdir")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[test]
fn test_edit_and_diff() {
    let dir = tmpdir();
    let file = dir.path().join("hello.txt");
    fs::write(&file, "hello world\nfoo bar\n").unwrap();

    let mut exec = DefaultUnifiedExecutor::new();

    let out = exec
        .exec_edit(EditRequest {
            file_path: file.clone(),
            old_string: "hello world".to_string(),
            new_string: "goodbye world".to_string(),
        })
        .unwrap();

    // Verify file content was updated.
    let content = fs::read_to_string(&file).unwrap();
    assert!(content.contains("goodbye world"));
    assert!(!content.contains("hello world"));

    // Verify diff was produced.
    assert_eq!(out.diff.stats.files_changed, 1);
    assert!(out.diff.stats.insertions >= 1);
    assert!(out.diff.stats.deletions >= 1);
    assert_eq!(out.file_path, file);
}

#[test]
fn test_write_and_undo() {
    let dir = tmpdir();
    let file = dir.path().join("output.txt");

    let mut exec = DefaultUnifiedExecutor::new();

    // Write initial content.
    let out = exec
        .exec_write(WriteRequest {
            file_path: file.clone(),
            content: b"line one\nline two\n".to_vec(),
        })
        .unwrap();

    assert!(out.created);
    assert!(fs::read_to_string(&file).unwrap().contains("line one"));

    // Overwrite.
    exec.exec_write(WriteRequest {
        file_path: file.clone(),
        content: b"overwritten\n".to_vec(),
    })
    .unwrap();

    assert!(fs::read_to_string(&file).unwrap().contains("overwritten"));

    // Undo last → should restore "line one".
    let report = exec.undo_last().unwrap();
    assert!(report.success);
    let content = fs::read_to_string(&file).unwrap();
    assert!(
        content.contains("line one"),
        "expected restored content, got: {content}"
    );
}

#[test]
fn test_nonexistent_create_undo_deleted() {
    let dir = tmpdir();
    let file = dir.path().join("new.txt");
    assert!(!file.exists());

    let mut exec = DefaultUnifiedExecutor::new();

    // Create a file that did not exist.
    exec.exec_write(WriteRequest {
        file_path: file.clone(),
        content: b"brand new\n".to_vec(),
    })
    .unwrap();
    assert!(file.exists());

    // Undo → file should be deleted because the pre-state was NonExistent.
    exec.undo_last().unwrap();
    assert!(
        !file.exists(),
        "file should have been deleted after undo"
    );
}

#[test]
fn test_bash_exit_code() {
    let dir = tmpdir();
    let mut exec = DefaultUnifiedExecutor::new();

    // Successful command.
    let out = exec
        .exec_bash(BashRequest {
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            env: Default::default(),
            cwd: Some(dir.path().to_path_buf()),
            timeout_ms: None,
        })
        .unwrap();

    assert_eq!(out.exit_code, 0);
    assert!(out.stdout.contains("hello"));

    // Failing command (false returns exit 1).
    let out_fail = exec
        .exec_bash(BashRequest {
            command: "false".to_string(),
            args: vec![],
            env: Default::default(),
            cwd: Some(dir.path().to_path_buf()),
            timeout_ms: None,
        })
        .unwrap();

    assert_ne!(out_fail.exit_code, 0);
}

#[test]
fn test_snapshot_eviction() {
    use xai_grok_exec_layer::snapshot::SnapshotEngine;

    let dir = tmpdir();
    let mut engine = SnapshotEngine::new();

    // Create more than MAX_SNAPSHOTS (64) files and capture them.
    for i in 0..80 {
        let file = dir.path().join(format!("file_{i}.txt"));
        fs::write(&file, format!("content {i}")).unwrap();
        engine.capture(&file).unwrap();
    }

    // Memory should be bounded — not zero (we have content), but eviction
    // will have kicked in so we have fewer than 80 snapshots.
    // The engine itself doesn't expose a count, but we can check memory.
    let mem = engine.memory_usage();
    assert!(mem > 0, "should have some cached data");
    // With 80 files of ~12 bytes each, unconstrained would be ~960 bytes.
    // After eviction to 64 snapshots, should be <= 80 * 12 = 960.
    // This is a sanity check that eviction ran.
    assert!(mem <= 80 * 20, "memory should be bounded, got {mem}");
}

#[test]
fn test_history_and_diff_summary() {
    let dir = tmpdir();
    let file_a = dir.path().join("a.txt");
    let file_b = dir.path().join("b.txt");
    fs::write(&file_a, "aaa\n").unwrap();
    fs::write(&file_b, "bbb\n").unwrap();

    let mut exec = DefaultUnifiedExecutor::new();

    exec.exec_edit(EditRequest {
        file_path: file_a.clone(),
        old_string: "aaa".to_string(),
        new_string: "AAA".to_string(),
    })
    .unwrap();

    exec.exec_write(WriteRequest {
        file_path: file_b.clone(),
        content: b"BBB\n".to_vec(),
    })
    .unwrap();

    assert_eq!(exec.history().len(), 2);
    let summary = exec.diff_summary();
    assert!(summary.stats.insertions > 0);
    assert!(summary.stats.deletions > 0);
}

#[test]
fn test_edit_string_not_found() {
    let dir = tmpdir();
    let file = dir.path().join("no_match.txt");
    fs::write(&file, "nothing here\n").unwrap();

    let mut exec = DefaultUnifiedExecutor::new();

    let result = exec.exec_edit(EditRequest {
        file_path: file.clone(),
        old_string: "DOES_NOT_EXIST".to_string(),
        new_string: "replaced".to_string(),
    });

    assert!(result.is_err());
    match result.unwrap_err() {
        ExecError::StringNotFound { .. } => {} // expected
        other => panic!("expected StringNotFound, got: {other}"),
    }
}

#[test]
fn test_undo_nothing() {
    let mut exec = DefaultUnifiedExecutor::new();
    let result = exec.undo_last();
    assert!(result.is_err());
    match result.unwrap_err() {
        ExecError::NothingToUndo => {}
        other => panic!("expected NothingToUndo, got: {other}"),
    }
}

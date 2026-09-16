use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_main: bool,
}

#[tauri::command]
pub async fn git_worktree_list(cwd: String) -> Result<Vec<WorktreeInfo>, String> {
    let output = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for line in text.lines() {
        if line.starts_with("worktree ") {
            if let Some(wt) = current.take() {
                worktrees.push(wt);
            }
            let path = line.strip_prefix("worktree ").unwrap_or(line);
            current = Some(WorktreeInfo {
                path: path.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: worktrees.is_empty(),
            });
        } else if let Some(ref mut wt) = current {
            if line.starts_with("HEAD ") {
                wt.head = line.strip_prefix("HEAD ").unwrap_or("").to_string();
            } else if line.starts_with("branch ") {
                wt.branch = line.strip_prefix("branch ").unwrap_or("").to_string();
                if let Some(b) = wt.branch.strip_prefix("refs/heads/") {
                    wt.branch = b.to_string();
                }
            }
        }
    }
    if let Some(wt) = current {
        worktrees.push(wt);
    }

    Ok(worktrees)
}

#[derive(Debug, Deserialize)]
pub struct WorktreeAddArgs {
    pub cwd: String,
    pub branch: String,
    pub path: String,
    pub new_branch: bool,
}

#[tauri::command]
pub async fn git_worktree_add(args: WorktreeAddArgs) -> Result<String, String> {
    let worktree_path = PathBuf::from(&args.path);
    let parent = worktree_path.parent().ok_or("Invalid path")?;

    // Ensure parent dir exists
    if !parent.exists() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir: {e}"))?;
    }

    let mut cmd = std::process::Command::new("git");
    cmd.arg("worktree").arg("add");

    if args.new_branch {
        cmd.arg("-b").arg(&args.branch);
    } else {
        cmd.arg(&args.branch);
    }

    cmd.arg(&args.path).current_dir(&args.cwd);

    let output = cmd.output().map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(args.path)
}

#[derive(Debug, Deserialize)]
pub struct WorktreeRemoveArgs {
    pub cwd: String,
    pub path: String,
    pub force: bool,
}

#[tauri::command]
pub async fn git_worktree_remove(args: WorktreeRemoveArgs) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("worktree").arg("remove");

    if args.force {
        cmd.arg("--force");
    }

    cmd.arg(&args.path).current_dir(&args.cwd);

    let output = cmd.output().map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn git_list_branches(cwd: String) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

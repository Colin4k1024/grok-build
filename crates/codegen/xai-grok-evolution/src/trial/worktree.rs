//! Isolated worktree provider boundary and Git implementation.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::EvolutionError;
use crate::types::{SourceRef, TrialWorktree};

pub trait WorktreeProvider: Send + Sync {
    fn create(&self, source: &SourceRef) -> Result<TrialWorktree, EvolutionError>;
    fn cleanup(&self, worktree: &TrialWorktree) -> Result<(), EvolutionError>;
}

/// Git detached-worktree provider. Dirty tracked and untracked state is copied
/// into the isolated worktree without changing the source index or branch.
pub struct GitWorktreeProvider {
    source_repo: PathBuf,
    pool_root: PathBuf,
}

impl GitWorktreeProvider {
    pub fn new(source_repo: PathBuf, pool_root: PathBuf) -> Result<Self, EvolutionError> {
        let source_repo = source_repo.canonicalize().map_err(|error| {
            EvolutionError::PreflightFailed(format!("resolve source repository: {error}"))
        })?;
        std::fs::create_dir_all(&pool_root).map_err(|error| {
            EvolutionError::Internal(format!("create evolution worktree pool: {error}"))
        })?;
        let pool_root = pool_root.canonicalize().map_err(|error| {
            EvolutionError::PreflightFailed(format!("resolve worktree pool: {error}"))
        })?;
        Ok(Self {
            source_repo,
            pool_root,
        })
    }

    fn git(&self) -> Command {
        let mut command = Command::new("git");
        command.arg("-C").arg(&self.source_repo);
        command
    }
}

impl WorktreeProvider for GitWorktreeProvider {
    fn create(&self, source: &SourceRef) -> Result<TrialWorktree, EvolutionError> {
        let declared = Path::new(&source.repo_path)
            .canonicalize()
            .map_err(|error| {
                EvolutionError::PreflightFailed(format!(
                    "resolve declared source repository: {error}"
                ))
            })?;
        if declared != self.source_repo {
            return Err(EvolutionError::PreflightFailed(
                "source repository does not match configured provider".to_string(),
            ));
        }
        let worktree_id = uuid::Uuid::new_v4().to_string();
        let target = self.pool_root.join(&worktree_id);
        let output = self
            .git()
            .args(["worktree", "add", "--detach"])
            .arg(&target)
            .arg(&source.commit_sha)
            .output()
            .map_err(|error| EvolutionError::Internal(format!("create git worktree: {error}")))?;
        if !output.status.success() {
            return Err(EvolutionError::Internal(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        if source.is_dirty {
            if let Err(error) = self.copy_dirty_state(&target) {
                let _ = self.cleanup(&TrialWorktree {
                    worktree_id: worktree_id.clone(),
                    path: target.to_string_lossy().into_owned(),
                });
                return Err(error);
            }
        }
        Ok(TrialWorktree {
            worktree_id,
            path: target.to_string_lossy().into_owned(),
        })
    }

    fn cleanup(&self, worktree: &TrialWorktree) -> Result<(), EvolutionError> {
        let target = PathBuf::from(&worktree.path);
        let parent = target.parent().and_then(|path| path.canonicalize().ok());
        if parent.as_deref() != Some(self.pool_root.as_path()) {
            return Err(EvolutionError::PreflightFailed(format!(
                "refusing to clean worktree outside pool: {}",
                target.display()
            )));
        }
        let output = self
            .git()
            .args(["worktree", "remove", "--force"])
            .arg(&target)
            .output()
            .map_err(|error| EvolutionError::Internal(format!("remove git worktree: {error}")))?;
        if !output.status.success() && target.exists() {
            return Err(EvolutionError::Internal(format!(
                "git worktree remove failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(())
    }
}

impl GitWorktreeProvider {
    fn copy_dirty_state(&self, target: &Path) -> Result<(), EvolutionError> {
        let diff = self
            .git()
            .args(["diff", "--binary", "HEAD", "--"])
            .output()
            .map_err(|error| EvolutionError::Internal(format!("read dirty diff: {error}")))?;
        if !diff.status.success() {
            return Err(EvolutionError::Internal(format!(
                "git diff failed: {}",
                String::from_utf8_lossy(&diff.stderr)
            )));
        }
        if !diff.stdout.is_empty() {
            let mut child = Command::new("git")
                .args(["-C"])
                .arg(target)
                .args(["apply", "--binary", "--whitespace=nowarn", "--"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| EvolutionError::Internal(format!("start git apply: {error}")))?;
            child
                .stdin
                .as_mut()
                .ok_or_else(|| EvolutionError::Internal("git apply stdin missing".to_string()))?
                .write_all(&diff.stdout)
                .map_err(|error| EvolutionError::Internal(format!("write dirty diff: {error}")))?;
            let output = child.wait_with_output().map_err(|error| {
                EvolutionError::Internal(format!("wait for git apply: {error}"))
            })?;
            if !output.status.success() {
                return Err(EvolutionError::Internal(format!(
                    "apply dirty diff failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
        }

        let untracked = self
            .git()
            .args(["ls-files", "--others", "--exclude-standard", "-z"])
            .output()
            .map_err(|error| EvolutionError::Internal(format!("list untracked files: {error}")))?;
        if !untracked.status.success() {
            return Err(EvolutionError::Internal(format!(
                "git ls-files failed: {}",
                String::from_utf8_lossy(&untracked.stderr)
            )));
        }
        for raw in untracked
            .stdout
            .split(|byte| *byte == 0)
            .filter(|raw| !raw.is_empty())
        {
            let relative = PathBuf::from(String::from_utf8_lossy(raw).into_owned());
            validate_relative(&relative)?;
            let source = self.source_repo.join(&relative);
            let source = source.canonicalize().map_err(|error| {
                EvolutionError::PreflightFailed(format!("resolve untracked file: {error}"))
            })?;
            if !source.starts_with(&self.source_repo) || !source.is_file() {
                return Err(EvolutionError::PreflightFailed(format!(
                    "untracked path escapes source repository: {}",
                    relative.display()
                )));
            }
            let destination = target.join(&relative);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    EvolutionError::Internal(format!("create untracked destination: {error}"))
                })?;
            }
            std::fs::copy(source, destination).map_err(|error| {
                EvolutionError::Internal(format!("copy untracked file: {error}"))
            })?;
        }
        Ok(())
    }
}

pub fn source_tree_hash(root: &Path) -> Result<String, EvolutionError> {
    let root = root.canonicalize().map_err(|error| {
        EvolutionError::PreflightFailed(format!("resolve source tree: {error}"))
    })?;
    let output = Command::new("git")
        .args([
            "-C",
            root.to_string_lossy().as_ref(),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .map_err(|error| EvolutionError::Internal(format!("list source files: {error}")))?;
    if !output.status.success() {
        return Err(EvolutionError::PreflightFailed(format!(
            "list source files: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let mut files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|raw| !raw.is_empty())
        .map(|raw| PathBuf::from(String::from_utf8_lossy(raw).into_owned()))
        .collect::<Vec<_>>();
    files.sort();
    let mut hasher = blake3::Hasher::new();
    for relative in files {
        validate_relative(&relative)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(&[0]);
        let path = root.join(&relative);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                hasher.update(b"symlink\0");
                hasher.update(
                    std::fs::read_link(&path)
                        .map_err(|error| {
                            EvolutionError::Internal(format!("hash source symlink: {error}"))
                        })?
                        .to_string_lossy()
                        .as_bytes(),
                );
            }
            Ok(metadata) if metadata.is_file() => {
                let canonical = path.canonicalize().map_err(|error| {
                    EvolutionError::Internal(format!("resolve source file: {error}"))
                })?;
                if !canonical.starts_with(&root) {
                    return Err(EvolutionError::PreflightFailed(format!(
                        "source file escapes repository: {}",
                        relative.display()
                    )));
                }
                hasher.update(b"file\0");
                hasher.update(&std::fs::read(canonical).map_err(|error| {
                    EvolutionError::Internal(format!("hash source file: {error}"))
                })?);
            }
            Ok(_) => {
                hasher.update(b"other\0");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                hasher.update(b"deleted\0");
            }
            Err(error) => {
                return Err(EvolutionError::Internal(format!(
                    "stat source file: {error}"
                )));
            }
        }
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn validate_relative(path: &Path) -> Result<(), EvolutionError> {
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(EvolutionError::PreflightFailed(format!(
            "path escapes repository: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_hash_ignores_git_ignored_build_cache() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo);
        let before = source_tree_hash(&repo).unwrap();
        std::fs::create_dir_all(repo.join("target/debug")).unwrap();
        std::fs::write(repo.join("target/debug/cache.bin"), "cache").unwrap();
        assert_eq!(source_tree_hash(&repo).unwrap(), before);

        std::fs::write(repo.join("tracked.txt"), "changed").unwrap();
        assert_ne!(source_tree_hash(&repo).unwrap(), before);
    }

    #[test]
    fn provider_copies_dirty_state_and_reclaims_worktree() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        init_repo(&repo);
        std::fs::write(repo.join("tracked.txt"), "dirty tracked").unwrap();
        std::fs::create_dir_all(repo.join("nested")).unwrap();
        std::fs::write(repo.join("nested/untracked.txt"), "dirty untracked").unwrap();
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let source = SourceRef {
            commit_sha: head.trim().to_string(),
            is_dirty: true,
            repo_path: repo.to_string_lossy().into_owned(),
        };
        let provider = GitWorktreeProvider::new(repo.clone(), root.path().join("pool")).unwrap();
        let worktree = provider.create(&source).unwrap();
        let path = PathBuf::from(&worktree.path);
        assert_eq!(
            std::fs::read_to_string(path.join("tracked.txt")).unwrap(),
            "dirty tracked"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("nested/untracked.txt")).unwrap(),
            "dirty untracked"
        );
        provider.cleanup(&worktree).unwrap();
        assert!(!path.exists());
        assert!(!git(&repo, &["worktree", "list", "--porcelain"]).contains(&worktree.path));
    }

    fn init_repo(repo: &Path) {
        std::fs::create_dir_all(repo).unwrap();
        git(repo, &["init", "-q"]);
        git(
            repo,
            &["config", "user.email", "evolution-test@example.invalid"],
        );
        git(repo, &["config", "user.name", "Evolution Test"]);
        std::fs::write(repo.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(repo.join("tracked.txt"), "baseline").unwrap();
        git(repo, &["add", ".gitignore", "tracked.txt"]);
        git(repo, &["commit", "-qm", "baseline"]);
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
}

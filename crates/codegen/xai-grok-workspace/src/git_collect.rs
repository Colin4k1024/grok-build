//! Local, dependency-free adapter for serializing repository changes.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine as _;
use git2::{BranchType, Diff, DiffOptions, Oid, Repository, Sort, StatusOptions};
use xai_grok_workspace_types::rpc::git::{
    BinaryFileInfoData, CommitWithPatchData, DiffStatsSummary, GitCollectChangesReq,
    GitCollectChangesResponse, IdentityData, PublicBaseData, RepoInfo, UNTRACKED_CONTENT_THRESHOLD,
    UncommittedChangesData, UntrackedFileData,
};

pub(crate) fn collect(req: &GitCollectChangesReq) -> Result<GitCollectChangesResponse> {
    let repo = Repository::discover(&req.repo_path)
        .with_context(|| format!("discovering git repository from {}", req.repo_path))?;
    let root = repo
        .workdir()
        .or_else(|| repo.path().parent())
        .context("bare repository has no usable root")?
        .to_path_buf();
    let head_ref = repo.head().context("repository has no HEAD")?;
    let head = head_ref
        .target()
        .context("HEAD does not point to a commit")?;
    let branch = head_ref.shorthand().map(ToOwned::to_owned);
    let is_detached = !head_ref.is_branch();

    let (upstream, upstream_head) = branch
        .as_deref()
        .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
        .and_then(|branch| branch.upstream().ok())
        .map(|branch| {
            (
                branch.name().ok().flatten().map(ToOwned::to_owned),
                branch.get().target(),
            )
        })
        .unwrap_or((None, None));

    let (base, base_refs) = resolve_public_base(
        &repo,
        head,
        req.base_ref.as_deref(),
        upstream.as_deref(),
        upstream_head,
    )?;
    let (ahead, behind) = upstream_head
        .and_then(|oid| repo.graph_ahead_behind(head, oid).ok())
        .map(|(ahead, behind)| (Some(ahead), Some(behind)))
        .unwrap_or((None, None));

    let mut warnings = Vec::new();
    let commits = if req.include_commits {
        collect_commits(&repo, head, base, req.max_file_bytes, &mut warnings)?
    } else {
        Vec::new()
    };
    let (uncommitted, untracked) = if req.include_uncommitted {
        (
            Some(collect_uncommitted(
                &repo,
                req.max_file_bytes,
                &mut warnings,
            )?),
            collect_untracked(&repo, &root, &req.force_include_paths, &mut warnings)?,
        )
    } else {
        (None, Vec::new())
    };

    let total_size_bytes = included_size(&commits, uncommitted.as_ref(), &untracked);
    let remote_url = primary_remote_url(&repo);
    Ok(GitCollectChangesResponse {
        repo: RepoInfo {
            root: root.to_string_lossy().into_owned(),
            git_dir: Some(repo.path().to_string_lossy().into_owned()),
            head: Some(head.to_string()),
            branch,
            is_detached,
            upstream,
            upstream_head: upstream_head.map(|oid| oid.to_string()),
            remote_url,
            ahead,
            behind,
        },
        head: head.to_string(),
        public_base: PublicBaseData {
            commit: base.to_string(),
            refs: base_refs,
        },
        commits,
        uncommitted,
        untracked,
        warnings,
        total_size_bytes,
    })
}

fn resolve_public_base(
    repo: &Repository,
    head: Oid,
    requested: Option<&str>,
    upstream_name: Option<&str>,
    upstream_head: Option<Oid>,
) -> Result<(Oid, Vec<String>)> {
    if let Some(reference) = requested {
        let oid = repo
            .revparse_single(reference)
            .with_context(|| format!("resolving base revision {reference}"))?
            .peel_to_commit()?
            .id();
        let base = repo.merge_base(head, oid).unwrap_or(oid);
        return Ok((base, vec![reference.to_string()]));
    }
    if let Some(upstream_oid) = upstream_head {
        let base = repo.merge_base(head, upstream_oid).unwrap_or(upstream_oid);
        return Ok((
            base,
            upstream_name.into_iter().map(ToOwned::to_owned).collect(),
        ));
    }
    Ok((head, Vec::new()))
}

fn collect_commits(
    repo: &Repository,
    head: Oid,
    base: Oid,
    max_bytes: u64,
    warnings: &mut Vec<String>,
) -> Result<Vec<CommitWithPatchData>> {
    if head == base {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk()?;
    walk.push(head)?;
    walk.hide(base)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)?;
    walk.map(|oid| {
        let commit = repo.find_commit(oid?)?;
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
        let label = format!("commit {}", commit.id());
        let (patch_base64, stats, binary_files) =
            diff_payload(repo, &diff, max_bytes, warnings, &label)?;
        Ok(CommitWithPatchData {
            id: commit.id().to_string(),
            parents: commit.parent_ids().map(|id| id.to_string()).collect(),
            author: identity(commit.author()),
            committer: identity(commit.committer()),
            summary: commit.summary().map(ToOwned::to_owned),
            message: commit.message().map(ToOwned::to_owned),
            patch_base64,
            stats,
            binary_files,
        })
    })
    .collect()
}

fn collect_uncommitted(
    repo: &Repository,
    max_bytes: u64,
    warnings: &mut Vec<String>,
) -> Result<UncommittedChangesData> {
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let index = repo.index()?;
    let staged = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), None)?;
    let mut options = DiffOptions::new();
    options
        .include_untracked(false)
        .recurse_untracked_dirs(false);
    let unstaged = repo.diff_index_to_workdir(Some(&index), Some(&mut options))?;
    let (staged_patch_base64, staged_stats, staged_binary_files) =
        diff_payload(repo, &staged, max_bytes, warnings, "staged changes")?;
    let (unstaged_patch_base64, unstaged_stats, unstaged_binary_files) =
        diff_payload(repo, &unstaged, max_bytes, warnings, "unstaged changes")?;
    Ok(UncommittedChangesData {
        staged_patch_base64,
        staged_stats,
        unstaged_patch_base64,
        unstaged_stats,
        staged_binary_files,
        unstaged_binary_files,
    })
}

fn diff_payload(
    repo: &Repository,
    diff: &Diff<'_>,
    max_bytes: u64,
    warnings: &mut Vec<String>,
    label: &str,
) -> Result<(Option<String>, DiffStatsSummary, Vec<BinaryFileInfoData>)> {
    let stats = diff.stats()?;
    let stats = DiffStatsSummary {
        files_changed: stats.files_changed(),
        insertions: stats.insertions(),
        deletions: stats.deletions(),
    };
    let mut patch = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), ' ' | '+' | '-') {
            patch.push(line.origin() as u8);
        }
        patch.extend_from_slice(line.content());
        true
    })?;
    let patch_base64 = if patch.is_empty() {
        None
    } else if max_bytes != 0 && patch.len() as u64 > max_bytes {
        warnings.push(format!(
            "{label} patch omitted: {} bytes exceeds maxFileBytes {max_bytes}",
            patch.len()
        ));
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(&patch))
    };
    let binary_files = diff
        .deltas()
        .filter_map(|delta| binary_delta(repo, &delta, max_bytes, warnings, label))
        .collect();
    Ok((patch_base64, stats, binary_files))
}

fn binary_delta(
    repo: &Repository,
    delta: &git2::DiffDelta<'_>,
    max_bytes: u64,
    warnings: &mut Vec<String>,
    label: &str,
) -> Option<BinaryFileInfoData> {
    let file = delta.new_file();
    let path = file.path()?.to_string_lossy().into_owned();
    let content = if !file.id().is_zero() {
        repo.find_blob(file.id())
            .ok()
            .map(|blob| blob.content().to_vec())
    } else {
        repo.workdir()
            .and_then(|root| std::fs::read(root.join(&path)).ok())
    }?;
    if !looks_binary(&content) {
        return None;
    }
    let size_bytes = content.len() as u64;
    let too_large = max_bytes != 0 && size_bytes > max_bytes;
    if too_large {
        warnings.push(format!(
            "{label} binary file {path} omitted: {size_bytes} bytes exceeds maxFileBytes {max_bytes}"
        ));
    }
    Some(BinaryFileInfoData {
        path,
        status: format!("{:?}", delta.status()).to_lowercase(),
        size_bytes,
        blob_included: !too_large,
        truncated: false,
        exclude_reason: too_large.then(|| "max_file_bytes_exceeded".to_string()),
        content_base64: (!too_large)
            .then(|| base64::engine::general_purpose::STANDARD.encode(content)),
    })
}

fn collect_untracked(
    repo: &Repository,
    root: &Path,
    force_include: &[PathBuf],
    warnings: &mut Vec<String>,
) -> Result<Vec<UntrackedFileData>> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let mut paths = BTreeSet::new();
    for entry in repo.statuses(Some(&mut options))?.iter() {
        if entry.status().is_wt_new()
            && let Some(path) = entry.path()
        {
            paths.insert(PathBuf::from(path));
        }
    }
    for absolute in force_include {
        let canonical = match absolute.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                warnings.push(format!(
                    "forceIncludePaths entry {} skipped: {error}",
                    absolute.display()
                ));
                continue;
            }
        };
        match canonical.strip_prefix(root) {
            Ok(relative) if canonical.is_file() => {
                paths.insert(relative.to_path_buf());
            }
            _ => warnings.push(format!(
                "forceIncludePaths entry {} is outside the repository or not a file",
                absolute.display()
            )),
        }
    }
    paths
        .into_iter()
        .map(|relative| untracked_file(root, &relative, warnings))
        .collect()
}

fn untracked_file(
    root: &Path,
    relative: &Path,
    warnings: &mut Vec<String>,
) -> Result<UntrackedFileData> {
    let absolute = root.join(relative);
    let content = std::fs::read(&absolute)
        .with_context(|| format!("reading untracked file {}", relative.display()))?;
    let size_bytes = content.len() as u64;
    let is_binary = looks_binary(&content);
    let content_included = !is_binary && size_bytes <= UNTRACKED_CONTENT_THRESHOLD;
    if !content_included {
        warnings.push(format!(
            "untracked file {} content omitted: {}",
            relative.display(),
            if is_binary {
                "binary"
            } else {
                "larger than 1 MiB"
            }
        ));
    }
    Ok(UntrackedFileData {
        path: relative.to_string_lossy().into_owned(),
        is_binary,
        size_bytes,
        truncated: false,
        content_base64: content_included
            .then(|| base64::engine::general_purpose::STANDARD.encode(content)),
        content_included,
    })
}

fn identity(signature: git2::Signature<'_>) -> IdentityData {
    let time = signature.when();
    let offset_minutes = time.offset_minutes();
    let formatted = chrono::FixedOffset::east_opt(offset_minutes * 60).and_then(|offset| {
        chrono::TimeZone::timestamp_opt(&offset, time.seconds(), 0)
            .single()
            .map(|value| value.to_rfc3339())
    });
    IdentityData {
        name: signature.name().map(ToOwned::to_owned),
        email: signature.email().map(ToOwned::to_owned),
        time: formatted,
        time_seconds: time.seconds(),
        offset_minutes,
    }
}

/// Match libgit2's cheap binary classification without requiring an object
/// database blob (worktree and force-included files may not have one yet).
fn looks_binary(content: &[u8]) -> bool {
    content.iter().take(8_000).any(|byte| *byte == 0)
}

fn primary_remote_url(repo: &Repository) -> Option<String> {
    repo.find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().map(ToOwned::to_owned))
        .or_else(|| {
            repo.remotes().ok().and_then(|names| {
                names
                    .iter()
                    .flatten()
                    .find_map(|name| repo.find_remote(name).ok()?.url().map(ToOwned::to_owned))
            })
        })
}

fn included_size(
    commits: &[CommitWithPatchData],
    uncommitted: Option<&UncommittedChangesData>,
    untracked: &[UntrackedFileData],
) -> u64 {
    let encoded = commits
        .iter()
        .filter_map(|commit| commit.patch_base64.as_ref())
        .chain(
            commits
                .iter()
                .flat_map(|commit| &commit.binary_files)
                .filter_map(|file| file.content_base64.as_ref()),
        )
        .chain(uncommitted.into_iter().flat_map(|changes| {
            changes
                .staged_patch_base64
                .iter()
                .chain(changes.unstaged_patch_base64.iter())
                .chain(
                    changes
                        .staged_binary_files
                        .iter()
                        .chain(&changes.unstaged_binary_files)
                        .filter_map(|file| file.content_base64.as_ref()),
                )
        }))
        .chain(
            untracked
                .iter()
                .filter_map(|file| file.content_base64.as_ref()),
        )
        .map(|value| value.len() as u64)
        .sum::<u64>();
    // Base64 is four bytes for every three source bytes; this is an accurate
    // aggregate except for at most two padding bytes per item.
    encoded.saturating_mul(3) / 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_committed_dirty_and_untracked_changes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        std::fs::write(dir.path().join("tracked.txt"), "one\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        std::fs::write(dir.path().join("tracked.txt"), "two changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();

        let response = collect(&GitCollectChangesReq {
            repo_path: dir.path().to_string_lossy().into_owned(),
            include_commits: true,
            include_uncommitted: true,
            base_ref: None,
            max_file_bytes: 0,
            force_include_paths: Vec::new(),
        })
        .unwrap();
        assert_eq!(response.head, response.public_base.commit);
        assert!(response.commits.is_empty());
        let patch = response
            .uncommitted
            .as_ref()
            .and_then(|changes| changes.unstaged_patch_base64.as_ref())
            .and_then(|encoded| {
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .ok()
            })
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .expect("unstaged patch");
        assert!(patch.contains("-one\n+two changed\n"), "{patch}");
        assert_eq!(response.untracked[0].path, "new.txt");
        assert!(response.total_size_bytes > 0);
    }

    #[test]
    fn rejects_non_repository_paths() {
        let dir = tempfile::tempdir().unwrap();
        let error = collect(&GitCollectChangesReq {
            repo_path: dir.path().to_string_lossy().into_owned(),
            include_commits: true,
            include_uncommitted: true,
            base_ref: None,
            max_file_bytes: 0,
            force_include_paths: Vec::new(),
        })
        .unwrap_err();
        assert!(error.to_string().contains("discovering git repository"));
    }
}

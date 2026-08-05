//! Diff computation and formatting using the `similar` crate.

use similar::{ChangeTag, TextDiff};
use std::path::Path;

use crate::types::{ChunkDiff, DiffHunk, DiffStats, DiffSummary, FileDiff};

/// Compute a [`DiffSummary`] between `old_content` and `new_content` for the
/// given file path.  Returns an empty summary when the content is identical.
pub fn compute_diff(path: &Path, old_content: &[u8], new_content: &[u8]) -> DiffSummary {
    let old_text = String::from_utf8_lossy(old_content);
    let new_text = String::from_utf8_lossy(new_content);
    compute_text_diff(path, &old_text, &new_text)
}

/// Like [`compute_diff`] but operates on already-decoded `&str` slices.
pub fn compute_text_diff(path: &Path, old_text: &str, new_text: &str) -> DiffSummary {
    if old_text == new_text {
        return DiffSummary {
            files: vec![],
            stats: DiffStats {
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            },
        };
    }

    let diff = TextDiff::from_lines(old_text, new_text);

    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut insertions: usize = 0;
    let mut deletions: usize = 0;

    // Current position tracking for old/new file (0-based).
    let mut old_line: usize = 0;
    let mut new_line: usize = 0;

    // Accumulator for the current hunk being built.
    let mut cur_old_start: Option<usize> = None;
    let mut cur_new_start: Option<usize> = None;
    let mut cur_lines: Vec<String> = Vec::new();
    let mut cur_old_count: usize = 0;
    let mut cur_new_count: usize = 0;

    let flush = |hunks: &mut Vec<DiffHunk>,
                 old_start: &mut Option<usize>,
                 new_start: &mut Option<usize>,
                 lines: &mut Vec<String>,
                 old_count: &mut usize,
                 new_count: &mut usize| {
        if let (Some(os), Some(ns)) = (old_start.take(), new_start.take()) {
            hunks.push(DiffHunk {
                old_start: os,
                old_count: *old_count,
                new_start: ns,
                new_count: *new_count,
                lines: std::mem::take(lines),
            });
        }
        *old_count = 0;
        *new_count = 0;
        lines.clear();
    };

    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            ChangeTag::Equal => {
                // Close current hunk on equal lines.
                flush(
                    &mut hunks,
                    &mut cur_old_start,
                    &mut cur_new_start,
                    &mut cur_lines,
                    &mut cur_old_count,
                    &mut cur_new_count,
                );
                old_line += 1;
                new_line += 1;
                continue;
            }
            ChangeTag::Delete => {
                deletions += 1;
                cur_old_start.get_or_insert(old_line);
                cur_old_count += 1;
                "-"
            }
            ChangeTag::Insert => {
                insertions += 1;
                cur_new_start.get_or_insert(new_line);
                cur_new_count += 1;
                "+"
            }
        };

        cur_lines.push(format!("{}{}", tag, change.value()));
        match change.tag() {
            ChangeTag::Delete => old_line += 1,
            ChangeTag::Insert => new_line += 1,
            ChangeTag::Equal => unreachable!(),
        }
    }

    // Flush the last hunk.
    flush(
        &mut hunks,
        &mut cur_old_start,
        &mut cur_new_start,
        &mut cur_lines,
        &mut cur_old_count,
        &mut cur_new_count,
    );

    let files_changed = if hunks.is_empty() { 0 } else { 1 };

    DiffSummary {
        files: vec![FileDiff {
            path: path.to_path_buf(),
            hunks,
        }],
        stats: DiffStats {
            files_changed,
            insertions,
            deletions,
        },
    }
}

/// Format a [`DiffSummary`] as a human-readable unified-diff string.
pub fn format_diff(summary: &DiffSummary) -> String {
    let mut out = String::new();
    for file in &summary.files {
        out.push_str(&format!("--- a/{}\n", file.path.display()));
        out.push_str(&format!("+++ b/{}\n", file.path.display()));
        for hunk in &file.hunks {
            out.push_str(&format!(
                "@@ -{},{} +{},{} @@\n",
                hunk.old_start + 1,
                hunk.old_count,
                hunk.new_start + 1,
                hunk.new_count,
            ));
            for line in &hunk.lines {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out
}

/// Format a compact one-line summary of the diff stats.
pub fn format_diff_summary(summary: &DiffSummary) -> String {
    format!(
        "{} file(s) changed, {} insertion(s), {} deletion(s)",
        summary.stats.files_changed, summary.stats.insertions, summary.stats.deletions,
    )
}

/// Turn a `DiffSummary` into a vector of [`ChunkDiff`] for programmatic consumption.
pub fn to_chunk_diffs(summary: &DiffSummary) -> Vec<ChunkDiff> {
    summary
        .files
        .iter()
        .flat_map(|f| f.hunks.iter())
        .flat_map(|h| h.lines.iter())
        .map(|line| {
            let (tag, value) = if let Some(rest) = line.strip_prefix('+') {
                ("+".to_string(), rest.to_string())
            } else if let Some(rest) = line.strip_prefix('-') {
                ("-".to_string(), rest.to_string())
            } else {
                (" ".to_string(), line.clone())
            };
            ChunkDiff { tag, value }
        })
        .collect()
}

//! Focus mode — collapsible tool-call turns for a compact scrollback view.
//!
//! When focus mode is enabled, completed tool-call entries are collapsed to a
//! single summary line (tool name + status + duration). The user can expand
//! individual entries or toggle the mode globally via `Ctrl+Alt+F`.

use std::collections::HashSet;

use super::entry::EntryId;

/// Summary of a collapsed tool-call entry.
#[derive(Debug, Clone)]
pub struct ToolTurnSummary {
    pub tool_name: String,
    pub status: ToolTurnStatus,
    pub duration_ms: Option<u64>,
    pub output_preview: String,
}

/// Execution status for a tool call in focus mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTurnStatus {
    Running,
    Success,
    Failed,
    Cancelled,
}

impl ToolTurnStatus {
    pub fn icon(&self) -> &'static str {
        match self {
            Self::Running => "⏳",
            Self::Success => "✓",
            Self::Failed => "✗",
            Self::Cancelled => "⊘",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Success => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Focus mode state — tracks which entries are collapsed/expanded.
#[derive(Debug, Clone)]
pub struct FocusMode {
    enabled: bool,
    /// Entries the user has explicitly expanded (override the collapse default).
    expanded_entries: HashSet<EntryId>,
    /// Entries the user has explicitly collapsed (override the expand default
    /// when focus mode is off, or keep collapsed after a toggle-off/on cycle).
    force_collapsed: HashSet<EntryId>,
}

impl Default for FocusMode {
    fn default() -> Self {
        Self {
            enabled: false,
            expanded_entries: HashSet::new(),
            force_collapsed: HashSet::new(),
        }
    }
}

impl FocusMode {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether focus mode is globally enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Toggle focus mode on/off. Returns the new state.
    pub fn toggle(&mut self) -> bool {
        self.enabled = !self.enabled;
        self.enabled
    }

    /// Enable focus mode explicitly.
    pub fn enable(&mut self) {
        self.enabled = true;
    }

    /// Disable focus mode explicitly.
    pub fn disable(&mut self) {
        self.enabled = false;
    }

    /// Whether a given entry should be displayed in collapsed form.
    ///
    /// An entry is collapsed when:
    /// - Focus mode is enabled AND the entry is not in the expanded set, OR
    /// - The entry is in the force-collapsed set (explicit user action).
    pub fn is_collapsed(&self, entry_id: EntryId) -> bool {
        if self.force_collapsed.contains(&entry_id) {
            return true;
        }
        if self.enabled {
            return !self.expanded_entries.contains(&entry_id);
        }
        false
    }

    /// Toggle an individual entry's collapsed/expanded state.
    pub fn toggle_entry(&mut self, entry_id: EntryId) {
        if self.is_collapsed(entry_id) {
            self.force_collapsed.remove(&entry_id);
            self.expanded_entries.insert(entry_id);
        } else {
            self.expanded_entries.remove(&entry_id);
            self.force_collapsed.insert(entry_id);
        }
    }

    /// Expand a specific entry (e.g. when the user presses Enter on it).
    pub fn expand_entry(&mut self, entry_id: EntryId) {
        self.force_collapsed.remove(&entry_id);
        self.expanded_entries.insert(entry_id);
    }

    /// Collapse a specific entry.
    pub fn collapse_entry(&mut self, entry_id: EntryId) {
        self.expanded_entries.remove(&entry_id);
        self.force_collapsed.insert(entry_id);
    }

    /// Expand all entries (temporarily override focus mode for all).
    pub fn expand_all(&mut self) {
        self.force_collapsed.clear();
        // Setting enabled=false effectively expands all since no force_collapsed exist.
        self.enabled = false;
    }

    /// Collapse all tool entries (re-enable focus mode and clear overrides).
    pub fn collapse_all(&mut self) {
        self.expanded_entries.clear();
        self.enabled = true;
    }

    /// Format a collapsed tool-call summary line for display.
    pub fn format_summary(summary: &ToolTurnSummary) -> String {
        let duration_str = match summary.duration_ms {
            Some(ms) if ms >= 1000 => format!(" ({:.1}s)", ms as f64 / 1000.0),
            Some(ms) => format!(" ({ms}ms)"),
            None => String::new(),
        };
        let preview = if summary.output_preview.is_empty() {
            String::new()
        } else {
            let truncated: String = summary.output_preview.chars().take(60).collect();
            let ellipsis = if summary.output_preview.chars().count() > 60 {
                "…"
            } else {
                ""
            };
            format!(" — {truncated}{ellipsis}")
        };
        format!(
            "{icon} {name} — {status}{duration}{preview}",
            icon = summary.status.icon(),
            name = summary.tool_name,
            status = summary.status.label(),
            duration = duration_str,
            preview = preview,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_focus_mode_is_disabled() {
        let fm = FocusMode::new();
        assert!(!fm.is_enabled());
    }

    #[test]
    fn toggle_flips_state() {
        let mut fm = FocusMode::new();
        assert!(fm.toggle());
        assert!(fm.is_enabled());
        assert!(!fm.toggle());
        assert!(!fm.is_enabled());
    }

    #[test]
    fn collapsed_when_enabled_and_not_expanded() {
        let mut fm = FocusMode::new();
        fm.enable();
        let id = EntryId(42);
        assert!(fm.is_collapsed(id));
    }

    #[test]
    fn expanded_entry_not_collapsed_in_focus_mode() {
        let mut fm = FocusMode::new();
        fm.enable();
        let id = EntryId(42);
        fm.expand_entry(id);
        assert!(!fm.is_collapsed(id));
    }

    #[test]
    fn force_collapsed_entry_stays_collapsed_when_mode_off() {
        let mut fm = FocusMode::new();
        let id = EntryId(7);
        fm.collapse_entry(id);
        assert!(!fm.is_enabled());
        assert!(fm.is_collapsed(id));
    }

    #[test]
    fn toggle_entry_flips_individual_state() {
        let mut fm = FocusMode::new();
        fm.enable();
        let id = EntryId(10);
        assert!(fm.is_collapsed(id));
        fm.toggle_entry(id);
        assert!(!fm.is_collapsed(id));
        fm.toggle_entry(id);
        assert!(fm.is_collapsed(id));
    }

    #[test]
    fn collapse_all_resets_expanded() {
        let mut fm = FocusMode::new();
        fm.enable();
        fm.expand_entry(EntryId(1));
        fm.expand_entry(EntryId(2));
        fm.collapse_all();
        assert!(fm.is_collapsed(EntryId(1)));
        assert!(fm.is_collapsed(EntryId(2)));
    }

    #[test]
    fn format_summary_with_duration() {
        let summary = ToolTurnSummary {
            tool_name: "Bash".into(),
            status: ToolTurnStatus::Success,
            duration_ms: Some(2300),
            output_preview: "ls completed".into(),
        };
        let s = FocusMode::format_summary(&summary);
        assert!(s.contains("✓"));
        assert!(s.contains("Bash"));
        assert!(s.contains("2.3s"));
        assert!(s.contains("ls completed"));
    }

    #[test]
    fn format_summary_truncates_long_preview() {
        let summary = ToolTurnSummary {
            tool_name: "Read".into(),
            status: ToolTurnStatus::Success,
            duration_ms: Some(50),
            output_preview: "a".repeat(100),
        };
        let s = FocusMode::format_summary(&summary);
        assert!(s.contains("…"));
        assert!(s.len() < 200);
    }

    #[test]
    fn format_summary_running_no_duration() {
        let summary = ToolTurnSummary {
            tool_name: "Agent".into(),
            status: ToolTurnStatus::Running,
            duration_ms: None,
            output_preview: String::new(),
        };
        let s = FocusMode::format_summary(&summary);
        assert!(s.contains("⏳"));
        assert!(s.contains("running"));
        assert!(!s.contains("—"));
    }
}

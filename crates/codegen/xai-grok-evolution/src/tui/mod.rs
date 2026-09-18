//! TUI state management for the `/evolution` modal.
//!
//! Provides the state machine and data structures for the 4-tab
//! evolution modal in the TUI. The actual rendering lives in
//! `xai-grok-pager`; this module provides the state that the
//! pager reads from.
//!
//! ## Tabs
//!
//! 1. **Timeline** — chronological event stream with filters
//! 2. **Lineage** — ASCII DAG of experience parent-child relationships
//! 3. **Control** — mode display, budget, queue, preflight, mode switching
//! 4. **Evidence** — command argv, exit codes, test results, diffs, hashes

use serde::{Deserialize, Serialize};

use crate::config::EvolutionMode;
use crate::types::*;

// ---------------------------------------------------------------------------
// Tab enum
// ---------------------------------------------------------------------------

/// Evolution modal tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvolutionTab {
    Timeline,
    Lineage,
    Control,
    Evidence,
}

impl EvolutionTab {
    /// All tabs in display order.
    pub const ALL: &[Self] = &[Self::Timeline, Self::Lineage, Self::Control, Self::Evidence];

    /// Display label for the tab.
    pub fn label(self) -> &'static str {
        match self {
            Self::Timeline => "Timeline",
            Self::Lineage => "Lineage",
            Self::Control => "Control",
            Self::Evidence => "Evidence",
        }
    }

    /// Next tab (wraps around).
    pub fn next(self) -> Self {
        let idx = Self::ALL.iter().position(|&t| t == self).unwrap_or(0);
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    /// Previous tab (wraps around).
    pub fn prev(self) -> Self {
        let idx = Self::ALL.iter().position(|&t| t == self).unwrap_or(0);
        Self::ALL[(idx + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

// ---------------------------------------------------------------------------
// Modal state
// ---------------------------------------------------------------------------

/// Complete state for the evolution modal.
#[derive(Debug, Clone)]
pub struct EvolutionModalState {
    pub active_tab: EvolutionTab,
    pub timeline: TimelineState,
    pub lineage: LineageState,
    pub control: ControlState,
    pub evidence: EvidenceState,
}

impl Default for EvolutionModalState {
    fn default() -> Self {
        Self {
            active_tab: EvolutionTab::Timeline,
            timeline: TimelineState::default(),
            lineage: LineageState::default(),
            control: ControlState::default(),
            evidence: EvidenceState::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Timeline tab state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct TimelineState {
    pub events: Vec<TimelineEvent>,
    pub selected_index: usize,
    pub filter: TimelineFilter,
    pub scroll_offset: usize,
}

#[derive(Debug, Clone)]
pub struct TimelineEvent {
    pub event_type: String,
    pub timestamp: i64,
    pub run_id: String,
    pub description: String,
    pub severity: EventSeverity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventSeverity {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Default)]
pub struct TimelineFilter {
    pub state_filter: Option<String>,
    pub task_type_filter: Option<String>,
    pub time_range: Option<(i64, i64)>,
}

// ---------------------------------------------------------------------------
// Lineage tab state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct LineageState {
    pub nodes: Vec<LineageNodeDisplay>,
    pub edges: Vec<LineageEdgeDisplay>,
    pub selected_node: Option<String>,
    pub collapsed: bool,
}

#[derive(Debug, Clone)]
pub struct LineageNodeDisplay {
    pub experience_id: String,
    pub state: ExperienceState,
    pub confidence: f64,
    pub success_count: u32,
    pub failure_count: u32,
    pub env_fingerprint: Option<String>,
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone)]
pub struct LineageEdgeDisplay {
    pub from_index: usize,
    pub to_index: usize,
    pub edge_type: LineageEdgeType,
}

// ---------------------------------------------------------------------------
// Control tab state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ControlState {
    pub effective_mode: EvolutionMode,
    pub config_source: String,
    pub budget_status: BudgetDisplay,
    pub queue_status: QueueDisplay,
    pub circuit_breaker: CircuitBreakerDisplay,
    pub preflight: PreflightDisplay,
    pub mode_transition_allowed: bool,
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            effective_mode: EvolutionMode::Off,
            config_source: "config.toml".to_string(),
            budget_status: BudgetDisplay::default(),
            queue_status: QueueDisplay::default(),
            circuit_breaker: CircuitBreakerDisplay::default(),
            preflight: PreflightDisplay::default(),
            mode_transition_allowed: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BudgetDisplay {
    pub duration_used_secs: u64,
    pub duration_limit_secs: u64,
    pub rounds_used: u32,
    pub rounds_limit: u32,
}

#[derive(Debug, Clone, Default)]
pub struct QueueDisplay {
    pub pending_signals: u32,
    pub active_trials: u32,
    pub max_concurrent: u32,
}

#[derive(Debug, Clone, Default)]
pub struct CircuitBreakerDisplay {
    pub state: String, // "closed" | "open" | "half-open"
    pub failure_count: u32,
    pub last_failure_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct PreflightDisplay {
    pub source_write_blocked: bool,
    pub network_blocked: bool,
    pub symlink_blocked: bool,
    pub sandbox_available: bool,
    pub all_passed: bool,
}

// ---------------------------------------------------------------------------
// Evidence tab state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct EvidenceState {
    pub selected_run_id: Option<String>,
    pub commands: Vec<CommandDisplay>,
    pub diff: Option<String>,
    pub environment: Option<EnvironmentDisplay>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CommandDisplay {
    pub argv: Vec<String>,
    pub exit_code: i32,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct EnvironmentDisplay {
    pub rustc_version: Option<String>,
    pub target_triple: Option<String>,
    pub os: Option<String>,
    pub repo_hash: Option<String>,
}

// ---------------------------------------------------------------------------
// State update methods
// ---------------------------------------------------------------------------

impl EvolutionModalState {
    /// Handle keyboard input for tab navigation.
    pub fn handle_key(&mut self, key: ModalKey) -> ModalAction {
        match key {
            ModalKey::TabNext => {
                self.active_tab = self.active_tab.next();
                ModalAction::Redraw
            }
            ModalKey::TabPrev => {
                self.active_tab = self.active_tab.prev();
                ModalAction::Redraw
            }
            ModalKey::Up => {
                if self.active_tab == EvolutionTab::Timeline
                    && self.timeline.selected_index > 0
                {
                    self.timeline.selected_index -= 1;
                }
                ModalAction::Redraw
            }
            ModalKey::Down => {
                if self.active_tab == EvolutionTab::Timeline
                    && self.timeline.selected_index + 1 < self.timeline.events.len()
                {
                    self.timeline.selected_index += 1;
                }
                ModalAction::Redraw
            }
            ModalKey::Close => ModalAction::Close,
            ModalKey::Enter => {
                match self.active_tab {
                    EvolutionTab::Timeline => ModalAction::InspectEvent(self.timeline.selected_index),
                    EvolutionTab::Control => ModalAction::ConfirmModeChange,
                    _ => ModalAction::None,
                }
            }
        }
    }
}

/// Modal keyboard input.
#[derive(Debug, Clone, Copy)]
pub enum ModalKey {
    TabNext,
    TabPrev,
    Up,
    Down,
    Enter,
    Close,
}

/// Actions the modal can request.
#[derive(Debug, Clone)]
pub enum ModalAction {
    None,
    Redraw,
    Close,
    InspectEvent(usize),
    ConfirmModeChange,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_navigation_circular() {
        assert_eq!(EvolutionTab::Timeline.next(), EvolutionTab::Lineage);
        assert_eq!(EvolutionTab::Lineage.next(), EvolutionTab::Control);
        assert_eq!(EvolutionTab::Control.next(), EvolutionTab::Evidence);
        assert_eq!(EvolutionTab::Evidence.next(), EvolutionTab::Timeline); // wraps

        assert_eq!(EvolutionTab::Timeline.prev(), EvolutionTab::Evidence); // wraps
        assert_eq!(EvolutionTab::Evidence.prev(), EvolutionTab::Control);
    }

    #[test]
    fn tab_labels() {
        for tab in EvolutionTab::ALL {
            assert!(!tab.label().is_empty());
        }
    }

    #[test]
    fn default_state_is_timeline() {
        let state = EvolutionModalState::default();
        assert_eq!(state.active_tab, EvolutionTab::Timeline);
    }

    #[test]
    fn key_navigation_changes_tab() {
        let mut state = EvolutionModalState::default();
        state.handle_key(ModalKey::TabNext);
        assert_eq!(state.active_tab, EvolutionTab::Lineage);
        state.handle_key(ModalKey::TabNext);
        assert_eq!(state.active_tab, EvolutionTab::Control);
        state.handle_key(ModalKey::TabNext);
        assert_eq!(state.active_tab, EvolutionTab::Evidence);
        state.handle_key(ModalKey::TabNext);
        assert_eq!(state.active_tab, EvolutionTab::Timeline);
    }

    #[test]
    fn close_action() {
        let mut state = EvolutionModalState::default();
        match state.handle_key(ModalKey::Close) {
            ModalAction::Close => {}
            other => panic!("expected Close, got {:?}", other),
        }
    }

    #[test]
    fn timeline_scroll_bounds() {
        let mut state = EvolutionModalState::default();
        // Down on empty timeline stays at 0
        state.handle_key(ModalKey::Down);
        assert_eq!(state.timeline.selected_index, 0);

        // Up on empty timeline stays at 0
        state.handle_key(ModalKey::Up);
        assert_eq!(state.timeline.selected_index, 0);
    }
}

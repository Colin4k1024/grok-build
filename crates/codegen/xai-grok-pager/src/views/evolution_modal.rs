//! Evolution modal: 4-tab view for the experience evolution system.
//!
//! Tabs: Timeline, Lineage, Control, Evidence
//!
//! This module provides the state and rendering for the `/evolution` modal.
//! The state types mirror `xai_grok_evolution::tui::*` but are local to the
//! pager to avoid a direct dependency on the evolution crate's TUI module.

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::Widget;
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Tabs, Wrap};

/// Tab identifiers for the evolution modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvolutionTab {
    Timeline,
    Lineage,
    Control,
    Evidence,
}

impl EvolutionTab {
    pub const ALL: &[Self] = &[Self::Timeline, Self::Lineage, Self::Control, Self::Evidence];

    pub fn label(self) -> &'static str {
        match self {
            Self::Timeline => "Timeline",
            Self::Lineage => "Lineage",
            Self::Control => "Control",
            Self::Evidence => "Evidence",
        }
    }

    pub fn next(self) -> Self {
        let idx = Self::ALL.iter().position(|&t| t == self).unwrap_or(0);
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    pub fn prev(self) -> Self {
        let idx = Self::ALL.iter().position(|&t| t == self).unwrap_or(0);
        Self::ALL[(idx + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

/// Complete state for the evolution modal.
#[derive(Debug)]
pub struct EvolutionModalState {
    pub active_tab: EvolutionTab,
    pub timeline_events: Vec<TimelineEvent>,
    pub selected_index: usize,
    pub mode_label: String,
    pub active_runs: u32,
    pub total_experiences: u32,
    pub pending_signals: u32,
    pub circuit_breaker_state: String,
    pub load_error: Option<String>,
    pub control_message: Option<String>,
    pub mode_change_confirmation_pending: bool,
    pub run_detail: Option<EvolutionRunDetail>,
    pub lineage: Option<EvolutionLineageData>,
}

#[derive(Debug, Clone)]
pub struct TimelineEvent {
    pub run_id: String,
    pub event_type: String,
    pub description: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionRunDetail {
    pub run: serde_json::Value,
    #[serde(default)]
    pub events: Vec<EvolutionEventView>,
    pub experience: Option<serde_json::Value>,
    pub trial_outcome: Option<serde_json::Value>,
    pub evidence: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionEventView {
    pub event_type: String,
    pub timestamp: i64,
    pub description: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionLineageData {
    #[serde(default)]
    pub nodes: Vec<serde_json::Value>,
    #[serde(default)]
    pub edges: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionOperationResult {
    #[serde(default)]
    pub new_run_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionViewData {
    pub mode: String,
    pub active_runs: u32,
    pub total_experiences: u32,
    pub pending_signals: u32,
    pub circuit_breaker_state: String,
    pub runs: Vec<EvolutionRunView>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionRunView {
    pub run_id: String,
    pub state: serde_json::Value,
    pub started_at: i64,
    pub signals_count: u32,
    pub outcome: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct EvolutionModeChangeResult {
    pub new_mode: String,
    pub preflight_passed: bool,
    #[serde(default)]
    pub failure_reasons: Vec<String>,
}

impl Default for EvolutionModalState {
    fn default() -> Self {
        Self {
            active_tab: EvolutionTab::Timeline,
            timeline_events: vec![],
            selected_index: 0,
            mode_label: "Off".to_string(),
            active_runs: 0,
            total_experiences: 0,
            pending_signals: 0,
            circuit_breaker_state: "closed".to_string(),
            load_error: None,
            control_message: None,
            mode_change_confirmation_pending: false,
            run_detail: None,
            lineage: None,
        }
    }
}

impl EvolutionModalState {
    pub fn new(mode_label: String) -> Self {
        Self {
            mode_label,
            ..Default::default()
        }
    }

    pub fn apply_view_data(&mut self, data: EvolutionViewData) {
        self.mode_label = data.mode;
        self.active_runs = data.active_runs;
        self.total_experiences = data.total_experiences;
        self.pending_signals = data.pending_signals;
        self.circuit_breaker_state = data.circuit_breaker_state;
        self.load_error = None;
        self.control_message = None;
        self.mode_change_confirmation_pending = false;
        self.timeline_events = data
            .runs
            .into_iter()
            .map(|run| TimelineEvent {
                run_id: run.run_id.clone(),
                event_type: json_label(&run.state),
                description: format!(
                    "{} · {} signal(s){}",
                    run.run_id,
                    run.signals_count,
                    run.outcome
                        .as_ref()
                        .map(|outcome| format!(" · {}", json_label(outcome)))
                        .unwrap_or_default()
                ),
                timestamp: run.started_at.to_string(),
            })
            .collect();
        self.selected_index = self
            .selected_index
            .min(self.timeline_events.len().saturating_sub(1));
    }

    pub fn selected_run_id(&self) -> Option<&str> {
        self.timeline_events
            .get(self.selected_index)
            .map(|event| event.run_id.as_str())
    }

    pub fn selected_experience_id(&self) -> Option<&str> {
        self.run_detail
            .as_ref()?
            .experience
            .as_ref()?
            .get("experience_id")?
            .as_str()
    }
}

fn json_label(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

/// Draw the evolution modal.
pub fn draw(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // tabs
            Constraint::Min(5),    // content
            Constraint::Length(2), // footer hints
        ])
        .split(area);

    // Tab bar
    let tab_titles: Vec<&str> = EvolutionTab::ALL.iter().map(|t| t.label()).collect();
    let selected = EvolutionTab::ALL
        .iter()
        .position(|&t| t == state.active_tab)
        .unwrap_or(0);
    let tabs = Tabs::new(tab_titles)
        .block(Block::default().borders(Borders::ALL).title("Evolution"))
        .select(selected)
        .style(Style::default().fg(Color::White))
        .highlight_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );
    tabs.render(chunks[0], buf);

    // Content area
    match state.active_tab {
        EvolutionTab::Timeline => draw_timeline(buf, chunks[1], state),
        EvolutionTab::Lineage => draw_lineage(buf, chunks[1], state),
        EvolutionTab::Control => draw_control(buf, chunks[1], state),
        EvolutionTab::Evidence => draw_evidence(buf, chunks[1], state),
    }

    // Footer hints
    let hints =
        Paragraph::new(" ←/→ Tab  ↑/↓ Navigate  Enter Inspect/Load  R Retry  E Export  Esc Close ")
            .style(Style::default().fg(Color::DarkGray))
            .block(Block::default().borders(Borders::TOP));
    hints.render(chunks[2], buf);
}

fn draw_timeline(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    if state.timeline_events.is_empty() {
        let empty = Paragraph::new("No evolution events yet.\n\nEvents will appear here when evolution is enabled and signals are detected.")
            .block(Block::default().borders(Borders::ALL).title("Timeline"))
            .wrap(Wrap { trim: true })
            .style(Style::default().fg(Color::DarkGray));
        empty.render(area, buf);
        return;
    }

    let items: Vec<ListItem> = state
        .timeline_events
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let style = if i == state.selected_index {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(format!(
                "[{}] {}: {}",
                e.timestamp, e.event_type, e.description
            ))
            .style(style)
        })
        .collect();

    let list = List::new(items).block(Block::default().borders(Borders::ALL).title("Timeline"));
    list.render(area, buf);
}

fn draw_lineage(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    let content = state.lineage.as_ref().map_or_else(
        || {
            "Experience Lineage\n\nInspect a published run, then press Enter here to load lineage."
                .to_string()
        },
        |lineage| {
            let nodes = lineage
                .nodes
                .iter()
                .map(|node| {
                    format!(
                        "• {} [{}] confidence={} success={} failure={}",
                        node.get("experience_id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown"),
                        node.get("state").map(json_label).unwrap_or_default(),
                        node.get("confidence")
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "?".to_string()),
                        node.get("success_count")
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "?".to_string()),
                        node.get("failure_count")
                            .map(ToString::to_string)
                            .unwrap_or_else(|| "?".to_string()),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let edges = lineage
                .edges
                .iter()
                .map(|edge| {
                    format!(
                        "{} → {} ({})",
                        edge.get("parent_id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("?"),
                        edge.get("child_id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("?"),
                        edge.get("edge_type").map(json_label).unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("Nodes\n{nodes}\n\nEdges\n{edges}")
        },
    );
    let content = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title("Lineage"))
        .wrap(Wrap { trim: true });
    content.render(area, buf);
}

fn draw_control(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    let content = format!(
        "Mode: {}\n\n\
         Queue:\n\
         │ Pending signals: {}\n\
         │ Active trials: {}\n\n\
         Experiences: {}\n\n\
         Circuit Breaker: {}\n\n\
         Enter: advance mode (press twice to confirm upgrades)\n\
         O: emergency Off{}{}",
        state.mode_label,
        state.pending_signals,
        state.active_runs,
        state.total_experiences,
        state.circuit_breaker_state,
        state
            .control_message
            .as_ref()
            .map(|message| format!("\n\n{message}"))
            .unwrap_or_default(),
        state
            .load_error
            .as_ref()
            .map(|error| format!("\n\nRead-only degraded: {error}"))
            .unwrap_or_default(),
    );
    let paragraph = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title("Control"))
        .wrap(Wrap { trim: true });
    paragraph.render(area, buf);
}

fn draw_evidence(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    let content = state.run_detail.as_ref().map_or_else(
        || "Select a run on Timeline and press Enter to inspect its evidence.".to_string(),
        |detail| {
            let events = detail
                .events
                .iter()
                .map(|event| {
                    format!(
                        "[{}] {}: {}",
                        event.timestamp, event.event_type, event.description
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "Run\n{}\n\nTrial outcome\n{}\n\nEvidence\n{}\n\nEvents\n{}",
                serde_json::to_string_pretty(&detail.run).unwrap_or_default(),
                detail
                    .trial_outcome
                    .as_ref()
                    .and_then(|value| serde_json::to_string_pretty(value).ok())
                    .unwrap_or_else(|| "None".to_string()),
                detail
                    .evidence
                    .as_ref()
                    .and_then(|value| serde_json::to_string_pretty(value).ok())
                    .unwrap_or_else(|| "None".to_string()),
                events,
            )
        },
    );
    let content = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title("Evidence"))
        .wrap(Wrap { trim: true });
    content.render(area, buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_navigation() {
        assert_eq!(EvolutionTab::Timeline.next(), EvolutionTab::Lineage);
        assert_eq!(EvolutionTab::Evidence.next(), EvolutionTab::Timeline);
        assert_eq!(EvolutionTab::Timeline.prev(), EvolutionTab::Evidence);
    }

    #[test]
    fn default_state() {
        let state = EvolutionModalState::default();
        assert_eq!(state.active_tab, EvolutionTab::Timeline);
        assert!(state.timeline_events.is_empty());
    }

    #[test]
    fn new_with_mode() {
        let state = EvolutionModalState::new("Shadow".to_string());
        assert_eq!(state.mode_label, "Shadow");
    }

    #[test]
    fn view_data_preserves_selected_run_identity() {
        let mut state = EvolutionModalState::default();
        state.apply_view_data(EvolutionViewData {
            mode: "shadow".to_string(),
            active_runs: 0,
            total_experiences: 0,
            pending_signals: 0,
            circuit_breaker_state: "closed".to_string(),
            runs: vec![EvolutionRunView {
                run_id: "run-real-1".to_string(),
                state: serde_json::json!("completed"),
                started_at: 42,
                signals_count: 2,
                outcome: Some(serde_json::json!("reject")),
            }],
        });
        assert_eq!(state.selected_run_id(), Some("run-real-1"));
    }

    #[test]
    fn mode_change_report_keeps_preflight_failure_reasons() {
        let report: EvolutionModeChangeResult = serde_json::from_value(serde_json::json!({
            "new_mode": "shadow",
            "preflight_passed": false,
            "failure_reasons": ["network isolation probe failed"]
        }))
        .unwrap();
        assert!(!report.preflight_passed);
        assert_eq!(report.failure_reasons, ["network isolation probe failed"]);
    }

    #[test]
    fn evidence_tab_renders_real_inspection_payload() {
        let mut state = EvolutionModalState::default();
        state.active_tab = EvolutionTab::Evidence;
        state.run_detail = Some(
            serde_json::from_value(serde_json::json!({
                "run": {"run_id": "run-evidence", "state": "completed"},
                "events": [{
                    "event_type": "ValidationCompleted",
                    "timestamp": 7,
                    "description": "candidate validation passed"
                }],
                "experience": null,
                "trial_outcome": {"result": "success"},
                "evidence": {"content_hash": "abc123", "scrubbed": true}
            }))
            .unwrap(),
        );
        let area = Rect::new(0, 0, 100, 30);
        let mut buffer = Buffer::empty(area);
        draw(&mut buffer, area, &state);
        let rendered = (0..area.height)
            .flat_map(|y| (0..area.width).map(move |x| (x, y)))
            .filter_map(|position| buffer.cell(position))
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("run-evidence"));
        assert!(rendered.contains("abc123"));
        assert!(rendered.contains("candidate validation passed"));
    }
}

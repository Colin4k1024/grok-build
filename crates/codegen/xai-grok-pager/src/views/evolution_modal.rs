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
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Tabs, Wrap};
use ratatui::widgets::Widget;

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
}

#[derive(Debug, Clone)]
pub struct TimelineEvent {
    pub event_type: String,
    pub description: String,
    pub timestamp: String,
}

impl Default for EvolutionModalState {
    fn default() -> Self {
        Self {
            active_tab: EvolutionTab::Timeline,
            timeline_events: vec![],
            selected_index: 0,
            mode_label: "Off".to_string(),
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
}

/// Draw the evolution modal.
pub fn draw(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // tabs
            Constraint::Min(5),   // content
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
        EvolutionTab::Lineage => draw_lineage(buf, chunks[1]),
        EvolutionTab::Control => draw_control(buf, chunks[1], state),
        EvolutionTab::Evidence => draw_evidence(buf, chunks[1]),
    }

    // Footer hints
    let hints = Paragraph::new(" ←/→ Switch Tab  ↑/↓ Navigate  Enter Inspect  Esc Close ")
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
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(format!("[{}] {}: {}", e.timestamp, e.event_type, e.description)).style(style)
        })
        .collect();

    let list = List::new(items).block(Block::default().borders(Borders::ALL).title("Timeline"));
    list.render(area, buf);
}

fn draw_lineage(buf: &mut Buffer, area: Rect) {
    let content = Paragraph::new(
        "Experience Lineage\n\n\
         ┌─ exp-001 (Active, 85%)\n\
         │  ├─ exp-002 (Candidate, 0%)\n\
         │  └─ exp-003 (Decaying, 45%)\n\
         └─ exp-004 (Quarantined)\n\n\
         (Lineage graph will populate as experiences evolve)",
    )
    .block(Block::default().borders(Borders::ALL).title("Lineage"))
    .wrap(Wrap { trim: true });
    content.render(area, buf);
}

fn draw_control(buf: &mut Buffer, area: Rect, state: &EvolutionModalState) {
    let content = format!(
        "Mode: {}\n\n\
         Budget:\n\
         │ Duration: 0/1200s\n\
         │ Rounds: 0/3\n\n\
         Queue:\n\
         │ Pending signals: 0\n\
         │ Active trials: 0\n\n\
         Circuit Breaker: closed\n\n\
         Preflight:\n\
         │ Sandbox: ✓\n\
         │ Network blocked: ✓\n\
         │ Source write blocked: ✓",
        state.mode_label
    );
    let paragraph = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title("Control"))
        .wrap(Wrap { trim: true });
    paragraph.render(area, buf);
}

fn draw_evidence(buf: &mut Buffer, area: Rect) {
    let content = Paragraph::new(
        "Evidence Details\n\n\
         Select an event from the Timeline tab to view its evidence.\n\n\
         Evidence includes:\n\
         • Command argv and exit codes\n\
         • Test results and validation logs\n\
         • Diffs and environment info\n\
         • Content hashes for verification",
    )
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
}

//! TUI voice status indicator.
//!
//! Renders an emoji icon and a human-readable label for the current voice
//! session state, including a simple waveform animation when the agent is
//! speaking.

use crate::realtime::session::VoiceSessionState;

/// Displays the current voice session state as an icon + label pair.
#[derive(Debug, Clone)]
pub struct VoiceIndicator {
    state: VoiceSessionState,
    /// Animation frame counter for the waveform effect.
    waveform_frame: u8,
}

impl VoiceIndicator {
    /// Start in the idle state.
    pub fn new() -> Self {
        Self {
            state: VoiceSessionState::Idle,
            waveform_frame: 0,
        }
    }

    /// Update the displayed state (resets the animation frame).
    pub fn set_state(&mut self, state: VoiceSessionState) {
        self.state = state;
        self.waveform_frame = 0;
    }

    /// Advance the waveform animation by one frame.
    pub fn tick(&mut self) {
        self.waveform_frame = (self.waveform_frame + 1) % 4;
    }

    /// Emoji icon for the current state.
    pub fn icon(&self) -> &str {
        match self.state {
            VoiceSessionState::Idle => "🔇",
            VoiceSessionState::Listening => "🎤",
            VoiceSessionState::Processing => "⏳",
            VoiceSessionState::Speaking => match self.waveform_frame {
                0 | 2 => "🔊",
                _ => "🔉",
            },
            VoiceSessionState::Interrupted => "⚡",
            VoiceSessionState::ToolExecuting => "🔧",
        }
    }

    /// Human-readable label for the current state.
    pub fn label(&self) -> &str {
        match self.state {
            VoiceSessionState::Idle => "Voice off",
            VoiceSessionState::Listening => "Listening...",
            VoiceSessionState::Processing => "Thinking...",
            VoiceSessionState::Speaking => "Speaking...",
            VoiceSessionState::Interrupted => "Interrupted",
            VoiceSessionState::ToolExecuting => "Using tool...",
        }
    }

    /// Formatted display string (`"🎤 Listening..."`).
    pub fn display(&self) -> String {
        format!("{} {}", self.icon(), self.label())
    }

    /// Current state.
    pub fn state(&self) -> &VoiceSessionState {
        &self.state
    }
}

impl Default for VoiceIndicator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_format() {
        let mut ind = VoiceIndicator::new();
        assert_eq!(ind.display(), "🔇 Voice off");

        ind.set_state(VoiceSessionState::Listening);
        assert_eq!(ind.display(), "🎤 Listening...");

        ind.set_state(VoiceSessionState::Speaking);
        ind.tick();
        let d = ind.display();
        assert!(d.contains("🔊") || d.contains("🔉"));
    }

    #[test]
    fn waveform_animation() {
        let mut ind = VoiceIndicator::new();
        ind.set_state(VoiceSessionState::Speaking);
        let mut icons = Vec::new();
        for _ in 0..4 {
            ind.tick();
            icons.push(ind.icon().to_string());
        }
        // Should cycle through waveform icons (🔊 / 🔉).
        assert!(icons.iter().any(|i| i == "🔊"));
        assert!(icons.iter().any(|i| i == "🔉"));
    }

    #[test]
    fn all_states_have_labels() {
        let states = [
            VoiceSessionState::Idle,
            VoiceSessionState::Listening,
            VoiceSessionState::Processing,
            VoiceSessionState::Speaking,
            VoiceSessionState::Interrupted,
            VoiceSessionState::ToolExecuting,
        ];
        for s in states {
            let mut ind = VoiceIndicator::new();
            ind.set_state(s.clone());
            // Every state produces a non-empty display.
            assert!(!ind.display().is_empty(), "empty display for {s:?}");
        }
    }
}

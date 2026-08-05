//! Real-time transcript buffer for the TUI.
//!
//! Manages the display of in-progress and confirmed transcripts for both the
//! user (via STT) and the agent (via TTS transcript deltas).

/// Buffer that accumulates and formats transcript lines for terminal display.
#[derive(Debug)]
pub struct TranscriptBuffer {
    /// User text currently being recognised (partial / interim).
    partial_user: String,
    /// Confirmed user utterances (oldest first).
    confirmed_user: Vec<String>,
    /// Agent text currently being spoken.
    agent_speaking: String,
    /// Maximum number of confirmed lines to retain.
    max_lines: usize,
}

impl TranscriptBuffer {
    /// Create a buffer that retains at most `max_lines` confirmed entries.
    pub fn new(max_lines: usize) -> Self {
        Self {
            partial_user: String::new(),
            confirmed_user: Vec::new(),
            agent_speaking: String::new(),
            max_lines,
        }
    }

    /// Update the in-progress user transcript.
    pub fn set_user_partial(&mut self, text: String) {
        self.partial_user = text;
    }

    /// Promote the current partial transcript to a confirmed utterance.
    pub fn confirm_user(&mut self, text: String) {
        self.confirmed_user.push(text);
        self.partial_user.clear();
        // Trim to max_lines.
        while self.confirmed_user.len() > self.max_lines {
            self.confirmed_user.remove(0);
        }
    }

    /// Replace the current agent speaking transcript.
    pub fn set_agent_speaking(&mut self, text: String) {
        self.agent_speaking = text;
    }

    /// Append a transcript delta to the agent's in-progress text.
    pub fn append_agent_delta(&mut self, delta: &str) {
        self.agent_speaking.push_str(delta);
    }

    /// Finalise the agent transcript and return it.
    pub fn agent_finished(&mut self) -> String {
        let text = self.agent_speaking.clone();
        self.agent_speaking.clear();
        text
    }

    /// Render the current buffer state as display lines.
    ///
    /// Each line is prefixed with an emoji marker:
    /// - `👤` for user utterances
    /// - `🤖` for agent utterances
    pub fn display_lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self
            .confirmed_user
            .iter()
            .map(|t| format!("👤 {t}"))
            .collect();
        if !self.partial_user.is_empty() {
            lines.push(format!("👤 {}...", self.partial_user));
        }
        if !self.agent_speaking.is_empty() {
            lines.push(format!("🤖 {}", self.agent_speaking));
        }
        lines
    }

    /// Clear all buffer contents.
    pub fn clear(&mut self) {
        self.partial_user.clear();
        self.confirmed_user.clear();
        self.agent_speaking.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_transcript_flow() {
        let mut buf = TranscriptBuffer::new(10);
        buf.set_user_partial("hello".into());
        assert!(buf.display_lines().iter().any(|l| l.contains("hello...")));

        buf.confirm_user("hello world".into());
        assert!(buf
            .display_lines()
            .iter()
            .any(|l| l.contains("hello world")));
        assert!(buf.partial_user.is_empty());
    }

    #[test]
    fn agent_transcript_flow() {
        let mut buf = TranscriptBuffer::new(10);
        buf.append_agent_delta("I found ");
        buf.append_agent_delta("5 results.");
        assert!(buf
            .display_lines()
            .iter()
            .any(|l| l.contains("I found 5 results.")));

        let final_text = buf.agent_finished();
        assert_eq!(final_text, "I found 5 results.");
        assert!(buf.agent_speaking.is_empty());
    }

    #[test]
    fn max_lines_trimming() {
        let mut buf = TranscriptBuffer::new(2);
        buf.confirm_user("line 1".into());
        buf.confirm_user("line 2".into());
        buf.confirm_user("line 3".into());
        assert_eq!(buf.confirmed_user.len(), 2);
        assert_eq!(buf.confirmed_user[0], "line 2");
        assert_eq!(buf.confirmed_user[1], "line 3");
    }

    #[test]
    fn clear_resets_everything() {
        let mut buf = TranscriptBuffer::new(10);
        buf.set_user_partial("partial".into());
        buf.confirm_user("confirmed".into());
        buf.set_agent_speaking("agent".into());
        buf.clear();
        assert!(buf.display_lines().is_empty());
    }

    #[test]
    fn mixed_user_and_agent_lines() {
        let mut buf = TranscriptBuffer::new(10);
        buf.confirm_user("user said".into());
        buf.set_agent_speaking("agent says".into());
        let lines = buf.display_lines();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("👤"));
        assert!(lines[1].contains("🤖"));
    }
}

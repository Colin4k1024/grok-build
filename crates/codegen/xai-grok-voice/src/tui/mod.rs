//! TUI integration for voice sessions.
//!
//! Provides a status indicator and a real-time transcript buffer that the
//! pager's terminal UI can embed.

pub mod indicator;
pub mod transcript;

pub use indicator::VoiceIndicator;
pub use transcript::TranscriptBuffer;

//! Realtime bidirectional voice session management.
//!
//! Provides the connection layer, message types, session state machine,
//! barge-in detection, and tool bridge for xAI Realtime voice conversations.

pub mod barge_in;
pub mod connection;
pub mod messages;
pub mod session;
pub mod tool_bridge;

pub use barge_in::BargeInDetector;
pub use connection::RealtimeConnection;
pub use messages::{ConversationItem, ResponseConfig};
pub use session::{VoiceSessionEvent, VoiceSessionManager, VoiceSessionState};
pub use tool_bridge::VoiceToolBridge;

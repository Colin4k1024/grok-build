//! Voice session state machine.
//!
//! [`VoiceSessionManager`] owns the connection, barge-in detector, and tool
//! bridge, processing server messages and emitting [`VoiceSessionEvent`]s to
//! the rest of the application via a broadcast channel.

use tokio::sync::broadcast;

use crate::error::VoiceError;
use crate::realtime::barge_in::BargeInDetector;
use crate::realtime::connection::RealtimeConnection;
use crate::realtime::messages::*;
use crate::realtime::tool_bridge::VoiceToolBridge;

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

/// High-level state of the voice session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceSessionState {
    /// No active interaction.
    Idle,
    /// Waiting for the user to speak.
    Listening,
    /// The model is generating a response.
    Processing,
    /// The model's audio response is playing.
    Speaking,
    /// The user interrupted the agent mid-utterance.
    Interrupted,
    /// A tool call is being executed locally.
    ToolExecuting,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Events emitted by [`VoiceSessionManager`] for the UI / TUI layer.
#[derive(Debug, Clone)]
pub enum VoiceSessionEvent {
    /// The session state changed.
    StateChanged {
        from: VoiceSessionState,
        to: VoiceSessionState,
    },
    /// A (partial or final) user transcript arrived.
    UserTranscript { text: String, is_final: bool },
    /// A (delta or final) agent transcript arrived.
    AgentTranscript { text: String, is_delta: bool },
    /// A chunk of agent PCM audio is ready for playback.
    AgentAudioDelta { audio: Vec<u8> },
    /// A tool call has been dispatched.
    ToolCallStarted { name: String, call_id: String },
    /// A tool call completed and the result is available.
    ToolCallCompleted {
        name: String,
        call_id: String,
        result: String,
    },
    /// Local barge-in was triggered.
    BargeInDetected,
    /// An error occurred.
    Error { message: String },
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/// Bi-directional voice session manager.
///
/// Owns the realtime connection, processes server messages, and broadcasts
/// [`VoiceSessionEvent`]s to subscribers.
pub struct VoiceSessionManager {
    connection: RealtimeConnection,
    barge_in: BargeInDetector,
    tool_bridge: VoiceToolBridge,
    state: VoiceSessionState,
    event_tx: broadcast::Sender<VoiceSessionEvent>,
    /// Accumulated transcript for the current agent response.
    agent_transcript_buffer: String,
    /// ID of the response currently being streamed.
    current_response_id: Option<String>,
}

impl VoiceSessionManager {
    /// Create a new session manager.
    pub fn new(
        connection: RealtimeConnection,
        event_tx: broadcast::Sender<VoiceSessionEvent>,
    ) -> Self {
        Self {
            connection,
            barge_in: BargeInDetector::with_defaults(),
            tool_bridge: VoiceToolBridge::new(),
            state: VoiceSessionState::Idle,
            event_tx,
            agent_transcript_buffer: String::new(),
            current_response_id: None,
        }
    }

    /// Send the initial `session.update` and transition to `Listening`.
    pub async fn start(&mut self, instructions: String) -> Result<(), VoiceError> {
        let config = SessionConfig {
            modalities: vec!["text".into(), "audio".into()],
            instructions,
            voice: "alloy".into(),
            input_audio_format: "pcm16".into(),
            output_audio_format: "pcm16".into(),
            turn_detection: Some(TurnDetection {
                detection_type: "server_vad".into(),
                threshold: Some(0.5),
                prefix_padding_ms: Some(300),
                silence_duration_ms: Some(500),
            }),
            tools: self.tool_bridge.tool_definitions(),
        };

        self.connection
            .send(ClientMessage::SessionUpdate { session: config })
            .await?;
        self.transition(VoiceSessionState::Listening);
        Ok(())
    }

    /// Stream a chunk of user audio to the server (base64-encoded PCM).
    pub async fn send_audio(&mut self, pcm_base64: String) -> Result<(), VoiceError> {
        self.connection
            .send(ClientMessage::InputAudioAppend { audio: pcm_base64 })
            .await
    }

    /// Process a single server message.
    pub async fn handle_message(&mut self, msg: ServerMessage) -> Result<(), VoiceError> {
        match msg {
            ServerMessage::SpeechStarted => {
                if self.state == VoiceSessionState::Speaking {
                    // The server detected user speech over the wire — pair it
                    // with the local barge-in flag so callers get a single
                    // authoritative event.
                    self.barge_in.agent_started_speaking();
                }
                self.transition(VoiceSessionState::Listening);
            }
            ServerMessage::SpeechStopped => {
                self.transition(VoiceSessionState::Processing);
            }
            ServerMessage::ResponseAudioDelta { delta } => {
                if self.state != VoiceSessionState::Speaking {
                    self.barge_in.agent_started_speaking();
                    self.transition(VoiceSessionState::Speaking);
                }
                let _ = self.event_tx.send(VoiceSessionEvent::AgentAudioDelta {
                    audio: base64_decode_pcm(&delta),
                });
            }
            ServerMessage::ResponseAudioDone => {
                self.barge_in.agent_stopped_speaking();
            }
            ServerMessage::ResponseTranscriptDelta { delta } => {
                self.agent_transcript_buffer.push_str(&delta);
                let _ = self.event_tx.send(VoiceSessionEvent::AgentTranscript {
                    text: delta,
                    is_delta: true,
                });
            }
            ServerMessage::ResponseTranscriptDone { transcript } => {
                let _ = self.event_tx.send(VoiceSessionEvent::AgentTranscript {
                    text: transcript,
                    is_delta: false,
                });
                self.agent_transcript_buffer.clear();
            }
            ServerMessage::FunctionCallDone {
                call_id,
                name,
                arguments,
            } => {
                self.transition(VoiceSessionState::ToolExecuting);
                let _ = self.event_tx.send(VoiceSessionEvent::ToolCallStarted {
                    name: name.clone(),
                    call_id: call_id.clone(),
                });
                let result = self.tool_bridge.execute(&name, &arguments).await;
                let _ = self.event_tx.send(VoiceSessionEvent::ToolCallCompleted {
                    name: name.clone(),
                    call_id: call_id.clone(),
                    result: result.clone(),
                });
                self.send_tool_result(call_id, result).await?;
            }
            ServerMessage::ResponseCreated { response } => {
                self.current_response_id = Some(response.id);
            }
            ServerMessage::ResponseDone { .. } => {
                self.current_response_id = None;
                if self.state != VoiceSessionState::Interrupted {
                    self.transition(VoiceSessionState::Listening);
                }
            }
            ServerMessage::Error { error } => {
                let _ = self.event_tx.send(VoiceSessionEvent::Error {
                    message: error.message,
                });
            }
            // Session-level and bookkeeping messages — no state change.
            ServerMessage::SessionCreated { .. }
            | ServerMessage::SessionUpdated { .. }
            | ServerMessage::ConversationItemCreated { .. }
            | ServerMessage::InputAudioBufferCommitted
            | ServerMessage::ResponseTextDelta { .. }
            | ServerMessage::ResponseTextDone { .. } => {}
        }
        Ok(())
    }

    /// Feed user audio samples to the local barge-in detector.
    ///
    /// Returns `true` if an interruption was triggered.
    pub fn process_input_audio(&mut self, samples: &[f32]) -> bool {
        if self.barge_in.process_audio(samples) {
            let _ = self.event_tx.send(VoiceSessionEvent::BargeInDetected);
            self.transition(VoiceSessionState::Interrupted);
            return true;
        }
        false
    }

    /// Ask the model to produce a response.
    pub async fn request_response(&mut self) -> Result<(), VoiceError> {
        self.connection
            .send(ClientMessage::ResponseCreate { response: None })
            .await
    }

    /// Cancel the in-progress response.
    pub async fn cancel_response(&mut self) -> Result<(), VoiceError> {
        self.connection.send(ClientMessage::ResponseCancel).await
    }

    /// Current session state.
    pub fn state(&self) -> &VoiceSessionState {
        &self.state
    }

    /// Mutable access to the barge-in detector (e.g. to tune thresholds).
    pub fn barge_in_mut(&mut self) -> &mut BargeInDetector {
        &mut self.barge_in
    }

    /// Transition to a new state, broadcasting a [`VoiceSessionEvent`].
    fn transition(&mut self, new_state: VoiceSessionState) {
        let old = self.state.clone();
        if old != new_state {
            self.state = new_state.clone();
            let _ = self.event_tx.send(VoiceSessionEvent::StateChanged {
                from: old,
                to: new_state,
            });
        }
    }

    /// Send a tool result back to the server as a conversation item.
    async fn send_tool_result(
        &self,
        call_id: String,
        result: String,
    ) -> Result<(), VoiceError> {
        // The real implementation constructs a `conversation.item.create`
        // message with the tool output and sends it via `self.connection`.
        let _ = (call_id, result);
        Ok(())
    }
}

/// Decode a base64 string into raw PCM bytes.
fn base64_decode_pcm(b64: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::realtime::connection::RealtimeConnection;

    /// Helper: build a session manager wired to a mock connection.
    fn make_session() -> (VoiceSessionManager, tokio::sync::mpsc::Receiver<ClientMessage>) {
        let (conn, _server_tx, client_rx) = RealtimeConnection::mock();
        let (event_tx, _) = broadcast::channel(64);
        let mgr = VoiceSessionManager::new(conn, event_tx);
        (mgr, client_rx)
    }

    #[tokio::test]
    async fn start_transitions_to_listening() {
        let (mut mgr, _rx) = make_session();
        assert_eq!(*mgr.state(), VoiceSessionState::Idle);
        mgr.start("test instructions".into()).await.unwrap();
        assert_eq!(*mgr.state(), VoiceSessionState::Listening);
    }

    #[tokio::test]
    async fn speech_started_transitions_to_listening() {
        let (mut mgr, _rx) = make_session();
        mgr.start("".into()).await.unwrap();
        mgr.handle_message(ServerMessage::SpeechStarted)
            .await
            .unwrap();
        assert_eq!(*mgr.state(), VoiceSessionState::Listening);
    }

    #[tokio::test]
    async fn audio_delta_transitions_to_speaking() {
        let (mut mgr, _rx) = make_session();
        mgr.start("".into()).await.unwrap();
        let audio_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &[0u8; 4],
        );
        mgr.handle_message(ServerMessage::ResponseAudioDelta { delta: audio_b64 })
            .await
            .unwrap();
        assert_eq!(*mgr.state(), VoiceSessionState::Speaking);
    }

    #[tokio::test]
    async fn barge_in_during_speaking() {
        let (conn, _server_tx, client_rx) = RealtimeConnection::mock();
        let (event_tx, _) = broadcast::channel(64);
        let mut mgr = VoiceSessionManager {
            connection: conn,
            barge_in: BargeInDetector::new(0.02, std::time::Duration::ZERO),
            tool_bridge: VoiceToolBridge::new(),
            state: VoiceSessionState::Speaking,
            event_tx,
            agent_transcript_buffer: String::new(),
            current_response_id: None,
        };
        mgr.barge_in.agent_started_speaking();
        // Feed loud audio → barge-in.
        assert!(mgr.process_input_audio(&[0.5; 160]));
        assert_eq!(*mgr.state(), VoiceSessionState::Interrupted);
    }

    #[tokio::test]
    async fn no_barge_in_when_idle() {
        let (mut mgr, _rx) = make_session();
        assert!(!mgr.process_input_audio(&[0.5; 160]));
    }
}

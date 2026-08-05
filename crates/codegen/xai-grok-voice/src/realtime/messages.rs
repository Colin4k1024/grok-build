//! Realtime API message types — client-to-server and server-to-client frames
//! for the xAI bidirectional voice WebSocket protocol.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

/// Input messages sent from the client to the xAI Realtime server.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    /// Update the session configuration (modalities, voice, tools, …).
    #[serde(rename = "session.update")]
    SessionUpdate { session: SessionConfig },

    /// Append a chunk of base64-encoded PCM audio to the input buffer.
    #[serde(rename = "input_audio_buffer.append")]
    InputAudioAppend { audio: String }, // base64 PCM

    /// Commit the buffered audio as a completed user utterance.
    #[serde(rename = "input_audio_buffer.commit")]
    InputAudioCommit,

    /// Discard any buffered audio without committing.
    #[serde(rename = "input_audio_buffer.clear")]
    InputAudioClear,

    /// Inject a conversation item (e.g. a text message) into the context.
    #[serde(rename = "conversation.item.create")]
    ConversationItemCreate { item: ConversationItem },

    /// Ask the model to produce a response (audio, text, or tool call).
    #[serde(rename = "response.create")]
    ResponseCreate { response: Option<ResponseConfig> },

    /// Cancel an in-progress response generation.
    #[serde(rename = "response.cancel")]
    ResponseCancel,
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/// Messages received from the xAI Realtime server.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    /// Session successfully created.
    #[serde(rename = "session.created")]
    SessionCreated { session: SessionInfo },

    /// Session configuration updated.
    #[serde(rename = "session.updated")]
    SessionUpdated { session: SessionInfo },

    /// A new conversation item was created on the server.
    #[serde(rename = "conversation.item.created")]
    ConversationItemCreated { item: ConversationItem },

    /// The input audio buffer was committed.
    #[serde(rename = "input_audio_buffer.committed")]
    InputAudioBufferCommitted,

    /// Server-side VAD detected the start of user speech.
    #[serde(rename = "input_audio_buffer.speech_started")]
    SpeechStarted,

    /// Server-side VAD detected the end of user speech.
    #[serde(rename = "input_audio_buffer.speech_stopped")]
    SpeechStopped,

    /// A new response has been created (may not yet be streaming).
    #[serde(rename = "response.created")]
    ResponseCreated { response: ResponseInfo },

    /// Incremental audio chunk in the response (base64 PCM).
    #[serde(rename = "response.audio.delta")]
    ResponseAudioDelta { delta: String }, // base64 PCM

    /// Response audio stream finished.
    #[serde(rename = "response.audio.done")]
    ResponseAudioDone,

    /// Incremental transcript of the response audio.
    #[serde(rename = "response.audio_transcript.delta")]
    ResponseTranscriptDelta { delta: String },

    /// Final transcript of the response audio.
    #[serde(rename = "response.audio_transcript.done")]
    ResponseTranscriptDone { transcript: String },

    /// Incremental text-only response delta.
    #[serde(rename = "response.text.delta")]
    ResponseTextDelta { delta: String },

    /// Completed text-only response.
    #[serde(rename = "response.text.done")]
    ResponseTextDone { text: String },

    /// A function call has completed — execute locally and return the result.
    #[serde(rename = "response.function_call_arguments.done")]
    FunctionCallDone {
        call_id: String,
        name: String,
        arguments: String,
    },

    /// The full response is complete.
    #[serde(rename = "response.done")]
    ResponseDone { response: ResponseInfo },

    /// Server-side error.
    #[serde(rename = "error")]
    Error { error: ErrorInfo },
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/// Marker trait so callers can name both halves of the protocol as one family.
pub trait RealtimeMessage {}

impl RealtimeMessage for ClientMessage {}
impl RealtimeMessage for ServerMessage {}

/// Session configuration sent with `session.update`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    /// Enabled modalities — e.g. `["text", "audio"]`.
    pub modalities: Vec<String>,
    /// System instructions for the model.
    pub instructions: String,
    /// TTS voice identifier (`"alloy"`, `"echo"`, …).
    pub voice: String,
    /// Audio encoding for the input stream (`"pcm16"`).
    pub input_audio_format: String,
    /// Audio encoding for the output stream (`"pcm16"`).
    pub output_audio_format: String,
    /// Server-side VAD / turn-detection settings.
    pub turn_detection: Option<TurnDetection>,
    /// Tool definitions the model may call.
    pub tools: Vec<ToolDefinition>,
}

/// Turn-detection (server-side VAD) settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnDetection {
    /// Detection strategy — `"server_vad"`.
    #[serde(rename = "type")]
    pub detection_type: String,
    /// VAD energy threshold (0.0–1.0).
    pub threshold: Option<f32>,
    /// How much audio before speech onset to include (ms).
    pub prefix_padding_ms: Option<u32>,
    /// Silence duration that marks end-of-speech (ms).
    pub silence_duration_ms: Option<u32>,
}

/// A tool the model is allowed to invoke.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Tool name (unique identifier).
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// JSON Schema for the tool's parameters.
    pub parameters: serde_json::Value,
}

/// A conversation item (user message, assistant message, tool result, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationItem {
    /// Server-assigned id (client may omit on create).
    pub id: Option<String>,
    /// `"user"`, `"assistant"`, or `"system"`.
    pub role: String,
    /// Item content parts.
    pub content: Vec<ItemContent>,
}

/// A single content block inside a [`ConversationItem`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemContent {
    /// Content type — `"input_audio"`, `"text"`, or `"audio"`.
    #[serde(rename = "type")]
    pub content_type: String,
    /// Base64-encoded audio (for `input_audio` / `audio` types).
    pub audio: Option<String>,
    /// Text content (for `text` type).
    pub text: Option<String>,
    /// Transcript of the audio (for `audio` type).
    pub transcript: Option<String>,
}

/// Optional overrides for a `response.create` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseConfig {
    /// Override response modalities.
    pub modalities: Option<Vec<String>>,
    /// Override response instructions.
    pub instructions: Option<String>,
}

/// Server-side session metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    /// Session identifier.
    pub id: String,
    /// Model powering the session.
    pub model: String,
}

/// Metadata for a response lifecycle event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseInfo {
    /// Response identifier.
    pub id: String,
    /// Current status — `"in_progress"`, `"completed"`, `"cancelled"`, …
    pub status: String,
}

/// Server error payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorInfo {
    /// Human-readable error description.
    pub message: String,
    /// Machine-readable error code (if any).
    pub code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_session_update_roundtrips() {
        let msg = ClientMessage::SessionUpdate {
            session: SessionConfig {
                modalities: vec!["text".into(), "audio".into()],
                instructions: "Be helpful.".into(),
                voice: "alloy".into(),
                input_audio_format: "pcm16".into(),
                output_audio_format: "pcm16".into(),
                turn_detection: Some(TurnDetection {
                    detection_type: "server_vad".into(),
                    threshold: Some(0.5),
                    prefix_padding_ms: Some(300),
                    silence_duration_ms: Some(500),
                }),
                tools: vec![],
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"session.update""#));
        assert!(json.contains(r#""voice":"alloy""#));
    }

    #[test]
    fn server_error_deserialises() {
        let json = r#"{
            "type": "error",
            "error": { "message": "rate limited", "code": "rate_limit" }
        }"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::Error { error } => {
                assert_eq!(error.message, "rate limited");
                assert_eq!(error.code.as_deref(), Some("rate_limit"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn server_audio_delta_deserialises() {
        let json = r#"{"type": "response.audio.delta", "delta": "AAAA"}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::ResponseAudioDelta { delta } => assert_eq!(delta, "AAAA"),
            other => panic!("expected ResponseAudioDelta, got {other:?}"),
        }
    }

    #[test]
    fn server_function_call_done_deserialises() {
        let json = r#"{
            "type": "response.function_call_arguments.done",
            "call_id": "call_1",
            "name": "search",
            "arguments": "{\"q\":\"rust\"}"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            ServerMessage::FunctionCallDone {
                call_id,
                name,
                arguments,
            } => {
                assert_eq!(call_id, "call_1");
                assert_eq!(name, "search");
                assert!(arguments.contains("rust"));
            }
            other => panic!("expected FunctionCallDone, got {other:?}"),
        }
    }
}

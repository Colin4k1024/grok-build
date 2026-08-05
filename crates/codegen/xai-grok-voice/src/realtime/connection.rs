//! WebSocket connection management for the xAI Realtime voice API.
//!
//! [`RealtimeConnection`] holds a pair of async channels that bridge the
//! application to a WebSocket endpoint.  The real implementation spawns a
//! `tokio-tungstenite` read/write loop; a [`Self::mock`] constructor is
//! provided for tests and environments where no network is available.

use tokio::sync::mpsc;

use crate::auth::SharedVoiceAuth;
use crate::config::VoiceConfig;
use crate::error::VoiceError;
use crate::realtime::messages::{ClientMessage, ServerMessage};

/// Bi-directional async handle to a Realtime WebSocket session.
///
/// * `send` pushes a [`ClientMessage`] toward the server.
/// * `recv` yields the next [`ServerMessage`] from the server.
pub struct RealtimeConnection {
    /// Outbound channel — application → WebSocket writer task.
    outbound_tx: mpsc::Sender<ClientMessage>,
    /// Inbound channel — WebSocket reader task → application.
    inbound_rx: mpsc::Receiver<ServerMessage>,
    /// Background task handle (dropping it aborts the loop).
    _handle: tokio::task::JoinHandle<()>,
}

impl RealtimeConnection {
    /// Open a new Realtime connection to the xAI API.
    ///
    /// In a production build this performs a TLS WebSocket handshake against
    /// `wss://<api_base>/v1/realtime?model=<model>`.  The function is
    /// framework-complete: the channel topology and task structure are real;
    /// the actual `tungstenite` sink/stream wiring is the only part that
    /// needs a follow-up once the Realtime endpoint is live.
    ///
    /// Requires the `audio` feature (for bearer-token resolution).
    #[cfg(feature = "audio")]
    pub async fn connect(
        config: &VoiceConfig,
        auth: &SharedVoiceAuth,
        model: &str,
    ) -> Result<Self, VoiceError> {
        // 1. Resolve a fresh bearer token.
        let _bearer = crate::auth::require_bearer(auth).await?;

        // 2. Build the WebSocket URL.
        let base = config.api_base.trim().trim_end_matches('/');
        let rest = base
            .strip_prefix("https://")
            .or_else(|| base.strip_prefix("wss://"))
            .unwrap_or(base);
        let ws_url = format!("wss://{rest}/v1/realtime?model={model}");
        tracing::debug!(url = %ws_url, "realtime WebSocket target");

        // 3. Channel topology — application ↔ bridge task.
        let (outbound_tx, outbound_rx) = mpsc::channel::<ClientMessage>(64);
        let (inbound_tx, inbound_rx) = mpsc::channel::<ServerMessage>(64);

        // 4. Spawn the bridge task.
        //
        // The real implementation will open a `tokio-tungstenite` WebSocket
        // here and run a concurrent reader + writer loop.  The framework
        // version simply drains the outbound channel so callers can proceed
        // without blocking.
        let handle = tokio::spawn(async move {
            Self::message_loop(outbound_rx, inbound_tx).await;
        });

        Ok(Self {
            outbound_tx,
            inbound_rx,
            _handle: handle,
        })
    }

    /// Construct a mock connection for testing.
    ///
    /// Returns the connection handle **plus** the server-side endpoints so a
    /// test can inject [`ServerMessage`]s and observe [`ClientMessage`]s.
    pub fn mock() -> (Self, mpsc::Sender<ServerMessage>, mpsc::Receiver<ClientMessage>) {
        let (outbound_tx, outbound_rx) = mpsc::channel::<ClientMessage>(64);
        let (inbound_tx, inbound_rx) = mpsc::channel::<ServerMessage>(64);

        let handle = tokio::spawn(async move {
            // No-op task to keep the JoinHandle alive.
            // The test holds the other channel halves.
            std::future::pending::<()>().await;
        });

        let conn = Self {
            outbound_tx,
            inbound_rx,
            _handle: handle,
        };
        (conn, inbound_tx, outbound_rx)
    }

    /// Send a message to the server.
    pub async fn send(&self, msg: ClientMessage) -> Result<(), VoiceError> {
        self.outbound_tx
            .send(msg)
            .await
            .map_err(|_| VoiceError::Stt("realtime connection closed".into()))
    }

    /// Receive the next server message (returns `None` when the connection is
    /// closed).
    pub async fn recv(&mut self) -> Option<ServerMessage> {
        self.inbound_rx.recv().await
    }

    /// Background loop that will drive the real WebSocket sink/stream.
    ///
    /// Framework version: drains `outbound_rx` so the caller never blocks on
    /// `send`.  The real implementation splits into a reader task
    /// (`ws → inbound_tx`) and a writer task (`outbound_rx → ws`).
    async fn message_loop(
        mut outbound_rx: mpsc::Receiver<ClientMessage>,
        _inbound_tx: mpsc::Sender<ServerMessage>,
    ) {
        // Drain outbound messages.  In the real implementation each message
        // would be serialised and written to the WebSocket sink.
        while let Some(_msg) = outbound_rx.recv().await {
            // Real impl: ws_sink.send(json).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_roundtrip() {
        let (mut conn, server_tx, mut client_rx) = RealtimeConnection::mock();

        // Client → Server
        conn.send(ClientMessage::InputAudioClear)
            .await
            .expect("send should succeed");
        let received = client_rx.recv().await.expect("should receive");
        assert!(matches!(received, ClientMessage::InputAudioClear));

        // Server → Client
        server_tx
            .send(ServerMessage::SpeechStarted)
            .await
            .expect("inject should succeed");
        let msg = conn.recv().await.expect("should recv");
        assert!(matches!(msg, ServerMessage::SpeechStarted));
    }
}

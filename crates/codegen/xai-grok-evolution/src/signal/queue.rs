//! Bounded signal queue for async signal processing.
//!
//! Uses a `tokio::sync::mpsc::bounded_channel` for backpressure.
//! The queue is consumed by the evolution engine's background task.
//! When the channel is full, new signals are dropped (Shadow mode)
//! or the sender blocks (IsolatedAutonomous mode).

use tokio::sync::mpsc;

use crate::types::EvolutionSignal;

/// Default bounded queue capacity.
pub const DEFAULT_QUEUE_CAPACITY: usize = 32;

/// Async bounded signal queue.
///
/// Signals are enqueued at turn end and consumed by the evolution
/// engine's background task. The bounded channel provides automatic
/// backpressure: when full, `try_send` returns an error.
pub struct SignalQueue {
    tx: mpsc::Sender<Vec<EvolutionSignal>>,
    rx: mpsc::Receiver<Vec<EvolutionSignal>>,
}

impl SignalQueue {
    /// Create a new signal queue with the given capacity.
    pub fn new(capacity: usize) -> Self {
        let (tx, rx) = mpsc::channel(capacity);
        Self { tx, rx }
    }

    /// Create a queue with default capacity (32).
    pub fn with_default_capacity() -> Self {
        Self::new(DEFAULT_QUEUE_CAPACITY)
    }

    /// Try to enqueue a batch of signals (non-blocking).
    ///
    /// Returns `Err(signals)` if the queue is full (backpressure).
    pub fn try_enqueue(&self, signals: Vec<EvolutionSignal>) -> Result<(), Vec<EvolutionSignal>> {
        self.tx.try_send(signals).map_err(|e| {
            match e {
                mpsc::error::TrySendError::Full(signals) => signals,
                mpsc::error::TrySendError::Closed(signals) => signals,
            }
        })
    }

    /// Enqueue a batch of signals (blocking, waits for capacity).
    pub async fn enqueue(&self, signals: Vec<EvolutionSignal>) -> Result<(), Vec<EvolutionSignal>> {
        self.tx.send(signals).await.map_err(|e| e.0)
    }

    /// Dequeue the next batch of signals (blocking).
    pub async fn dequeue(&mut self) -> Option<Vec<EvolutionSignal>> {
        self.rx.recv().await
    }

    /// Try to dequeue without blocking (returns None if empty).
    pub fn try_dequeue(&mut self) -> Option<Vec<EvolutionSignal>> {
        self.rx.try_recv().ok()
    }

    /// Get a sender handle for use by signal producers.
    pub fn sender(&self) -> mpsc::Sender<Vec<EvolutionSignal>> {
        self.tx.clone()
    }

    /// Get the current queue length (approximate, for metrics).
    ///
    /// Note: `mpsc` channels don't expose exact length.
    /// This always returns 0; use external metrics instead.
    pub fn is_empty(&self) -> bool {
        // mpsc doesn't expose exact len; use metrics instead
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    fn sample_signal(id: &str) -> EvolutionSignal {
        EvolutionSignal {
            signal_id: id.to_string(),
            schema_version: 1,
            signal_type: SignalType::ToolFailure,
            severity: SignalSeverity::Medium,
            source: SignalSource {
                session_id: "s".to_string(),
                turn_id: None,
                tool_name: None,
                file_path: None,
            },
            description: "test".to_string(),
            context_hash: "aaa".to_string(),
            created_at: 1000,
        }
    }

    #[test]
    fn enqueue_and_dequeue_sync() {
        let mut queue = SignalQueue::new(10);
        let signals = vec![sample_signal("1"), sample_signal("2")];
        queue.try_enqueue(signals).unwrap();

        let batch = queue.try_dequeue().unwrap();
        assert_eq!(batch.len(), 2);
    }

    #[test]
    fn backpressure_on_full_queue() {
        let queue = SignalQueue::new(1);
        queue.try_enqueue(vec![sample_signal("1")]).unwrap();

        // Second enqueue should fail (backpressure)
        let result = queue.try_enqueue(vec![sample_signal("2")]);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().len(), 1); // signals returned
    }

    #[tokio::test]
    async fn async_enqueue_dequeue() {
        let mut queue = SignalQueue::new(10);
        queue.enqueue(vec![sample_signal("1")]).await.unwrap();

        let batch = queue.dequeue().await.unwrap();
        assert_eq!(batch.len(), 1);
    }

    #[tokio::test]
    async fn dequeue_returns_none_when_empty_and_closed() {
        let queue = SignalQueue::new(10);
        let mut rx = queue.rx;
        drop(queue.tx); // drop all senders to close the channel
        let result = rx.recv().await;
        assert!(result.is_none());
    }
}

//! Local VAD-based barge-in detector.
//!
//! Runs on the client side to detect whether the user has started speaking
//! while the agent is producing audio.  The goal is sub-200 ms interruption
//! latency so the conversation feels natural.

/// Barge-in detector — low-latency local VAD that fires when the user begins
/// speaking while the agent is playing audio.
#[derive(Debug)]
pub struct BargeInDetector {
    /// RMS energy threshold — audio above this is considered speech.
    vad_threshold: f32,
    /// Minimum continuous speech duration required before triggering.
    min_speech_duration: std::time::Duration,
    /// Whether the agent is currently speaking.
    agent_speaking: bool,
    /// Instant at which sustained speech was first detected.
    speech_start: Option<std::time::Instant>,
}

impl BargeInDetector {
    /// Create a detector with explicit parameters.
    pub fn new(vad_threshold: f32, min_speech_duration: std::time::Duration) -> Self {
        Self {
            vad_threshold,
            min_speech_duration,
            agent_speaking: false,
            speech_start: None,
        }
    }

    /// Create a detector with production defaults.
    pub fn with_defaults() -> Self {
        Self::new(0.02, std::time::Duration::from_millis(150))
    }

    /// Mark that the agent has started producing audio.
    pub fn agent_started_speaking(&mut self) {
        self.agent_speaking = true;
        self.speech_start = None;
    }

    /// Mark that the agent has stopped producing audio.
    pub fn agent_stopped_speaking(&mut self) {
        self.agent_speaking = false;
        self.speech_start = None;
    }

    /// Feed a chunk of audio samples and check whether barge-in should fire.
    ///
    /// `audio_samples` are `f32` PCM samples in the range `[-1.0, 1.0]`.
    /// Returns `true` exactly once per interruption event.
    pub fn process_audio(&mut self, audio_samples: &[f32]) -> bool {
        if !self.agent_speaking {
            self.speech_start = None;
            return false;
        }

        let rms = compute_rms(audio_samples);
        if rms > self.vad_threshold {
            let now = std::time::Instant::now();
            let start = self.speech_start.get_or_insert(now);
            if now.duration_since(*start) >= self.min_speech_duration {
                // Sustained speech detected → trigger interruption.
                self.agent_speaking = false;
                self.speech_start = None;
                return true;
            }
        } else {
            // Below threshold — reset the speech timer.
            self.speech_start = None;
        }
        false
    }

    /// Whether speech is currently being detected (started but not yet long
    /// enough to trigger).
    pub fn is_detecting(&self) -> bool {
        self.speech_start.is_some()
    }
}

/// Compute the root-mean-square energy of a slice of `f32` samples.
fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_barge_in_when_not_speaking() {
        let mut det = BargeInDetector::with_defaults();
        // Loud audio but agent isn't speaking → no trigger.
        assert!(!det.process_audio(&[0.5; 160]));
    }

    #[test]
    fn barge_in_after_threshold() {
        let mut det = BargeInDetector::new(0.01, std::time::Duration::from_millis(0));
        det.agent_started_speaking();
        // Loud audio + zero min duration → immediate barge-in.
        assert!(det.process_audio(&[0.5; 160]));
        assert!(!det.agent_speaking);
    }

    #[test]
    fn no_barge_in_on_silence() {
        let mut det = BargeInDetector::with_defaults();
        det.agent_started_speaking();
        // Near-silent audio → no trigger.
        assert!(!det.process_audio(&[0.001; 160]));
    }

    #[test]
    fn rms_computation() {
        assert!((compute_rms(&[]) - 0.0).abs() < f32::EPSILON);
        assert!((compute_rms(&[1.0, -1.0]) - 1.0).abs() < 0.01);
    }

    #[test]
    fn detecting_flag_set_during_speech() {
        let mut det = BargeInDetector::new(0.01, std::time::Duration::from_secs(10));
        det.agent_started_speaking();
        // Below min duration → `is_detecting` should be true but no trigger.
        assert!(!det.process_audio(&[0.5; 160]));
        assert!(det.is_detecting());
    }

    #[test]
    fn reset_on_silence_gap() {
        let mut det = BargeInDetector::new(0.01, std::time::Duration::from_secs(10));
        det.agent_started_speaking();
        // Start detecting.
        det.process_audio(&[0.5; 160]);
        assert!(det.is_detecting());
        // Silence resets the timer.
        det.process_audio(&[0.001; 160]);
        assert!(!det.is_detecting());
    }
}

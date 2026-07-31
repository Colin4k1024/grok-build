//! `ScheduleWakeup` tool — dynamic loop self-pacing.
//!
//! Allows the agent to schedule its own next wakeup in `/loop` dynamic mode,
//! choosing when to resume based on what it's waiting for.

use serde::{Deserialize, Serialize};

/// Minimum delay in seconds (clamped).
const MIN_DELAY_SECS: u64 = 60;
/// Maximum delay in seconds (clamped).
const MAX_DELAY_SECS: u64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleWakeupInput {
    #[serde(default)]
    pub delay_seconds: Option<u64>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub stop: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleWakeupOutput {
    pub scheduled: bool,
    pub delay_seconds: u64,
    pub reason: String,
    pub stopped: bool,
}

pub fn execute(input: &ScheduleWakeupInput) -> ScheduleWakeupOutput {
    if input.stop.unwrap_or(false) {
        return ScheduleWakeupOutput {
            scheduled: false,
            delay_seconds: 0,
            reason: "loop stopped by agent".to_string(),
            stopped: true,
        };
    }

    let raw_delay = input.delay_seconds.unwrap_or(MIN_DELAY_SECS);
    let clamped = raw_delay.clamp(MIN_DELAY_SECS, MAX_DELAY_SECS);
    let reason = input.reason.clone().unwrap_or_else(|| "waiting".to_string());

    ScheduleWakeupOutput {
        scheduled: true,
        delay_seconds: clamped,
        reason,
        stopped: false,
    }
}

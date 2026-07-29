//! Kill switch: immediate emergency shutdown of evolution.
//!
//! The kill switch can be activated by:
//! - CLI: `--no-evolution` or `GROK_EVOLUTION=off`
//! - TUI: Control tab emergency button
//! - Automatic: circuit breaker trip
//! - User: explicit revocation after quality regression
//!
//! When active:
//! - All evolution tasks are cancelled
//! - No new trials are started
//! - No experiences are injected
//! - Mode is forced to Off
//! - Existing projections are preserved (read-only)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Thread-safe kill switch state.
///
/// Uses atomic operations for lock-free reads. The kill switch
/// is designed to be checked at every pipeline entry point.
#[derive(Debug, Clone)]
pub struct KillSwitch {
    active: Arc<AtomicBool>,
    reason: Arc<std::sync::Mutex<Option<String>>>,
}

impl KillSwitch {
    /// Create a new kill switch (initially inactive).
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            reason: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Check if the kill switch is active.
    ///
    /// This is a lock-free atomic read — safe to call at every
    /// pipeline entry point without performance concern.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    /// Activate the kill switch with a reason.
    pub fn activate(&self, reason: String) {
        if let Ok(mut r) = self.reason.lock() {
            *r = Some(reason.clone());
        }
        self.active.store(true, Ordering::Release);
    }

    /// Deactivate the kill switch.
    pub fn deactivate(&self) {
        self.active.store(false, Ordering::Release);
        if let Ok(mut r) = self.reason.lock() {
            *r = None;
        }
    }

    /// Get the activation reason (if active).
    pub fn reason(&self) -> Option<String> {
        self.reason.lock().ok()?.clone()
    }

    /// Guard: returns `Ok(())` if not active, `Err(reason)` if active.
    ///
    /// Use this at pipeline entry points:
    /// ```ignore
    /// kill_switch.check()?;
    /// ```
    pub fn check(&self) -> Result<(), String> {
        if self.is_active() {
            Err(self.reason().unwrap_or_else(|| "kill switch active".to_string()))
        } else {
            Ok(())
        }
    }
}

impl Default for KillSwitch {
    fn default() -> Self {
        Self::new()
    }
}

/// Global kill switch (process-wide singleton).
///
/// Initialized as inactive. All evolution components should check
/// this before starting trials or injecting experiences.
static GLOBAL_KILL_SWITCH: std::sync::OnceLock<KillSwitch> = std::sync::OnceLock::new();

/// Get the global kill switch.
pub fn global_kill_switch() -> &'static KillSwitch {
    GLOBAL_KILL_SWITCH.get_or_init(KillSwitch::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_kill_switch_is_inactive() {
        let ks = KillSwitch::new();
        assert!(!ks.is_active());
        assert!(ks.reason().is_none());
    }

    #[test]
    fn activate_and_check() {
        let ks = KillSwitch::new();
        ks.activate("test emergency".to_string());
        assert!(ks.is_active());
        assert_eq!(ks.reason(), Some("test emergency".to_string()));
        assert!(ks.check().is_err());
    }

    #[test]
    fn deactivate_clears_state() {
        let ks = KillSwitch::new();
        ks.activate("test".to_string());
        ks.deactivate();
        assert!(!ks.is_active());
        assert!(ks.reason().is_none());
        assert!(ks.check().is_ok());
    }

    #[test]
    fn clone_shares_state() {
        let ks1 = KillSwitch::new();
        let ks2 = ks1.clone();
        ks1.activate("shared".to_string());
        assert!(ks2.is_active());
    }

    #[test]
    fn check_returns_ok_when_inactive() {
        let ks = KillSwitch::new();
        assert!(ks.check().is_ok());
    }
}

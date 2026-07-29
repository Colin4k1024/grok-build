//! EvolutionRun lifecycle state machine.
//!
//! ```text
//!             ┌─────────┐
//!             │ Running  │
//!             └────┬────┘
//!                  │
//!       ┌──────────┼──────────┐
//!       ▼          ▼          ▼
//! ┌──────────┐ ┌─────────┐ ┌───────────┐
//! │Completed │ │ Failed  │ │ Abandoned │
//! └──────────┘ └─────────┘ └───────────┘
//! ```

use crate::error::EvolutionError;
use crate::types::RunState;

/// Attempt a state transition. Returns `Ok(new_state)` on success.
pub fn transition(from: RunState, to: RunState) -> Result<RunState, EvolutionError> {
    use RunState::*;

    let valid = matches!(
        (from, to),
        (Running, Completed) | (Running, Failed) | (Running, Abandoned)
    );

    if valid {
        Ok(to)
    } else {
        Err(EvolutionError::InvalidTransition {
            from: format!("{:?}", from),
            to: format!("{:?}", to),
        })
    }
}

/// Returns all legal target states from a given state.
pub fn valid_targets(from: RunState) -> Vec<RunState> {
    use RunState::*;

    match from {
        Running => vec![Completed, Failed, Abandoned],
        Completed | Failed | Abandoned => vec![],
    }
}

/// Returns `true` if the run has reached a terminal state.
pub fn is_terminal(state: RunState) -> bool {
    !matches!(state, RunState::Running)
}

#[cfg(test)]
mod tests {
    use super::*;
    use RunState::*;

    #[test]
    fn running_can_complete() {
        assert_eq!(transition(Running, Completed).unwrap(), Completed);
    }

    #[test]
    fn running_can_fail() {
        assert_eq!(transition(Running, Failed).unwrap(), Failed);
    }

    #[test]
    fn running_can_abandon() {
        assert_eq!(transition(Running, Abandoned).unwrap(), Abandoned);
    }

    #[test]
    fn completed_is_terminal() {
        assert!(transition(Completed, Running).is_err());
        assert!(transition(Completed, Failed).is_err());
        assert!(is_terminal(Completed));
    }

    #[test]
    fn failed_is_terminal() {
        assert!(transition(Failed, Running).is_err());
        assert!(is_terminal(Failed));
    }

    #[test]
    fn abandoned_is_terminal() {
        assert!(transition(Abandoned, Running).is_err());
        assert!(is_terminal(Abandoned));
    }

    #[test]
    fn running_is_not_terminal() {
        assert!(!is_terminal(Running));
    }

    #[test]
    fn valid_targets_exhaustive() {
        for state in [Running, Completed, Failed, Abandoned] {
            let targets = valid_targets(state);
            for candidate in [Running, Completed, Failed, Abandoned] {
                let is_valid = transition(state, candidate).is_ok();
                let in_list = targets.contains(&candidate);
                assert_eq!(is_valid, in_list, "{:?} -> {:?}", state, candidate);
            }
        }
    }
}

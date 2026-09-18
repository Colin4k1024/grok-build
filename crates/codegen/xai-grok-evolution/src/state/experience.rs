//! ExperienceRevision lifecycle state machine.
//!
//! ```text
//! Candidate ──────┬────→ Active ────→ Decaying ────→ Revalidating
//!     │           │         │              │              │
//!     │           │         │              │              ├──→ Active (revalidation success)
//!     │           │         │              │              └──→ Quarantined (revalidation failure)
//!     │           │         │              │
//!     │           │         │              └──→ Revoked (confidence < 0.05, no reuse in N days)
//!     │           │         │
//!     └───────────┴─────────┴──→ Quarantined ────→ Revoked
//! ```

use crate::error::EvolutionError;
use crate::types::ExperienceState;

/// Attempt a state transition. Returns `Ok(new_state)` on success.
///
/// All illegal transitions are rejected with `EvolutionError::InvalidTransition`.
pub fn transition(from: ExperienceState, to: ExperienceState) -> Result<ExperienceState, EvolutionError> {
    use ExperienceState::*;

    let valid = matches!(
        (from, to),
        (Candidate, Active)
            | (Candidate, Quarantined)
            | (Active, Decaying)
            | (Active, Quarantined)
            | (Decaying, Revalidating)
            | (Decaying, Revoked)
            | (Revalidating, Active)
            | (Revalidating, Quarantined)
            | (Quarantined, Revoked)
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
pub fn valid_targets(from: ExperienceState) -> Vec<ExperienceState> {
    use ExperienceState::*;

    match from {
        Candidate => vec![Active, Quarantined],
        Active => vec![Decaying, Quarantined],
        Decaying => vec![Revalidating, Revoked],
        Revalidating => vec![Active, Quarantined],
        Quarantined => vec![Revoked],
        Revoked => vec![],
    }
}

/// Returns `true` if the state is terminal (no further transitions).
pub fn is_terminal(state: ExperienceState) -> bool {
    matches!(state, ExperienceState::Revoked)
}

/// Returns `true` if the experience can be injected into prompts.
pub fn is_injectable(state: ExperienceState) -> bool {
    matches!(state, ExperienceState::Active)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ExperienceState::*;

    #[test]
    fn candidate_can_become_active() {
        assert_eq!(transition(Candidate, Active).unwrap(), Active);
    }

    #[test]
    fn candidate_can_be_quarantined() {
        assert_eq!(transition(Candidate, Quarantined).unwrap(), Quarantined);
    }

    #[test]
    fn candidate_cannot_jump_to_decaying() {
        let result = transition(Candidate, Decaying);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            EvolutionError::InvalidTransition { .. }
        ));
    }

    #[test]
    fn active_can_decay() {
        assert_eq!(transition(Active, Decaying).unwrap(), Decaying);
    }

    #[test]
    fn active_can_be_quarantined() {
        assert_eq!(transition(Active, Quarantined).unwrap(), Quarantined);
    }

    #[test]
    fn active_cannot_go_back_to_candidate() {
        assert!(transition(Active, Candidate).is_err());
    }

    #[test]
    fn decaying_can_revalidate() {
        assert_eq!(transition(Decaying, Revalidating).unwrap(), Revalidating);
    }

    #[test]
    fn decaying_can_be_revoked() {
        assert_eq!(transition(Decaying, Revoked).unwrap(), Revoked);
    }

    #[test]
    fn revalidating_can_reactivate() {
        assert_eq!(transition(Revalidating, Active).unwrap(), Active);
    }

    #[test]
    fn revalidating_can_be_quarantined() {
        assert_eq!(
            transition(Revalidating, Quarantined).unwrap(),
            Quarantined
        );
    }

    #[test]
    fn revalidating_cannot_go_directly_to_revoked() {
        assert!(transition(Revalidating, Revoked).is_err());
    }

    #[test]
    fn quarantined_can_be_revoked() {
        assert_eq!(transition(Quarantined, Revoked).unwrap(), Revoked);
    }

    #[test]
    fn quarantined_cannot_reactivate() {
        assert!(transition(Quarantined, Active).is_err());
    }

    #[test]
    fn revoked_is_terminal() {
        assert!(is_terminal(Revoked));
        assert!(!is_terminal(Active));
        assert!(!is_terminal(Quarantined));
    }

    #[test]
    fn only_active_is_injectable() {
        assert!(is_injectable(Active));
        assert!(!is_injectable(Candidate));
        assert!(!is_injectable(Decaying));
        assert!(!is_injectable(Revalidating));
        assert!(!is_injectable(Quarantined));
        assert!(!is_injectable(Revoked));
    }

    #[test]
    fn valid_targets_are_complete() {
        for state in [Candidate, Active, Decaying, Revalidating, Quarantined, Revoked] {
            let targets = valid_targets(state);
            for target in &targets {
                assert!(transition(state, *target).is_ok());
            }
            // Verify no valid transitions were missed
            for candidate in [Candidate, Active, Decaying, Revalidating, Quarantined, Revoked] {
                let is_valid = transition(state, candidate).is_ok();
                let in_list = targets.contains(&candidate);
                assert_eq!(is_valid, in_list, "State {:?} -> {:?}: valid={}, in_list={}", state, candidate, is_valid, in_list);
            }
        }
    }

    #[test]
    fn all_illegal_transitions_rejected() {
        let all_states = [Candidate, Active, Decaying, Revalidating, Quarantined, Revoked];
        for &from in &all_states {
            for &to in &all_states {
                let result = transition(from, to);
                let targets = valid_targets(from);
                if targets.contains(&to) {
                    assert!(result.is_ok(), "Expected Ok for {:?} -> {:?}", from, to);
                } else {
                    assert!(result.is_err(), "Expected Err for {:?} -> {:?}", from, to);
                }
            }
        }
    }
}

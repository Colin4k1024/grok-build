//! Promotion logic: Candidate → Active.

use crate::types::*;

/// Check if a Candidate experience should be promoted to Active.
///
/// Requirements:
/// - State must be Candidate
/// - success_count >= promote_after_successes
/// - failure_count == 0 (no failures allowed for auto-promotion)
pub fn check(exp: &ExperienceRevision, promote_after: u32) -> Option<ConfidenceState> {
    if exp.state != ExperienceState::Candidate {
        return None;
    }

    if exp.success_count >= promote_after && exp.failure_count == 0 {
        Some(ConfidenceState::Active {
            confidence: crate::state::confidence::initial_confidence(exp.success_count),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candidate(successes: u32, failures: u32) -> ExperienceRevision {
        ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state: ExperienceState::Candidate,
            confidence: 0.0,
            success_count: successes,
            failure_count: failures,
            scope: ScopeFingerprint {
                repo: None,
                task_type: None,
                signal_types: vec![],
                env_fingerprint: None,
            },
            content_hash: "abc".to_string(),
            created_at: 1000,
            updated_at: 1000,
        }
    }

    #[test]
    fn promotes_with_enough_successes() {
        let exp = make_candidate(3, 0);
        let result = check(&exp, 3);
        assert!(result.is_some());
    }

    #[test]
    fn does_not_promote_with_failures() {
        let exp = make_candidate(3, 1);
        assert!(check(&exp, 3).is_none());
    }

    #[test]
    fn does_not_promote_not_enough_successes() {
        let exp = make_candidate(2, 0);
        assert!(check(&exp, 3).is_none());
    }

    #[test]
    fn does_not_promote_non_candidate() {
        let mut exp = make_candidate(5, 0);
        exp.state = ExperienceState::Active;
        assert!(check(&exp, 3).is_none());
    }
}

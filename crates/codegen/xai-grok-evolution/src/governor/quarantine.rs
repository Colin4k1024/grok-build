//! Quarantine logic: detect when an experience should be isolated.

use crate::events::{QuarantineReason, QuarantineReasonType};
use crate::types::*;

/// Check if an experience should be quarantined.
///
/// Triggers:
/// - Consecutive failures exceed threshold
/// - State is Active and failure_count >= quarantine_after_failures
pub fn check(exp: &ExperienceRevision, quarantine_after_failures: u32) -> Option<QuarantineReason> {
    // Only quarantine Candidate or Active experiences
    if !matches!(exp.state, ExperienceState::Candidate | ExperienceState::Active) {
        return None;
    }

    if exp.failure_count >= quarantine_after_failures {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        Some(QuarantineReason {
            reason_type: QuarantineReasonType::ConsecutiveFailures,
            description: format!(
                "{} consecutive failures (threshold: {})",
                exp.failure_count, quarantine_after_failures
            ),
            triggering_run_id: None,
            quarantined_at: now,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_exp(state: ExperienceState, failures: u32) -> ExperienceRevision {
        ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state,
            confidence: 0.5,
            success_count: 1,
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
    fn quarantines_on_threshold() {
        let exp = make_exp(ExperienceState::Candidate, 2);
        let result = check(&exp, 2);
        assert!(result.is_some());
        assert_eq!(result.unwrap().reason_type, QuarantineReasonType::ConsecutiveFailures);
    }

    #[test]
    fn does_not_quarantine_below_threshold() {
        let exp = make_exp(ExperienceState::Candidate, 1);
        assert!(check(&exp, 2).is_none());
    }

    #[test]
    fn does_not_quarantine_revoked() {
        let exp = make_exp(ExperienceState::Revoked, 5);
        assert!(check(&exp, 2).is_none());
    }

    #[test]
    fn quarantines_active_on_failures() {
        let exp = make_exp(ExperienceState::Active, 2);
        assert!(check(&exp, 2).is_some());
    }
}

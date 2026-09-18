//! Experience selection: filtering and ranking.
//!
//! Selects the best experience for a given context from the pool of
//! available (Active) experiences. Each autonomous run selects at most
//! one main experience and up to three read-only references.

use crate::error::EvolutionError;
use crate::types::*;

pub mod ranking;

/// Result of the selection phase.
#[derive(Debug, Clone)]
pub struct SelectionResult {
    /// The single main experience for this run (if any matched).
    pub main: Option<ExperienceRevision>,
    /// Up to three read-only reference experiences.
    pub references: Vec<ExperienceRevision>,
}

/// Context for experience selection.
#[derive(Debug, Clone)]
pub struct SelectionContext {
    /// Repository identifier.
    pub repo: Option<String>,
    /// Task type inferred from the current session.
    pub task_type: Option<String>,
    /// Signal types detected in this session.
    pub signal_types: Vec<SignalType>,
    /// Environment fingerprint.
    pub env_fingerprint: Option<String>,
    /// Current timestamp (epoch seconds).
    pub now: i64,
}

/// Select the best matching experience for a given context.
///
/// Filtering rules:
/// 1. Only `Active` experiences are eligible.
/// 2. Scope must match on repo, task_type, or signal_types.
/// 3. Exclude experiences with expired contraindications.
///
/// Ranking:
/// - Semantic match score × confidence × recency boost.
///
/// Returns at most one main experience and up to three references.
pub fn select(
    candidates: &[ExperienceRevision],
    ctx: &SelectionContext,
) -> Result<SelectionResult, EvolutionError> {
    // Filter: only Active
    let active: Vec<&ExperienceRevision> = candidates
        .iter()
        .filter(|c| c.state == ExperienceState::Active)
        .collect();

    if active.is_empty() {
        return Ok(SelectionResult {
            main: None,
            references: vec![],
        });
    }

    // Score and rank
    let mut scored: Vec<(f64, &ExperienceRevision)> = active
        .iter()
        .map(|exp| (ranking::score(exp, ctx), *exp))
        .filter(|(score, _)| *score > 0.0)
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let main = scored.first().map(|(_, exp)| (*exp).clone());
    let references: Vec<ExperienceRevision> = scored
        .iter()
        .skip(1)
        .take(3)
        .map(|(_, exp)| (*exp).clone())
        .collect();

    Ok(SelectionResult { main, references })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_experience(id: &str, state: ExperienceState, confidence: f64) -> ExperienceRevision {
        ExperienceRevision {
            experience_id: id.to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state,
            confidence,
            success_count: 3,
            failure_count: 0,
            scope: ScopeFingerprint {
                repo: Some("org/repo".to_string()),
                task_type: Some("bug_fix".to_string()),
                signal_types: vec![SignalType::TestFailure],
                env_fingerprint: None,
            },
            content_hash: "abc".to_string(),
            created_at: 1000,
            updated_at: 1000,
        }
    }

    fn make_ctx() -> SelectionContext {
        SelectionContext {
            repo: Some("org/repo".to_string()),
            task_type: Some("bug_fix".to_string()),
            signal_types: vec![SignalType::TestFailure],
            env_fingerprint: None,
            now: 2000,
        }
    }

    #[test]
    fn empty_candidates_returns_none() {
        let result = select(&[], &make_ctx()).unwrap();
        assert!(result.main.is_none());
        assert!(result.references.is_empty());
    }

    #[test]
    fn only_active_selected() {
        let candidates = vec![
            make_experience("exp-1", ExperienceState::Candidate, 0.5),
            make_experience("exp-2", ExperienceState::Active, 0.8),
            make_experience("exp-3", ExperienceState::Quarantined, 0.9),
        ];
        let result = select(&candidates, &make_ctx()).unwrap();
        assert!(result.main.is_some());
        assert_eq!(result.main.unwrap().experience_id, "exp-2");
    }

    #[test]
    fn highest_score_selected_as_main() {
        let candidates = vec![
            make_experience("exp-low", ExperienceState::Active, 0.3),
            make_experience("exp-high", ExperienceState::Active, 0.9),
        ];
        let result = select(&candidates, &make_ctx()).unwrap();
        assert_eq!(result.main.unwrap().experience_id, "exp-high");
    }

    #[test]
    fn references_limited_to_three() {
        let mut candidates = Vec::new();
        for i in 0..5 {
            candidates.push(make_experience(
                &format!("exp-{}", i),
                ExperienceState::Active,
                0.5 + i as f64 * 0.1,
            ));
        }
        let result = select(&candidates, &make_ctx()).unwrap();
        assert!(result.main.is_some());
        assert!(result.references.len() <= 3);
    }
}

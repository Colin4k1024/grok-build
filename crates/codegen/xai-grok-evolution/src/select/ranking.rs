//! Ranking logic for experience selection.
//!
//! Combines semantic match, confidence, and recency into a single score.

use super::SelectionContext;
use crate::types::*;

/// Compute a relevance score for an experience against a selection context.
///
/// Score = scope_match × confidence × recency_boost
/// - scope_match: 0.0-1.0 based on how well the experience's scope matches the context
/// - confidence: the experience's current confidence value
/// - recency_boost: 1.0 + ln(1 + success_count) * 0.05
pub fn score(exp: &ExperienceRevision, ctx: &SelectionContext) -> f64 {
    let scope_match = scope_match_score(&exp.scope, ctx);
    if scope_match == 0.0 {
        return 0.0;
    }

    let recency_boost = 1.0 + (1.0 + exp.success_count as f64).ln() * 0.05;

    scope_match * exp.confidence * recency_boost
}

/// Compute how well the experience's scope matches the selection context.
fn scope_match_score(scope: &ScopeFingerprint, ctx: &SelectionContext) -> f64 {
    let mut match_points = 0.0;
    let mut total_points = 0.0;

    // Repo match (highest weight)
    if let Some(scope_repo) = &scope.repo {
        total_points += 3.0;
        if let Some(ctx_repo) = &ctx.repo
            && scope_repo == ctx_repo {
                match_points += 3.0;
            }
    }

    // Task type match
    if let Some(scope_task) = &scope.task_type {
        total_points += 2.0;
        if let Some(ctx_task) = &ctx.task_type
            && scope_task == ctx_task {
                match_points += 2.0;
            }
    }

    // Signal type overlap
    if !scope.signal_types.is_empty() {
        total_points += 1.0;
        let overlap = scope
            .signal_types
            .iter()
            .filter(|s| ctx.signal_types.contains(s))
            .count();
        if overlap > 0 {
            match_points += 1.0;
        }
    }

    if total_points == 0.0 {
        return 1.0; // No scope constraints → universal match
    }

    match_points / total_points
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_scope() -> ScopeFingerprint {
        ScopeFingerprint {
            repo: Some("org/repo".to_string()),
            task_type: Some("bug_fix".to_string()),
            signal_types: vec![SignalType::TestFailure],
            env_fingerprint: None,
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
    fn perfect_match_scores_high() {
        let scope = make_scope();
        let ctx = make_ctx();
        let s = scope_match_score(&scope, &ctx);
        assert!((s - 1.0).abs() < 0.001);
    }

    #[test]
    fn no_match_scores_zero() {
        let scope = ScopeFingerprint {
            repo: Some("other/repo".to_string()),
            task_type: Some("refactor".to_string()),
            signal_types: vec![SignalType::Panic],
            env_fingerprint: None,
        };
        let ctx = make_ctx();
        let s = scope_match_score(&scope, &ctx);
        assert_eq!(s, 0.0);
    }

    #[test]
    fn partial_match() {
        let scope = ScopeFingerprint {
            repo: Some("org/repo".to_string()),
            task_type: Some("refactor".to_string()),
            signal_types: vec![],
            env_fingerprint: None,
        };
        let ctx = make_ctx();
        let s = scope_match_score(&scope, &ctx);
        // repo matches (3/5), task doesn't (0/5), signal empty (not scored)
        assert!(s > 0.0 && s < 1.0);
    }

    #[test]
    fn score_with_high_confidence() {
        let exp = ExperienceRevision {
            experience_id: "exp-1".to_string(),
            revision: 1,
            schema_version: 1,
            parent_id: None,
            state: ExperienceState::Active,
            confidence: 0.9,
            success_count: 5,
            failure_count: 0,
            scope: make_scope(),
            content_hash: "abc".to_string(),
            created_at: 1000,
            updated_at: 1000,
        };
        let ctx = make_ctx();
        let s = score(&exp, &ctx);
        assert!(s > 0.8); // High confidence × perfect match × recency boost
    }
}

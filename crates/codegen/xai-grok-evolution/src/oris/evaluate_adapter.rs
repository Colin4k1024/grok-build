//! Evaluate adapter: Oris EvaluatePort → grok-build evaluation.
//!
//! Implements `oris_evolution::port::EvaluatePort` using grok-build's
//! deterministic safety gates and critic scoring.

use oris_evolution::pipeline::{EvaluationRecommendation, EvaluationResult as OrisEvalResult};
use oris_evolution::port::{EvaluateInput, EvaluatePort};

/// Grok evaluate adapter.
pub struct GrokEvaluateAdapter {
    shadow_mode: bool,
}

impl GrokEvaluateAdapter {
    pub fn new(shadow_mode: bool) -> Self {
        Self { shadow_mode }
    }
}

impl EvaluatePort for GrokEvaluateAdapter {
    fn evaluate(&self, input: &EvaluateInput) -> OrisEvalResult {
        if self.shadow_mode {
            // Shadow mode: simulate evaluation based on intent quality
            let has_intent = !input.intent.is_empty();
            let has_signals = !input.signals.is_empty();
            let score = match (has_intent, has_signals) {
                (true, true) => 0.75,
                (true, false) => 0.5,
                (false, true) => 0.4,
                (false, false) => 0.2,
            };

            OrisEvalResult {
                score,
                improvements: if has_intent {
                    vec![format!(
                        "Addresses intent: {}",
                        input.intent.chars().take(100).collect::<String>()
                    )]
                } else {
                    vec![]
                },
                regressions: vec![],
                recommendation: if score >= 0.7 {
                    EvaluationRecommendation::Accept
                } else if score >= 0.4 {
                    EvaluationRecommendation::NeedsRevision
                } else {
                    EvaluationRecommendation::Reject
                },
            }
        } else {
            // P3: Will invoke critic model
            OrisEvalResult {
                score: 0.0,
                improvements: vec![],
                regressions: vec![
                    "legacy Oris evaluator is disabled for autonomous production runs".to_string(),
                ],
                recommendation: EvaluationRecommendation::Reject,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_mode_accepts_good_input() {
        let adapter = GrokEvaluateAdapter::new(true);
        let input = EvaluateInput {
            proposal_id: "p1".to_string(),
            intent: "fix null handling in parser".to_string(),
            original: "fn parse()".to_string(),
            proposed: "fn parse() -> Option".to_string(),
            signals: vec!["test failure".to_string()],
        };
        let result = adapter.evaluate(&input);
        assert!(result.score >= 0.7);
        assert_eq!(result.recommendation, EvaluationRecommendation::Accept);
    }

    #[test]
    fn shadow_mode_rejects_empty_input() {
        let adapter = GrokEvaluateAdapter::new(true);
        let input = EvaluateInput::default();
        let result = adapter.evaluate(&input);
        assert!(result.score < 0.4);
        assert_eq!(result.recommendation, EvaluationRecommendation::Reject);
    }
}

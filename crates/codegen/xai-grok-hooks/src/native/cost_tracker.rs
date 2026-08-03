//! PostToolUse observer: estimates token cost and writes JSONL metrics.

use serde::Serialize;

use crate::event::{HookEventEnvelope, HookEventName, HookPayload};
use crate::runner::HookRunnerResult;

use super::NativeHook;

#[derive(Serialize)]
struct CostRow {
    timestamp: String,
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    estimated_cost_usd: f64,
}

struct RateEntry {
    input_per_m: f64,
    output_per_m: f64,
}

const RATE_HAIKU: RateEntry = RateEntry {
    input_per_m: 0.8,
    output_per_m: 4.0,
};
const RATE_SONNET: RateEntry = RateEntry {
    input_per_m: 3.0,
    output_per_m: 15.0,
};
const RATE_OPUS: RateEntry = RateEntry {
    input_per_m: 15.0,
    output_per_m: 75.0,
};

fn estimate_cost(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    let lower = model.to_ascii_lowercase();
    let rates = if lower.contains("haiku") {
        &RATE_HAIKU
    } else if lower.contains("opus") {
        &RATE_OPUS
    } else {
        &RATE_SONNET
    };

    let cost = (input_tokens as f64 / 1_000_000.0) * rates.input_per_m
        + (output_tokens as f64 / 1_000_000.0) * rates.output_per_m;
    (cost * 1_000_000.0).round() / 1_000_000.0
}

fn extract_u64(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .unwrap_or(0)
}

pub struct CostTracker;

impl CostTracker {
    pub fn new() -> Self {
        Self
    }
}

impl NativeHook for CostTracker {
    fn name(&self) -> &str {
        "tsp:cost-tracker"
    }

    fn event(&self) -> HookEventName {
        HookEventName::PostToolUse
    }

    fn matcher(&self) -> Option<&str> {
        None
    }

    fn execute(&self, envelope: &HookEventEnvelope) -> HookRunnerResult {
        let tool_result = match &envelope.payload {
            HookPayload::PostToolUse { tool_result, .. } => tool_result,
            _ => return HookRunnerResult::Success,
        };

        let usage = tool_result
            .get("usage")
            .or_else(|| tool_result.get("token_usage"));
        let usage = match usage {
            Some(u) if u.is_object() => u,
            _ => return HookRunnerResult::Success,
        };

        let input_tokens =
            extract_u64(usage, "input_tokens").max(extract_u64(usage, "prompt_tokens"));
        let output_tokens =
            extract_u64(usage, "output_tokens").max(extract_u64(usage, "completion_tokens"));

        if input_tokens == 0 && output_tokens == 0 {
            return HookRunnerResult::Success;
        }

        let model = tool_result
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let row = CostRow {
            timestamp: envelope.timestamp.clone(),
            session_id: envelope.session_id.clone(),
            model: model.into(),
            input_tokens,
            output_tokens,
            estimated_cost_usd: estimate_cost(model, input_tokens, output_tokens),
        };

        let metrics_dir = xai_grok_config::grok_home().join("metrics");
        let _ = std::fs::create_dir_all(&metrics_dir);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(metrics_dir.join("costs.jsonl"))
            .and_then(|mut f| {
                use std::io::Write;
                if let Ok(json) = serde_json::to_string(&row) {
                    writeln!(f, "{json}")?;
                }
                Ok(())
            });

        HookRunnerResult::Success
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_cost_sonnet() {
        let cost = estimate_cost("claude-sonnet-4", 1_000_000, 1_000_000);
        assert!((cost - 18.0).abs() < 0.001);
    }

    #[test]
    fn estimate_cost_haiku() {
        let cost = estimate_cost("claude-haiku-4-5", 1_000_000, 1_000_000);
        assert!((cost - 4.8).abs() < 0.001);
    }

    #[test]
    fn estimate_cost_opus() {
        let cost = estimate_cost("claude-opus-4", 1_000_000, 1_000_000);
        assert!((cost - 90.0).abs() < 0.001);
    }
}

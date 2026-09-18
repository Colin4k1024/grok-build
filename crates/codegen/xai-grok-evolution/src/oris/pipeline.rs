//! Pipeline wiring: Oris StandardEvolutionPipeline + grok-build adapters.
//!
//! Creates a fully wired `StandardEvolutionPipeline` with all grok-build
//! port implementations injected via the builder pattern.

use std::sync::Arc;

use oris_evolution::pipeline::{
    EvolutionPipeline, EvolutionPipelineConfig, PipelineContext, PipelineResult,
    StandardEvolutionPipeline,
};
use oris_evolution::{EvolutionProjection, ProjectionSelector, Selector};

use crate::config::EvolutionMode;
use crate::error::EvolutionError;
use crate::events::store::EvolutionStore;

use super::evaluate_adapter::GrokEvaluateAdapter;
use super::sandbox_adapter::GrokSandboxAdapter;
use super::signal_adapter::GrokSignalExtractor;
use super::store_adapter::GrokGeneStoreAdapter;
use super::validate_adapter::GrokValidateAdapter;

/// Grok's evolution pipeline, wrapping Oris's `StandardEvolutionPipeline`
/// with grok-build-specific port implementations.
pub struct GrokEvolutionPipeline {
    inner: StandardEvolutionPipeline,
    mode: EvolutionMode,
}

impl GrokEvolutionPipeline {
    /// Build a new pipeline with the given mode and store.
    pub fn new(mode: EvolutionMode, store: EvolutionStore) -> Self {
        let off = mode == EvolutionMode::Off;
        let shadow = mode == EvolutionMode::Shadow;

        // Configure pipeline stages based on mode
        let config = EvolutionPipelineConfig {
            enable_detect: !off,
            enable_select: !off,
            enable_mutate: mode.can_run_trials(),
            enable_execute: mode.can_run_trials(),
            enable_validate: mode.can_run_trials(),
            enable_evaluate: !off,
            enable_solidify: mode.can_run_trials(),
            enable_reuse: mode.can_inject(),
            detect_timeout_secs: 30,
            select_timeout_secs: 10,
            mutate_timeout_secs: 60,
            execute_timeout_secs: if mode.can_run_trials() { 1200 } else { 0 },
            validate_timeout_secs: if mode.can_run_trials() { 60 } else { 0 },
            evaluate_timeout_secs: 30,
            solidify_timeout_secs: 30,
            reuse_timeout_secs: 10,
            max_candidates: 10,
            min_signal_confidence: 0.5,
        };

        // Create a default selector with an empty projection
        // (will be populated from the store at runtime)
        let projection = EvolutionProjection::default();
        let selector: Arc<dyn Selector> = Arc::new(ProjectionSelector::new(projection));

        // Wire all ports
        let inner = StandardEvolutionPipeline::new(config, selector)
            .with_signal_extractor(Arc::new(GrokSignalExtractor))
            .with_sandbox(Arc::new(GrokSandboxAdapter::new(shadow)))
            .with_validate_port(Arc::new(GrokValidateAdapter::new(shadow)))
            .with_evaluate_port(Arc::new(GrokEvaluateAdapter::new(shadow)))
            .with_gene_store(Arc::new(GrokGeneStoreAdapter::new(store)));

        Self { inner, mode }
    }

    /// Execute the pipeline with the given context.
    pub fn execute(&self, context: PipelineContext) -> Result<PipelineResult, EvolutionError> {
        self.inner
            .execute(context)
            .map_err(|e| EvolutionError::Internal(format!("pipeline error: {}", e)))
    }

    /// Get the current mode.
    pub fn mode(&self) -> EvolutionMode {
        self.mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oris_evolution::port::SignalExtractorInput;

    #[test]
    fn build_pipeline_in_shadow_mode() {
        let store = EvolutionStore::open_memory().unwrap();
        let pipeline = GrokEvolutionPipeline::new(EvolutionMode::Shadow, store);
        assert_eq!(pipeline.mode(), EvolutionMode::Shadow);
    }

    #[test]
    fn build_pipeline_in_off_mode() {
        let store = EvolutionStore::open_memory().unwrap();
        let pipeline = GrokEvolutionPipeline::new(EvolutionMode::Off, store);
        assert_eq!(pipeline.mode(), EvolutionMode::Off);
    }

    #[test]
    fn execute_shadow_pipeline_with_signals() {
        let store = EvolutionStore::open_memory().unwrap();
        let pipeline = GrokEvolutionPipeline::new(EvolutionMode::Shadow, store);

        let context = PipelineContext {
            task_input: serde_json::json!({
                "issue_id": "test-001",
                "intent": "fix null handling in parser",
                "signals": ["test_parse_config failed"],
                "files": ["src/parser.rs"],
                "expected_effect": "test passes",
            }),
            extractor_input: Some(SignalExtractorInput {
                compiler_output: Some("error: test_parse_config panicked".to_string()),
                ..Default::default()
            }),
            ..Default::default() // PipelineContext has many fields, all defaulted
        };

        let result = pipeline.execute(context).unwrap();
        // Shadow mode should succeed (stubs return success)
        assert!(result.success || !result.stage_states.is_empty());
    }
}

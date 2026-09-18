//! Oris SDK integration layer.
//!
//! Bridges grok-build's internal types and infrastructure with the Oris
//! evolution pipeline. All port trait implementations translate between
//! the two type systems.
//!
//! ## Architecture
//!
//! ```text
//! grok-build session signals
//!     ↓ (signal_adapter)
//! Oris EvolutionSignal
//!     ↓ (StandardEvolutionPipeline)
//! Oris GeneCandidate / MutationProposal
//!     ↓ (sandbox_adapter / validate_adapter / evaluate_adapter)
//! Oris PipelineResult
//!     ↓ (store_adapter)
//! grok-build EvolutionStore (SQLite)
//! ```

pub mod evaluate_adapter;
pub mod pipeline;
pub mod sandbox_adapter;
pub mod signal_adapter;
pub mod store_adapter;
pub mod validate_adapter;

pub use pipeline::GrokEvolutionPipeline;

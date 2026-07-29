//! Experience self-evolution system for grok-build.
//!
//! Implements an eight-stage closed-loop pipeline inspired by the Oris evolution
//! pipeline: Detect → Select → Mutate → Execute → Validate → Evaluate → Solidify → Reuse.
//!
//! ## Design Principles
//!
//! - **Append-only event sourcing**: all state transitions are recorded as immutable events.
//! - **Dependency inversion**: external capabilities (worktree, sandbox, model calls) are
//!   injected via traits defined in this crate.
//! - **Isolation by default**: trial execution happens in sandboxed worktrees; no automatic
//!   merge, push, or PR creation.
//! - **Staged rollout**: `Off → Shadow → IsolatedAutonomous → ReuseEligible`.
//!
//! ## Data Layout
//!
//! ```text
//! ~/.grok/memory/{workspace}/evolution/
//! ├── evolution.sqlite          # Event store + projections
//! ├── artifacts/                # Content-addressed evidence bundles
//! └── staging/                  # Trial staging directories
//! ```

pub mod acp;
pub mod cli;
pub mod config;
pub mod engine;
pub mod error;
pub mod events;
pub mod governor;
pub mod oris;
pub mod reuse;
pub mod rollout;
pub mod select;
pub mod service;
pub mod signal;
pub mod solidify;
pub mod state;
pub mod telemetry;
pub mod trial;
pub mod tui;
pub mod types;

pub use config::{
    EvolutionBudgetConfig, EvolutionCapacityConfig, EvolutionConfig, EvolutionGovernorConfig,
    EvolutionMode,
};
pub use engine::{
    EngineRunResult, EvolutionEngine, TrialEvaluator, TrialExecution, TrialExecutor,
    TrialValidator, ValidationComparison, VariantGenerator,
};
pub use error::EvolutionError;
pub use events::schema::SCHEMA_VERSION;
pub use events::store::EvolutionStore;
pub use events::{EvolutionEvent, QuarantineReasonType};
pub use governor::{BudgetStatus, EvolutionGovernor};
pub use oris::GrokEvolutionPipeline;
pub use rollout::{RolloutApproval, RolloutEvidence, RolloutReadiness};
pub use select::{SelectionContext, SelectionResult};
pub use service::{EvolutionPorts, EvolutionService, ExperienceInjection};
pub use signal::{DefaultSignalCollector, SessionSignalsDelta, SignalCollector};
pub use types::*;

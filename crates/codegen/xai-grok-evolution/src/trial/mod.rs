//! Trial execution: worker subprocess, preflight, and sandbox integration.
//!
//! The trial module manages the isolated execution of mutations in
//! sandboxed worktrees. It handles:
//! - Worker subprocess lifecycle (spawn, communicate, timeout, kill)
//! - Preflight validation (sandbox availability, isolation verification)
//! - Sandbox profile configuration for evolution workers

pub mod preflight;
pub mod runner;
pub mod worker;
pub mod worktree;

pub use preflight::{
    IsolationPreflight, PreflightResult, WorkerIsolationPreflight, run_preflight,
    run_worker_preflight,
};
pub use runner::{
    DeterministicTrialEvaluator, DeterministicTrialValidator, SandboxedTrialExecutor,
    scrub_sensitive_text,
};
pub use worktree::{GitWorktreeProvider, WorktreeProvider, source_tree_hash};

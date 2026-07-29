//! Trial execution: worker subprocess, preflight, and sandbox integration.
//!
//! The trial module manages the isolated execution of mutations in
//! sandboxed worktrees. It handles:
//! - Worker subprocess lifecycle (spawn, communicate, timeout, kill)
//! - Preflight validation (sandbox availability, isolation verification)
//! - Sandbox profile configuration for evolution workers

pub mod preflight;
pub mod worker;

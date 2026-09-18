//! Artifact two-phase publish: staging → content-addressed rename → DB commit.
//!
//! Ensures atomicity: either the artifact is fully committed with its
//! manifest, or it remains as an invisible orphan for GC.

pub mod artifact;

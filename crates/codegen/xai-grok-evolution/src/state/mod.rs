//! State machines for ExperienceRevision and EvolutionRun.
//!
//! All transitions are validated; illegal transitions return
//! `EvolutionError::InvalidTransition`. This module is the single source
//! of truth for valid lifecycle state changes.

pub mod confidence;
pub mod experience;
pub mod run;

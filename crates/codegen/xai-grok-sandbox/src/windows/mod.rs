//! Windows sandbox implementation using AppContainer, Job Objects, and WFP.
//!
//! These modules provide Windows-specific sandboxing primitives. All code is
//! gated behind `#[cfg(target_os = "windows")]` and only compiles on Windows
//! targets.
//!
//! - [`appcontainer`]: AppContainer-based sandbox (preferred).
//! - [`job_object`]: Job Object resource limits (fallback).
//! - [`file_policy`]: NTFS ACL-based file access policy.
//! - [`network_policy`]: WFP filter-based network access policy.

#[cfg(target_os = "windows")]
pub mod appcontainer;
#[cfg(target_os = "windows")]
pub mod file_policy;
#[cfg(target_os = "windows")]
pub mod job_object;
#[cfg(target_os = "windows")]
pub mod network_policy;

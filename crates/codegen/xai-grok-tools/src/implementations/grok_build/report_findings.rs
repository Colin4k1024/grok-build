//! `ReportFindings` tool — structured code-review output.
//!
//! Accepts a typed list of findings (file, line, summary, failure_scenario, category)
//! and a review level. Returns the findings as structured JSON for the host UI.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportFindingsInput {
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub file: String,
    pub summary: String,
    pub failure_scenario: String,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportFindingsOutput {
    pub accepted: bool,
    pub findings_count: usize,
}

pub fn execute(input: &ReportFindingsInput) -> ReportFindingsOutput {
    ReportFindingsOutput {
        accepted: true,
        findings_count: input.findings.len(),
    }
}

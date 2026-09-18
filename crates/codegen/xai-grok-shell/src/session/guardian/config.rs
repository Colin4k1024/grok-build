/// Guardian safety layer configuration.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GuardianConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub review_timeout_ms: u64,
    #[serde(default = "default_circuit_breaker")]
    pub max_consecutive_denials: u32,
    #[serde(default = "default_risk_threshold")]
    pub risk_threshold: String,
}

impl Default for GuardianConfig {
    fn default() -> Self {
        Self {
            enabled: default_true(),
            review_timeout_ms: default_timeout(),
            max_consecutive_denials: default_circuit_breaker(),
            risk_threshold: default_risk_threshold(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_timeout() -> u64 {
    5000
}

fn default_circuit_breaker() -> u32 {
    3
}

fn default_risk_threshold() -> String {
    "medium".to_owned()
}

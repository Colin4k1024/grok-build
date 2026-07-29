//! Evolution mode configuration.
//!
//! Follows the leaf-config pattern established by `xai-grok-config-types::memory`:
//! each sub-config is a standalone `#[serde(default)]` struct with `impl Default`.

use serde::{Deserialize, Serialize};

/// Evolution operational mode.
///
/// Modes are strictly ordered; each upgrade requires passing preflight checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EvolutionMode {
    /// Zero DB open, zero background tasks.
    #[default]
    Off,
    /// Capture, select, propose, and sample isolated evaluation.
    /// No publishing, no injection into ordinary tasks.
    Shadow,
    /// Automatic trials, publish Candidate/Contraindication.
    /// Does not affect ordinary tasks.
    IsolatedAutonomous,
    /// Allow Active experiences to be automatically injected.
    /// Still no code merging.
    ReuseEligible,
}

impl EvolutionMode {
    /// Returns the numeric level for comparison.
    pub fn level(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Shadow => 1,
            Self::IsolatedAutonomous => 2,
            Self::ReuseEligible => 3,
        }
    }

    /// Returns `true` if this mode is at least `IsolatedAutonomous`.
    pub fn can_run_trials(self) -> bool {
        self.level() >= Self::IsolatedAutonomous.level()
    }

    /// Returns `true` if this mode allows experience injection.
    pub fn can_inject(self) -> bool {
        self.level() >= Self::ReuseEligible.level()
    }

    /// Returns `true` if upgrading from `self` to `target` is a valid single-step transition.
    pub fn can_upgrade_to(self, target: Self) -> bool {
        target.level() == self.level() + 1
    }

    /// Returns `true` if downgrading from `self` to `target` is valid.
    pub fn can_downgrade_to(self, target: Self) -> bool {
        target.level() < self.level()
    }
}

/// Top-level evolution configuration.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct EvolutionConfig {
    /// Operational mode.
    pub mode: EvolutionMode,
    /// Sampling rate for Shadow mode (0.0 - 1.0).
    pub shadow_sample_rate: f64,
    /// Maximum trials per session.
    pub max_trials_per_session: u32,
    /// Maximum concurrent trials globally.
    pub max_concurrent_trials: u32,
    /// Budget constraints.
    pub budget: EvolutionBudgetConfig,
    /// Governor thresholds.
    pub governor: EvolutionGovernorConfig,
    /// Storage capacity limits.
    pub capacity: EvolutionCapacityConfig,
}

impl Default for EvolutionConfig {
    fn default() -> Self {
        Self {
            mode: EvolutionMode::default(),
            shadow_sample_rate: 0.1,
            max_trials_per_session: 1,
            max_concurrent_trials: 1,
            budget: EvolutionBudgetConfig::default(),
            governor: EvolutionGovernorConfig::default(),
            capacity: EvolutionCapacityConfig::default(),
        }
    }
}

impl EvolutionConfig {
    /// Resolve config with priority CLI > environment > TOML > default Off.
    pub fn resolve(
        experimental_evolution: bool,
        no_evolution: bool,
        config: &toml::Value,
    ) -> Result<Self, crate::error::EvolutionError> {
        Self::resolve_with_env(
            experimental_evolution,
            no_evolution,
            config,
            std::env::var("GROK_EVOLUTION").ok().as_deref(),
        )
    }

    pub fn resolve_with_env(
        experimental_evolution: bool,
        no_evolution: bool,
        config: &toml::Value,
        env_value: Option<&str>,
    ) -> Result<Self, crate::error::EvolutionError> {
        let mut resolved: Self = config
            .get("evolution")
            .map(|value| value.clone().try_into())
            .transpose()
            .map_err(|error| {
                crate::error::EvolutionError::PreflightFailed(format!(
                    "invalid [evolution] config: {error}"
                ))
            })?
            .unwrap_or_default();

        if let Some(value) = env_value {
            resolved.mode = parse_mode(value)?;
        }
        if experimental_evolution {
            resolved.mode = EvolutionMode::Shadow;
        }
        if no_evolution {
            resolved.mode = EvolutionMode::Off;
        }
        resolved.validate()?;
        Ok(resolved)
    }

    pub fn validate(&self) -> Result<(), crate::error::EvolutionError> {
        if !(0.0..=1.0).contains(&self.shadow_sample_rate) {
            return Err(crate::error::EvolutionError::PreflightFailed(
                "evolution.shadow_sample_rate must be between 0 and 1".to_string(),
            ));
        }
        if self.max_trials_per_session == 0 || self.max_concurrent_trials == 0 {
            return Err(crate::error::EvolutionError::PreflightFailed(
                "evolution trial limits must be greater than zero".to_string(),
            ));
        }
        if self.budget.max_duration_secs == 0
            || self.budget.max_variant_rounds == 0
            || self.budget.max_artifact_mb == 0
        {
            return Err(crate::error::EvolutionError::PreflightFailed(
                "evolution budgets must be greater than zero".to_string(),
            ));
        }
        Ok(())
    }
}

fn parse_mode(value: &str) -> Result<EvolutionMode, crate::error::EvolutionError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "0" | "false" | "off" => Ok(EvolutionMode::Off),
        "1" | "true" | "shadow" => Ok(EvolutionMode::Shadow),
        "isolated_autonomous" | "isolated-autonomous" => Ok(EvolutionMode::IsolatedAutonomous),
        "reuse_eligible" | "reuse-eligible" => Ok(EvolutionMode::ReuseEligible),
        other => Err(crate::error::EvolutionError::PreflightFailed(format!(
            "unknown GROK_EVOLUTION mode: {other}"
        ))),
    }
}

/// Budget constraints for a single trial.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct EvolutionBudgetConfig {
    /// Maximum trial duration in seconds. Default: 1200 (20 minutes).
    pub max_duration_secs: u64,
    /// Maximum mutation rounds per trial. Default: 3.
    pub max_variant_rounds: u32,
    /// Maximum artifact size in MB. Default: 50.
    pub max_artifact_mb: u64,
    /// Maximum files changed per trial. Default: 5.
    pub max_files_changed: u32,
    /// Maximum lines changed per trial. Default: 300.
    pub max_lines_changed: u32,
}

impl Default for EvolutionBudgetConfig {
    fn default() -> Self {
        Self {
            max_duration_secs: 1200,
            max_variant_rounds: 3,
            max_artifact_mb: 50,
            max_files_changed: 5,
            max_lines_changed: 300,
        }
    }
}

/// Governor thresholds for promotion and quarantine.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct EvolutionGovernorConfig {
    /// Successful observations needed to promote Candidate → Active. Default: 3.
    pub promote_after_successes: u32,
    /// Consecutive failures to trigger quarantine. Default: 2.
    pub quarantine_after_failures: u32,
    /// SLA for quarantine completion in seconds. Default: 5.
    pub quarantine_sla_secs: u64,
    /// Confidence half-life in days. Default: 30.0.
    pub confidence_half_life_days: f64,
}

impl Default for EvolutionGovernorConfig {
    fn default() -> Self {
        Self {
            promote_after_successes: 3,
            quarantine_after_failures: 2,
            quarantine_sla_secs: 5,
            confidence_half_life_days: 30.0,
        }
    }
}

/// Storage capacity limits.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct EvolutionCapacityConfig {
    /// Maximum total storage in bytes. Default: 2 GB.
    pub max_bytes: u64,
    /// Maximum age for artifacts in days. Default: 30.
    pub max_age_days: u32,
}

impl Default for EvolutionCapacityConfig {
    fn default() -> Self {
        Self {
            max_bytes: 2 * 1024 * 1024 * 1024,
            max_age_days: 30,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mode_is_off() {
        assert_eq!(EvolutionMode::default(), EvolutionMode::Off);
    }

    #[test]
    fn mode_level_ordering() {
        assert!(EvolutionMode::Off.level() < EvolutionMode::Shadow.level());
        assert!(EvolutionMode::Shadow.level() < EvolutionMode::IsolatedAutonomous.level());
        assert!(EvolutionMode::IsolatedAutonomous.level() < EvolutionMode::ReuseEligible.level());
    }

    #[test]
    fn mode_upgrade_requires_single_step() {
        assert!(EvolutionMode::Off.can_upgrade_to(EvolutionMode::Shadow));
        assert!(!EvolutionMode::Off.can_upgrade_to(EvolutionMode::IsolatedAutonomous));
        assert!(!EvolutionMode::Off.can_upgrade_to(EvolutionMode::ReuseEligible));
        assert!(EvolutionMode::Shadow.can_upgrade_to(EvolutionMode::IsolatedAutonomous));
        assert!(EvolutionMode::IsolatedAutonomous.can_upgrade_to(EvolutionMode::ReuseEligible));
    }

    #[test]
    fn mode_downgrade() {
        assert!(EvolutionMode::ReuseEligible.can_downgrade_to(EvolutionMode::Off));
        assert!(EvolutionMode::ReuseEligible.can_downgrade_to(EvolutionMode::Shadow));
        assert!(!EvolutionMode::Off.can_downgrade_to(EvolutionMode::Shadow));
    }

    #[test]
    fn can_run_trials_only_in_autonomous() {
        assert!(!EvolutionMode::Off.can_run_trials());
        assert!(!EvolutionMode::Shadow.can_run_trials());
        assert!(EvolutionMode::IsolatedAutonomous.can_run_trials());
        assert!(EvolutionMode::ReuseEligible.can_run_trials());
    }

    #[test]
    fn can_inject_only_in_reuse_eligible() {
        assert!(!EvolutionMode::Off.can_inject());
        assert!(!EvolutionMode::Shadow.can_inject());
        assert!(!EvolutionMode::IsolatedAutonomous.can_inject());
        assert!(EvolutionMode::ReuseEligible.can_inject());
    }

    #[test]
    fn config_defaults() {
        let config = EvolutionConfig::default();
        assert_eq!(config.mode, EvolutionMode::Off);
        assert_eq!(config.shadow_sample_rate, 0.1);
        assert_eq!(config.max_trials_per_session, 1);
        assert_eq!(config.max_concurrent_trials, 1);
        assert_eq!(config.budget.max_duration_secs, 1200);
        assert_eq!(config.budget.max_variant_rounds, 3);
        assert_eq!(config.governor.promote_after_successes, 3);
        assert_eq!(config.governor.quarantine_after_failures, 2);
    }

    #[test]
    fn config_deserialize_partial() {
        let toml = r#"
            mode = "shadow"
            shadow_sample_rate = 0.5
            [governor]
            promote_after_successes = 5
        "#;
        let config: EvolutionConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.mode, EvolutionMode::Shadow);
        assert_eq!(config.shadow_sample_rate, 0.5);
        assert_eq!(config.governor.promote_after_successes, 5);
        // Defaults preserved for unspecified fields
        assert_eq!(config.max_trials_per_session, 1);
        assert_eq!(config.budget.max_duration_secs, 1200);
    }

    #[test]
    fn config_roundtrip() {
        let toml_str = r#"mode = "isolated_autonomous"
shadow_sample_rate = 0.1
max_trials_per_session = 1
max_concurrent_trials = 1

[budget]
max_duration_secs = 1200
max_variant_rounds = 3
max_artifact_mb = 50
max_files_changed = 5
max_lines_changed = 300

[governor]
promote_after_successes = 3
quarantine_after_failures = 2
quarantine_sla_secs = 5
confidence_half_life_days = 30.0

[capacity]
max_bytes = 2147483648
max_age_days = 30
"#;
        let config: EvolutionConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.mode, EvolutionMode::IsolatedAutonomous);
    }

    #[test]
    fn resolution_precedence_is_cli_then_env_then_config() {
        let config: toml::Value = toml::from_str("[evolution]\nmode = 'reuse_eligible'").unwrap();
        assert_eq!(
            EvolutionConfig::resolve_with_env(false, false, &config, Some("shadow"))
                .unwrap()
                .mode,
            EvolutionMode::Shadow
        );
        assert_eq!(
            EvolutionConfig::resolve_with_env(true, false, &config, Some("off"))
                .unwrap()
                .mode,
            EvolutionMode::Shadow
        );
        assert_eq!(
            EvolutionConfig::resolve_with_env(true, true, &config, Some("shadow"))
                .unwrap()
                .mode,
            EvolutionMode::Off
        );
    }
}

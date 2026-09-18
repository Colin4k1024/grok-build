use std::sync::atomic::{AtomicU32, Ordering};

use super::config::GuardianConfig;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GuardianOutcome {
    Allow,
    Deny,
    Escalate,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GuardianVerdict {
    pub risk_level: RiskLevel,
    pub outcome: GuardianOutcome,
    pub reasoning: String,
}

pub struct GuardianReviewer {
    config: GuardianConfig,
    consecutive_denials: AtomicU32,
}

impl GuardianReviewer {
    pub fn new(config: GuardianConfig) -> Self {
        Self {
            config,
            consecutive_denials: AtomicU32::new(0),
        }
    }

    /// Review a tool call. Returns verdict.
    /// Current implementation: rule-based (fast, no LLM). Future: LLM side-query.
    pub async fn review(&self, tool_name: &str, args: &serde_json::Value) -> GuardianVerdict {
        // 1. Check circuit breaker.
        if self.is_circuit_breaker_open() {
            return GuardianVerdict {
                risk_level: RiskLevel::Critical,
                outcome: GuardianOutcome::Deny,
                reasoning: format!(
                    "Circuit breaker: {} consecutive denials exceeded threshold {}",
                    self.consecutive_denials.load(Ordering::Relaxed),
                    self.config.max_consecutive_denials,
                ),
            };
        }

        // 2. Rule-based risk assessment.
        let verdict = self.assess_risk(tool_name, args);

        // 3. Update circuit breaker state.
        match verdict.outcome {
            GuardianOutcome::Deny => {
                self.consecutive_denials.fetch_add(1, Ordering::Relaxed);
            }
            GuardianOutcome::Allow => {
                self.consecutive_denials.store(0, Ordering::Relaxed);
            }
            GuardianOutcome::Escalate => {}
        }

        verdict
    }

    /// Reset circuit breaker (call at turn boundaries).
    pub fn reset_circuit_breaker(&self) {
        self.consecutive_denials.store(0, Ordering::Relaxed);
    }

    /// Check if circuit breaker is open (too many denials).
    pub fn is_circuit_breaker_open(&self) -> bool {
        self.consecutive_denials.load(Ordering::Relaxed) >= self.config.max_consecutive_denials
    }

    fn assess_risk(&self, tool_name: &str, args: &serde_json::Value) -> GuardianVerdict {
        let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let path = args
            .get("file_path")
            .or_else(|| args.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let normalized_name = tool_name.to_ascii_lowercase();
        match normalized_name.as_str() {
            name if name.contains("bash") => self.assess_bash_risk(cmd),
            "edit" | "write" | "write_file" | "search_replace" | "notebook_edit" => {
                self.assess_file_risk(path)
            }
            _ => {
                if args
                    .get("dangerouslyDisableSandbox")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    GuardianVerdict {
                        risk_level: RiskLevel::High,
                        outcome: GuardianOutcome::Deny,
                        reasoning: "sandbox bypass requested".to_owned(),
                    }
                } else {
                    GuardianVerdict {
                        risk_level: RiskLevel::Low,
                        outcome: GuardianOutcome::Allow,
                        reasoning: "no high-risk patterns detected".to_owned(),
                    }
                }
            }
        }
    }

    fn assess_bash_risk(&self, cmd: &str) -> GuardianVerdict {
        let lower = cmd.to_ascii_lowercase();

        // Critical: rm -rf / or rm -rf on root-level paths
        if lower.contains("rm ") && (lower.contains("-rf") || lower.contains("-fr")) {
            if lower.contains(" /") && !lower.contains(" /tmp") && !lower.contains(" /var/tmp") {
                return GuardianVerdict {
                    risk_level: RiskLevel::Critical,
                    outcome: GuardianOutcome::Deny,
                    reasoning: format!("destructive rm on system path: {cmd}"),
                };
            }
            return GuardianVerdict {
                risk_level: RiskLevel::Medium,
                outcome: GuardianOutcome::Allow,
                reasoning: format!("rm with force flags on non-system path: {cmd}"),
            };
        }

        // High: sudo with dangerous commands
        if lower.starts_with("sudo ") {
            let after_sudo = &lower[5..];
            if after_sudo.starts_with("rm ")
                || after_sudo.starts_with("chmod ")
                || after_sudo.starts_with("chown ")
                || after_sudo.starts_with("dd ")
            {
                return GuardianVerdict {
                    risk_level: RiskLevel::High,
                    outcome: GuardianOutcome::Deny,
                    reasoning: format!("sudo with destructive command: {cmd}"),
                };
            }
            return GuardianVerdict {
                risk_level: RiskLevel::Medium,
                outcome: GuardianOutcome::Allow,
                reasoning: format!("sudo invocation (non-destructive): {cmd}"),
            };
        }

        // High: git push --force to main/master
        if lower.contains("git push")
            && (lower.contains("--force") || lower.contains("-f"))
            && (lower.contains("main") || lower.contains("master"))
        {
            return GuardianVerdict {
                risk_level: RiskLevel::High,
                outcome: GuardianOutcome::Deny,
                reasoning: format!("force push to main branch: {cmd}"),
            };
        }

        // High: git reset --hard
        if lower.contains("git reset") && lower.contains("--hard") {
            return GuardianVerdict {
                risk_level: RiskLevel::High,
                outcome: GuardianOutcome::Deny,
                reasoning: format!("git reset --hard can destroy uncommitted work: {cmd}"),
            };
        }

        // High: curl/wget piped to shell
        if (lower.contains("curl ") || lower.contains("wget "))
            && (lower.contains("| sh")
                || lower.contains("| bash")
                || lower.contains("|sh")
                || lower.contains("|bash"))
        {
            return GuardianVerdict {
                risk_level: RiskLevel::High,
                outcome: GuardianOutcome::Deny,
                reasoning: format!("remote code execution via pipe to shell: {cmd}"),
            };
        }

        // High: dd, mkfs, fdisk
        if lower.starts_with("dd ") || lower.starts_with("mkfs") || lower.starts_with("fdisk") {
            return GuardianVerdict {
                risk_level: RiskLevel::High,
                outcome: GuardianOutcome::Deny,
                reasoning: format!("disk-level destructive command: {cmd}"),
            };
        }

        GuardianVerdict {
            risk_level: RiskLevel::Low,
            outcome: GuardianOutcome::Allow,
            reasoning: "no high-risk patterns detected".to_owned(),
        }
    }

    fn assess_file_risk(&self, path: &str) -> GuardianVerdict {
        let lower = path.to_ascii_lowercase();

        if lower.ends_with(".env") || lower.contains("credentials") || lower.contains("secrets") {
            return GuardianVerdict {
                risk_level: RiskLevel::Medium,
                outcome: GuardianOutcome::Allow,
                reasoning: format!("write to sensitive file (secrets/env): {path}"),
            };
        }

        if lower.contains(".ssh/") {
            return GuardianVerdict {
                risk_level: RiskLevel::High,
                outcome: GuardianOutcome::Deny,
                reasoning: format!("write to SSH directory: {path}"),
            };
        }

        if lower.starts_with("/etc/") {
            return GuardianVerdict {
                risk_level: RiskLevel::High,
                outcome: GuardianOutcome::Deny,
                reasoning: format!("write to system config: {path}"),
            };
        }

        GuardianVerdict {
            risk_level: RiskLevel::Low,
            outcome: GuardianOutcome::Allow,
            reasoning: "no high-risk patterns detected".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default_reviewer() -> GuardianReviewer {
        GuardianReviewer::new(GuardianConfig::default())
    }

    #[tokio::test]
    async fn safe_command_allows() {
        let reviewer = default_reviewer();
        let args = json!({"command": "cargo test --lib"});
        let verdict = reviewer.review("bash", &args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Allow);
        assert_eq!(verdict.risk_level, RiskLevel::Low);
    }

    #[tokio::test]
    async fn rm_rf_root_denies() {
        let reviewer = default_reviewer();
        let args = json!({"command": "rm -rf /"});
        let verdict = reviewer.review("bash", &args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Deny);
        assert_eq!(verdict.risk_level, RiskLevel::Critical);
    }

    #[tokio::test]
    async fn rm_rf_tmp_allows() {
        let reviewer = default_reviewer();
        let args = json!({"command": "rm -rf /tmp/build_cache"});
        let verdict = reviewer.review("bash", &args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Allow);
        assert_eq!(verdict.risk_level, RiskLevel::Medium);
    }

    #[tokio::test]
    async fn circuit_breaker_trips_after_max_denials() {
        let config = GuardianConfig {
            max_consecutive_denials: 2,
            ..Default::default()
        };
        let reviewer = GuardianReviewer::new(config);

        // Two denials
        let args = json!({"command": "rm -rf /usr"});
        reviewer.review("bash", &args).await;
        reviewer.review("bash", &args).await;

        // Third call should be circuit-breaker denial
        let safe_args = json!({"command": "echo hello"});
        let verdict = reviewer.review("bash", &safe_args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Deny);
        assert!(verdict.reasoning.contains("Circuit breaker"));
    }

    #[tokio::test]
    async fn circuit_breaker_reset_works() {
        let config = GuardianConfig {
            max_consecutive_denials: 2,
            ..Default::default()
        };
        let reviewer = GuardianReviewer::new(config);

        let args = json!({"command": "rm -rf /usr"});
        reviewer.review("bash", &args).await;
        reviewer.review("bash", &args).await;

        assert!(reviewer.is_circuit_breaker_open());
        reviewer.reset_circuit_breaker();
        assert!(!reviewer.is_circuit_breaker_open());

        let safe_args = json!({"command": "echo hello"});
        let verdict = reviewer.review("bash", &safe_args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Allow);
    }

    #[tokio::test]
    async fn force_push_to_main_denies() {
        let reviewer = default_reviewer();
        let args = json!({"command": "git push --force origin main"});
        let verdict = reviewer.review("bash", &args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Deny);
        assert_eq!(verdict.risk_level, RiskLevel::High);
    }

    #[tokio::test]
    async fn write_to_ssh_denies() {
        let reviewer = default_reviewer();
        let args = json!({"file_path": "/home/user/.ssh/authorized_keys"});
        let verdict = reviewer.review("edit", &args).await;
        assert_eq!(verdict.outcome, GuardianOutcome::Deny);
        assert_eq!(verdict.risk_level, RiskLevel::High);
    }

    #[tokio::test]
    async fn allow_resets_circuit_breaker() {
        let reviewer = default_reviewer();

        let dangerous = json!({"command": "rm -rf /usr"});
        reviewer.review("bash", &dangerous).await;
        assert_eq!(reviewer.consecutive_denials.load(Ordering::Relaxed), 1);

        let safe = json!({"command": "echo hello"});
        reviewer.review("bash", &safe).await;
        assert_eq!(reviewer.consecutive_denials.load(Ordering::Relaxed), 0);
    }
}

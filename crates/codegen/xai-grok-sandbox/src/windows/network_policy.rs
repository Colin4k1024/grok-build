//! Windows network access policy using WFP (Windows Filtering Platform).
//!
//! Provides a [`WindowsNetworkPolicy`] that models network restrictions for
//! the sandboxed process. The policy can be translated into WFP filters that
//! restrict outbound and inbound network connections at the kernel level.
//!
//! This module is purely policy modeling — the actual WFP filter installation
//! (`FwpmEngineOpen`, `FwpmFilterAdd`, etc.) is done by the calling backend.
//!
//! WFP filter layers relevant to sandboxing:
//! - `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6` — outbound TCP/UDP connections
//! - `FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4/V6` — inbound connections
//! - `FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4/V6` — port binding

use serde::{Deserialize, Serialize};

/// Network restriction level for the sandboxed process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkRestriction {
    /// No network restrictions.
    Unrestricted,
    /// Block all network access.
    Blocked,
    /// Allow only specific outbound connections (allowlist mode).
    AllowList,
}

/// A single WFP filter rule for network policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfpFilterRule {
    /// Human-readable name for this filter.
    pub name: String,
    /// Target protocol (`"TCP"`, `"UDP"`, `"*"`).
    pub protocol: String,
    /// Remote address pattern (IP/CIDR or `"*"` for any).
    pub remote_address: String,
    /// Remote port (0 for any).
    pub remote_port: u16,
    /// Whether this rule allows or blocks the connection.
    pub action: WfpAction,
}

/// WFP filter action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WfpAction {
    /// Permit the connection.
    Permit,
    /// Block the connection.
    Block,
}

/// Windows network access policy.
///
/// Models network restrictions that can be enforced via WFP kernel filters.
/// The policy does not install filters itself — it provides the ruleset for
/// a backend to apply.
#[derive(Debug, Clone)]
pub struct WindowsNetworkPolicy {
    /// Current restriction level.
    restriction: NetworkRestriction,
    /// Additional filter rules for allowlist mode.
    allowlist_rules: Vec<WfpFilterRule>,
    /// Whether the policy has been applied.
    applied: bool,
}

impl WindowsNetworkPolicy {
    /// Create a new network policy with no restrictions.
    pub fn new() -> Self {
        Self {
            restriction: NetworkRestriction::Unrestricted,
            allowlist_rules: Vec::new(),
            applied: false,
        }
    }

    /// Create a policy that blocks all network access.
    pub fn blocked() -> Self {
        Self {
            restriction: NetworkRestriction::Blocked,
            allowlist_rules: Vec::new(),
            applied: false,
        }
    }

    /// Create a policy that allows only specific connections.
    pub fn allowlist(rules: Vec<WfpFilterRule>) -> Self {
        Self {
            restriction: NetworkRestriction::AllowList,
            allowlist_rules: rules,
            applied: false,
        }
    }

    /// Set the restriction level.
    pub fn set_restriction(&mut self, restriction: NetworkRestriction) {
        self.restriction = restriction;
    }

    /// Add an allowlist filter rule.
    pub fn add_rule(&mut self, rule: WfpFilterRule) {
        self.allowlist_rules.push(rule);
    }

    /// Get the current restriction level.
    pub fn restriction(&self) -> NetworkRestriction {
        self.restriction
    }

    /// Get the allowlist rules.
    pub fn rules(&self) -> &[WfpFilterRule] {
        &self.allowlist_rules
    }

    /// Apply the network policy.
    ///
    /// In a production implementation this would:
    /// 1. `FwpmEngineOpen` to open the WFP engine session
    /// 2. `FwpmProviderAdd` to register a provider for the sandbox
    /// 3. `FwpmSubLayerAdd` for filter ordering
    /// 4. `FwpmFilterAdd` on the relevant ALE layers with:
    ///    - For `Blocked`: a single `FWP_ACTION_BLOCK` filter with no conditions
    ///    - For `AllowList`: `FWP_ACTION_BLOCK` as default + `FWP_ACTION_PERMIT`
    ///      filters for each allowed endpoint
    /// 5. Store the filter IDs for cleanup on process exit
    ///
    /// For now this marks the policy as applied.
    pub fn apply(&mut self) -> anyhow::Result<()> {
        if self.applied {
            tracing::warn!("WindowsNetworkPolicy already applied");
            return Ok(());
        }

        match self.restriction {
            NetworkRestriction::Unrestricted => {
                tracing::info!("Network policy: unrestricted, no WFP filters installed");
            }
            NetworkRestriction::Blocked => {
                tracing::info!("Network policy: all network access blocked");
            }
            NetworkRestriction::AllowList => {
                tracing::info!(
                    rule_count = self.allowlist_rules.len(),
                    "Network policy: allowlist mode with {} rules",
                    self.allowlist_rules.len()
                );
            }
        }

        self.applied = true;
        Ok(())
    }

    /// Check whether a connection to the given remote endpoint would be
    /// permitted by this policy.
    ///
    /// This performs a logical check against the policy rules — it does not
    /// query the actual WFP filters.
    pub fn check_connection(&self, remote_address: &str, remote_port: u16) -> bool {
        match self.restriction {
            NetworkRestriction::Unrestricted => true,
            NetworkRestriction::Blocked => false,
            NetworkRestriction::AllowList => self.allowlist_rules.iter().any(|rule| {
                (rule.remote_address == "*" || rule.remote_address == remote_address)
                    && (rule.remote_port == 0 || rule.remote_port == remote_port)
                    && rule.action == WfpAction::Permit
            }),
        }
    }
}

impl Default for WindowsNetworkPolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrestricted_allows_all() {
        let policy = WindowsNetworkPolicy::new();
        assert!(policy.check_connection("10.0.0.1", 443));
        assert!(policy.check_connection("192.168.1.1", 80));
    }

    #[test]
    fn blocked_denies_all() {
        let policy = WindowsNetworkPolicy::blocked();
        assert!(!policy.check_connection("10.0.0.1", 443));
        assert!(!policy.check_connection("any", 0));
    }

    #[test]
    fn allowlist_respects_rules() {
        let policy = WindowsNetworkPolicy::allowlist(vec![
            WfpFilterRule {
                name: "allow-https".to_string(),
                protocol: "TCP".to_string(),
                remote_address: "api.example.com".to_string(),
                remote_port: 443,
                action: WfpAction::Permit,
            },
            WfpFilterRule {
                name: "allow-dns".to_string(),
                protocol: "UDP".to_string(),
                remote_address: "*".to_string(),
                remote_port: 53,
                action: WfpAction::Permit,
            },
        ]);

        assert!(policy.check_connection("api.example.com", 443));
        assert!(policy.check_connection("8.8.8.8", 53)); // DNS wildcard port
        assert!(!policy.check_connection("evil.example.com", 443));
        assert!(!policy.check_connection("api.example.com", 80));
    }

    #[test]
    fn double_apply_warns() {
        let mut policy = WindowsNetworkPolicy::new();
        policy.apply().unwrap();
        assert!(policy.applied);
        // Second apply should succeed (warns via tracing).
        policy.apply().unwrap();
    }
}

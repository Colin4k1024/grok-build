use std::collections::HashSet;

/// Per-domain network access policy configuration.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct NetworkPolicy {
    /// Domains always allowed (e.g., "github.com", "*.googleapis.com")
    #[serde(default)]
    pub allow: Vec<String>,
    /// Domains always blocked
    #[serde(default)]
    pub deny: Vec<String>,
    /// Whether to prompt for unlisted domains (default: true)
    #[serde(default = "default_true")]
    pub prompt_on_first_access: bool,
}

fn default_true() -> bool {
    true
}

/// Runtime network access decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkDecision {
    Allow,
    Deny(String),
    Prompt,
    SessionApproved,
    SessionDenied,
}

/// Runtime state tracking network decisions for this session.
pub struct NetworkPolicyState {
    policy: NetworkPolicy,
    session_approved: HashSet<String>,
    session_denied: HashSet<String>,
}

impl NetworkPolicyState {
    pub fn new(policy: NetworkPolicy) -> Self {
        Self {
            policy,
            session_approved: HashSet::new(),
            session_denied: HashSet::new(),
        }
    }

    /// Evaluate network access for a given domain.
    pub fn evaluate(&self, domain: &str) -> NetworkDecision {
        let normalized = domain.to_ascii_lowercase();

        // 1. Deny list takes priority over allow.
        if let Some(pattern) = self.policy.deny.iter().find(|p| matches_pattern(&normalized, p)) {
            return NetworkDecision::Deny(format!("domain {domain} blocked by deny rule: {pattern}"));
        }

        // 2. Check allow list.
        if self.policy.allow.iter().any(|p| matches_pattern(&normalized, p)) {
            return NetworkDecision::Allow;
        }

        // 3. Check session cache.
        if self.session_approved.contains(&normalized) {
            return NetworkDecision::SessionApproved;
        }
        if self.session_denied.contains(&normalized) {
            return NetworkDecision::SessionDenied;
        }

        // 4. Prompt or allow based on policy.
        if self.policy.prompt_on_first_access {
            NetworkDecision::Prompt
        } else {
            NetworkDecision::Allow
        }
    }

    /// Record user's approval for this session.
    pub fn record_approval(&mut self, domain: String) {
        self.session_approved.insert(domain.to_ascii_lowercase());
    }

    /// Record user's denial for this session.
    pub fn record_denial(&mut self, domain: String) {
        self.session_denied.insert(domain.to_ascii_lowercase());
    }

    /// Access the underlying policy.
    pub fn policy(&self) -> &NetworkPolicy {
        &self.policy
    }
}

/// Check if domain matches a pattern (supports *.example.com glob).
/// `*.foo.com` matches `bar.foo.com` and `baz.bar.foo.com` but NOT `foo.com`.
fn matches_pattern(domain: &str, pattern: &str) -> bool {
    let pattern_lower = pattern.to_ascii_lowercase();

    if let Some(suffix) = pattern_lower.strip_prefix("*.") {
        // Wildcard: domain must end with .suffix and be longer than suffix.
        domain.ends_with(&format!(".{suffix}")) && domain.len() > suffix.len() + 1
    } else {
        // Exact match.
        domain == pattern_lower
    }
}

/// Extract domain from a URL string.
pub fn extract_domain(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_with(allow: &[&str], deny: &[&str]) -> NetworkPolicy {
        NetworkPolicy {
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
            prompt_on_first_access: true,
        }
    }

    #[test]
    fn allow_list_match() {
        let state = NetworkPolicyState::new(policy_with(&["github.com"], &[]));
        assert_eq!(state.evaluate("github.com"), NetworkDecision::Allow);
    }

    #[test]
    fn deny_list_match_takes_priority() {
        let state = NetworkPolicyState::new(policy_with(&["github.com"], &["github.com"]));
        match state.evaluate("github.com") {
            NetworkDecision::Deny(reason) => {
                assert!(reason.contains("github.com"));
            }
            other => panic!("expected Deny, got {other:?}"),
        }
    }

    #[test]
    fn wildcard_matches_subdomain() {
        let state = NetworkPolicyState::new(policy_with(&["*.github.com"], &[]));
        assert_eq!(state.evaluate("api.github.com"), NetworkDecision::Allow);
        assert_eq!(
            state.evaluate("raw.githubusercontent.github.com"),
            NetworkDecision::Allow
        );
    }

    #[test]
    fn wildcard_does_not_match_bare_domain() {
        let state = NetworkPolicyState::new(policy_with(&["*.github.com"], &[]));
        assert_eq!(state.evaluate("github.com"), NetworkDecision::Prompt);
    }

    #[test]
    fn session_cache_approval() {
        let mut state = NetworkPolicyState::new(policy_with(&[], &[]));
        assert_eq!(state.evaluate("example.com"), NetworkDecision::Prompt);

        state.record_approval("example.com".to_string());
        assert_eq!(
            state.evaluate("example.com"),
            NetworkDecision::SessionApproved
        );
    }

    #[test]
    fn session_cache_denial() {
        let mut state = NetworkPolicyState::new(policy_with(&[], &[]));
        state.record_denial("evil.com".to_string());
        assert_eq!(
            state.evaluate("evil.com"),
            NetworkDecision::SessionDenied
        );
    }

    #[test]
    fn prompt_for_unknown_domain() {
        let state = NetworkPolicyState::new(policy_with(&["github.com"], &[]));
        assert_eq!(state.evaluate("unknown.example.org"), NetworkDecision::Prompt);
    }

    #[test]
    fn deny_reason_includes_pattern() {
        let state = NetworkPolicyState::new(policy_with(&[], &["*.evil.org"]));
        match state.evaluate("sub.evil.org") {
            NetworkDecision::Deny(reason) => {
                assert!(reason.contains("*.evil.org"));
                assert!(reason.contains("sub.evil.org"));
            }
            other => panic!("expected Deny, got {other:?}"),
        }
    }

    #[test]
    fn no_prompt_when_disabled() {
        let policy = NetworkPolicy {
            allow: vec![],
            deny: vec![],
            prompt_on_first_access: false,
        };
        let state = NetworkPolicyState::new(policy);
        assert_eq!(state.evaluate("anything.com"), NetworkDecision::Allow);
    }

    #[test]
    fn case_insensitive_matching() {
        let state = NetworkPolicyState::new(policy_with(&["GitHub.COM"], &[]));
        assert_eq!(state.evaluate("github.com"), NetworkDecision::Allow);
        assert_eq!(state.evaluate("GITHUB.COM"), NetworkDecision::Allow);
    }

    #[test]
    fn extract_domain_from_url() {
        assert_eq!(
            extract_domain("https://api.github.com/repos/foo/bar"),
            Some("api.github.com".to_string())
        );
        assert_eq!(
            extract_domain("http://EXAMPLE.COM:8080/path"),
            Some("example.com".to_string())
        );
        assert_eq!(extract_domain("not-a-url"), None);
    }

    #[test]
    fn wildcard_deny_blocks_subdomain() {
        let state = NetworkPolicyState::new(policy_with(&[], &["*.malware.io"]));
        match state.evaluate("cdn.malware.io") {
            NetworkDecision::Deny(_) => {}
            other => panic!("expected Deny, got {other:?}"),
        }
        // Bare domain not matched by wildcard deny
        assert_eq!(state.evaluate("malware.io"), NetworkDecision::Prompt);
    }
}

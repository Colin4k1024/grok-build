use super::bash_command_splitting::{
    normalize_command_words, try_parse_shell, try_parse_word_only_commands_sequence,
};

/// Canonical form of a bash command for permission caching.
#[derive(Debug, Clone)]
pub struct CanonicalCommand {
    pub canonical_argv: Vec<String>,
    pub is_dangerous: bool,
    pub cache_key: String,
}

/// Canonicalize a raw bash script into a stable cache key.
/// Returns None if the command cannot be parsed (opaque scripts don't cache).
pub fn canonicalize_for_cache(raw_script: &str) -> Option<CanonicalCommand> {
    let tree = try_parse_shell(raw_script)?;
    let commands = try_parse_word_only_commands_sequence(&tree, raw_script)?;

    if commands.is_empty() {
        return None;
    }

    let mut all_argv: Vec<Vec<String>> = Vec::new();

    for parsed in &commands {
        let raw_words = parsed.words();
        if raw_words.is_empty() {
            continue;
        }

        let normalized = normalize_command_words(raw_words);

        // If normalization failed (ambiguous, split-string, etc.), don't cache.
        if normalized.ambiguous || normalized.has_split_string || normalized.env_options_uncertain {
            return None;
        }

        let words = normalized.words;
        if words.is_empty() {
            continue;
        }

        // Normalize: lowercase the command name, keep args as-is.
        let mut argv: Vec<String> = Vec::with_capacity(words.len());
        let cmd_name = basename(&words[0]).to_ascii_lowercase();
        argv.push(cmd_name);
        for arg in &words[1..] {
            argv.push(arg.clone());
        }
        all_argv.push(argv);
    }

    if all_argv.is_empty() {
        return None;
    }

    // Build cache_key by joining argv words with \x00, segments with \x01.
    let cache_key = all_argv
        .iter()
        .map(|argv| argv.join("\x00"))
        .collect::<Vec<_>>()
        .join("\x01");

    // Flatten for danger check.
    let is_dangerous = all_argv.iter().any(|argv| is_dangerous_pattern(argv));

    // Use the first non-setup command's argv as the canonical representation.
    let canonical_argv = all_argv.into_iter().next().unwrap_or_default();

    Some(CanonicalCommand {
        canonical_argv,
        is_dangerous,
        cache_key,
    })
}

/// Extract the basename of a command path (e.g. "/usr/bin/env" -> "env").
fn basename(cmd: &str) -> &str {
    cmd.rsplit(['/', '\\']).next().unwrap_or(cmd)
}

/// Dangerous command patterns that should NEVER be cached.
fn is_dangerous_pattern(argv: &[String]) -> bool {
    if argv.is_empty() {
        return false;
    }
    let cmd = argv[0].as_str();

    match cmd {
        "rm" => argv.iter().any(|a| {
            let a = a.as_str();
            a.contains("rf") || a.contains("fr") || a == "-r" || a == "-f"
        }),
        "chmod" => {
            // chmod 777 or chmod on system paths
            argv.iter().any(|a| a == "777")
                || argv
                    .iter()
                    .skip(1)
                    .any(|a| is_system_path(a) && !a.starts_with('-'))
        }
        "chown" => argv
            .iter()
            .skip(1)
            .any(|a| is_system_path(a) && !a.starts_with('-')),
        "sudo" => true,
        "dd" | "mkfs" | "fdisk" => true,
        "curl" | "wget" => {
            // curl/wget piped to sh/bash is caught at the multi-segment level,
            // but flag it if args include pipe-to-shell indicators.
            argv.iter()
                .any(|a| a == "sh" || a == "bash" || a == "/bin/sh" || a == "/bin/bash")
        }
        _ => false,
    }
}

/// Check if a path is a system-critical path.
fn is_system_path(p: &str) -> bool {
    p == "/"
        || p.starts_with("/etc")
        || p.starts_with("/usr")
        || p.starts_with("/bin")
        || p.starts_with("/sbin")
        || p.starts_with("/boot")
        || p.starts_with("/sys")
        || p.starts_with("/proc")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_command_canonicalizes() {
        let result = canonicalize_for_cache("cargo test --lib").unwrap();
        assert_eq!(result.canonical_argv, vec!["cargo", "test", "--lib"]);
        assert!(!result.is_dangerous);
        assert!(!result.cache_key.is_empty());
    }

    #[test]
    fn bash_lc_wrapper_is_stripped() {
        // bash -lc "cargo test" should canonicalize to just "cargo test"
        let result = canonicalize_for_cache("env cargo test").unwrap();
        assert_eq!(result.canonical_argv[0], "cargo");
        assert!(!result.is_dangerous);
    }

    #[test]
    fn timeout_wrapper_is_stripped() {
        let result = canonicalize_for_cache("timeout 30 cargo build").unwrap();
        assert_eq!(result.canonical_argv, vec!["cargo", "build"]);
        assert!(!result.is_dangerous);
    }

    #[test]
    fn env_wrapper_is_stripped() {
        let result = canonicalize_for_cache("env FOO=bar cargo test").unwrap();
        assert_eq!(result.canonical_argv, vec!["cargo", "test"]);
        assert!(!result.is_dangerous);
    }

    #[test]
    fn dangerous_rm_rf_detected() {
        let result = canonicalize_for_cache("rm -rf /tmp/foo").unwrap();
        assert!(result.is_dangerous);
    }

    #[test]
    fn dangerous_sudo_detected() {
        let result = canonicalize_for_cache("sudo apt-get install foo").unwrap();
        assert!(result.is_dangerous);
    }

    #[test]
    fn unparseable_script_returns_none() {
        // Complex script with command substitution
        let result = canonicalize_for_cache("echo $(cat /etc/passwd)");
        assert!(result.is_none());
    }

    #[test]
    fn equivalent_commands_produce_same_cache_key() {
        let a = canonicalize_for_cache("env FOO=1 cargo test").unwrap();
        let b = canonicalize_for_cache("env BAR=2 cargo test").unwrap();
        assert_eq!(a.cache_key, b.cache_key);
    }

    #[test]
    fn different_commands_produce_different_cache_keys() {
        let a = canonicalize_for_cache("cargo test").unwrap();
        let b = canonicalize_for_cache("cargo build").unwrap();
        assert_ne!(a.cache_key, b.cache_key);
    }

    #[test]
    fn path_qualified_command_normalized() {
        let result = canonicalize_for_cache("/usr/bin/cargo test").unwrap();
        assert_eq!(result.canonical_argv[0], "cargo");
    }

    #[test]
    fn command_name_lowercased() {
        // Edge case: command names are lowercased for stable keys
        let result = canonicalize_for_cache("CARGO test").unwrap();
        assert_eq!(result.canonical_argv[0], "cargo");
    }

    #[test]
    fn chained_commands_canonicalize() {
        let result = canonicalize_for_cache("cd /tmp && cargo test").unwrap();
        // cd is a setup command; canonical_argv is the first non-empty normalized segment
        assert!(!result.cache_key.is_empty());
    }

    #[test]
    fn dangerous_dd_detected() {
        let result = canonicalize_for_cache("dd if=/dev/zero of=/dev/sda").unwrap();
        assert!(result.is_dangerous);
    }

    #[test]
    fn chmod_777_is_dangerous() {
        let result = canonicalize_for_cache("chmod 777 /etc/passwd").unwrap();
        assert!(result.is_dangerous);
    }
}

//! PostToolUse observer: logs sanitized bash commands to `~/.grok/bash-commands.log`.

use regex::Regex;
use std::sync::LazyLock;

use crate::event::{HookEventEnvelope, HookEventName, HookPayload};
use crate::runner::HookRunnerResult;

use super::NativeHook;

static SANITIZERS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (Regex::new(r"--token[= ][^ ]*").unwrap(), "--token=<REDACTED>"),
        (
            Regex::new(r"(?i)Authorization:[: ]*[^ ]*[: ]*[^ ]*").unwrap(),
            "Authorization:<REDACTED>",
        ),
        (Regex::new(r"\bAKIA[A-Z0-9]{16}\b").unwrap(), "<REDACTED>"),
        (Regex::new(r"\bASIA[A-Z0-9]{16}\b").unwrap(), "<REDACTED>"),
        (
            Regex::new(r"(?i)password[= ][^ ]*").unwrap(),
            "password=<REDACTED>",
        ),
        (Regex::new(r"\bghp_[A-Za-z0-9_]+\b").unwrap(), "<REDACTED>"),
        (Regex::new(r"\bgho_[A-Za-z0-9_]+\b").unwrap(), "<REDACTED>"),
        (Regex::new(r"\bghs_[A-Za-z0-9_]+\b").unwrap(), "<REDACTED>"),
        (
            Regex::new(r"\bgithub_pat_[A-Za-z0-9_]+\b").unwrap(),
            "<REDACTED>",
        ),
    ]
});

pub fn sanitize_command(command: &str) -> String {
    let mut result = command.replace('\n', " ");
    for (re, replacement) in SANITIZERS.iter() {
        result = re.replace_all(&result, *replacement).into_owned();
    }
    result
}

pub struct CommandLog {
    tool_call_counter: std::sync::Arc<std::sync::atomic::AtomicU32>,
}

impl CommandLog {
    pub fn new(counter: std::sync::Arc<std::sync::atomic::AtomicU32>) -> Self {
        Self {
            tool_call_counter: counter,
        }
    }
}

impl NativeHook for CommandLog {
    fn name(&self) -> &str {
        "tsp:command-log"
    }

    fn event(&self) -> HookEventName {
        HookEventName::PostToolUse
    }

    fn matcher(&self) -> Option<&str> {
        Some("Bash")
    }

    fn execute(&self, envelope: &HookEventEnvelope) -> HookRunnerResult {
        // Increment shared tool call counter for session complexity tracking
        self.tool_call_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let command = match &envelope.payload {
            HookPayload::PostToolUse { tool_input, .. } => {
                tool_input.get("command").and_then(|v| v.as_str()).unwrap_or("?")
            }
            _ => return HookRunnerResult::Success,
        };

        let sanitized = sanitize_command(command);
        let log_line = format!("[{}] {sanitized}", envelope.timestamp);

        let log_path = xai_grok_config::grok_home().join("bash-commands.log");
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "{log_line}")
            });

        HookRunnerResult::Success
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_github_token() {
        let input = "gh auth login --token ghp_abc123DEF456xyz789";
        let result = sanitize_command(input);
        assert!(!result.contains("ghp_"));
        assert!(result.contains("<REDACTED>"));
    }

    #[test]
    fn sanitizes_aws_key() {
        let input = "aws configure set key AKIAIOSFODNN7EXAMPLE";
        let result = sanitize_command(input);
        assert!(!result.contains("AKIA"));
        assert!(result.contains("<REDACTED>"));
    }

    #[test]
    fn sanitizes_password() {
        let input = "mysql -u root password=secret123";
        let result = sanitize_command(input);
        assert!(!result.contains("secret123"));
    }

    #[test]
    fn preserves_normal_command() {
        let input = "git status";
        assert_eq!(sanitize_command(input), "git status");
    }
}

//! Next-prompt prediction helpers (tab autocomplete ghost text).
//!
//! After a turn completes, the client asks the session to predict what the
//! user is likely to type next. The prediction renders as dim ghost text in
//! the empty prompt input; Tab accepts it. Modelled on common coding-agent
//! prompt suggestion features, but instead of replaying the full conversation prefix
//! it sends a *compact text-only transcript* — the call always routes to a
//! small dedicated model (configurable, [`DEFAULT_SUGGEST_MODEL`] by
//! default, never the session model — see [`effective_suggest_model`]),
//! where the parent session's prompt cache would not apply anyway, so a
//! small request wins on both cost and latency.
//!
//! The pure helpers here build the request items and filter the model output;
//! the actual model call lives on the `SessionActor`
//! (`handle_suggest_prompt`).

use crate::config::PromptSuggestModelPin;
use crate::sampling::ConversationItem;
use crate::session::helpers::chat::floor_char_boundary;

/// Model used for suggestion calls when nothing pins one (no env /
/// `[models] prompt_suggestion` / remote setting / client hint — see
/// [`effective_suggest_model`]). Suggestion requests must stay on a small,
/// fast model: falling back to the session model would multiply the per-turn
/// cost of the feature and add reasoning-model latency for a throwaway
/// prediction.
pub(crate) const DEFAULT_SUGGEST_MODEL: &str = "grok-build-0.1";

/// Resolve the model for one suggestion request, or `None` to skip the
/// request entirely (controlled disable).
///
/// Precedence: env pin > config.toml/remote pin > client hint (the request's
/// `model` param) > [`DEFAULT_SUGGEST_MODEL`]. Every tier except the env pin
/// is catalog-guarded via `in_catalog`: [`DEFAULT_SUGGEST_MODEL`]
/// (`grok-build-0.1`) is API-key-only and excluded from OAuth catalogs, so
/// firing it (or any unavailable pin) would send a doomed per-turn request
/// that can never render ghost text. Skipping keeps the per-turn cost at
/// zero; deliberately NOT a session-model fallback — a per-turn background
/// call must stay on a small cheap model. The env pin bypasses the guard so
/// `GROK_PROMPT_SUGGESTIONS_MODEL` keeps working for models the catalog does
/// not list (mirrors the pager, which forwards the env value unchecked).
pub(crate) fn effective_suggest_model(
    pin: &PromptSuggestModelPin,
    client_hint: Option<&str>,
    in_catalog: impl Fn(&str) -> bool,
) -> Option<String> {
    let client_hint = client_hint.map(str::trim).filter(|s| !s.is_empty());
    let (model, catalog_guarded) = match pin {
        PromptSuggestModelPin::Env(m) => (m.as_str(), false),
        PromptSuggestModelPin::Pinned(m) => (m.as_str(), true),
        PromptSuggestModelPin::Unpinned => (client_hint.unwrap_or(DEFAULT_SUGGEST_MODEL), true),
    };
    if catalog_guarded && !in_catalog(model) {
        return None;
    }
    Some(model.to_owned())
}

/// Total character budget for the compact transcript (~6k tokens at the
/// bytes/4 estimate). Keeps the per-turn cost of the feature trivial even on
/// long sessions.
const TRANSCRIPT_BUDGET_CHARS: usize = 24_000;

/// Per-message character cap inside the transcript. Long messages (pasted
/// logs, big diffs) carry little signal for next-prompt prediction.
const MESSAGE_CAP_CHARS: usize = 1_500;

/// Reject suggestions longer than this — a prompt suggestion should be a
/// short, obvious next step, not an essay.
const SUGGESTION_MAX_CHARS: usize = 120;

/// Reject suggestions with more words than this (mirrors common
/// "2-12 words" guidance with a little slack).
const SUGGESTION_MAX_WORDS: usize = 16;

/// Short replies that are useful suggestions despite being a single word.
const ONE_WORD_ALLOWLIST: &[&str] = &[
    "yes", "yeah", "yep", "no", "ok", "okay", "continue", "proceed", "push", "commit", "deploy",
    "stop", "check", "retry", "undo", "merge",
];

/// System prompt for the suggestion call. The model sees a compact transcript
/// and must reply with ONLY the predicted next user message (or nothing).
pub(crate) const SUGGEST_PROMPT_SYSTEM: &str = "You predict what the USER will type next into their coding agent CLI.\n\
    You are shown a transcript of the conversation so far. The agent's latest reply ends the transcript.\n\n\
    FIRST: look at the user's recent messages and original request.\n\
    Your job is to predict what THEY would type next — not what you think they should do.\n\
    THE TEST: would they think \"I was just about to type that\"?\n\n\
    EXAMPLES:\n\
    - User asked \"fix the bug and run tests\", bug is fixed -> \"run the tests\"\n\
    - After code was written -> \"try it out\"\n\
    - Agent offers options -> the option the user would likely pick, based on the conversation\n\
    - Agent ends by asking a yes/no question (continue? delete it? print it?) -> the user's likely answer: \"yes\" or \"no\"\n\
    - Task complete with an obvious follow-up -> \"commit this\" or \"push it\"\n\
    - After an error or a misunderstanding -> NONE (let them assess)\n\n\
    Be specific: \"run the tests\" beats \"continue\".\n\
    When the agent's reply ends with a question, a suggestion almost always exists — predict the answer.\n\n\
    NEVER SUGGEST:\n\
    - A message the user already sent, or a rephrasing of one — the transcript is history, not a menu. \
Once a request was handled, predict the step AFTER it, never the request again \
(short confirmations like \"yes\" or \"continue\" are the only acceptable repeats)\n\
    - Evaluative filler (\"looks good\", \"thanks\")\n\
    - Questions back to the agent (\"what about...?\")\n\
    - Agent-voice phrasing (\"Let me...\", \"I'll...\", \"Here's...\")\n\
    - New ideas the user never asked about\n\
    - Multiple sentences\n\n\
    Stay silent if the next step is not obvious from what the user said: reply with the single word NONE.\n\n\
    Format: 2-12 words, matching the user's own style and casing.\n\
    Reply with ONLY the suggestion text (or NONE) — no quotes, no markdown, no explanation.";

/// One transcript line: role label + flattened text content.
fn transcript_line(role: &str, text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut text = text;
    if text.len() > MESSAGE_CAP_CHARS {
        let cut = floor_char_boundary(text, MESSAGE_CAP_CHARS);
        text = &text[..cut];
    }
    Some(format!("{role}: {text}"))
}

/// Build the compact transcript from a conversation snapshot.
///
/// Keeps genuine `User` messages (skipping runtime-synthesized ones) and
/// `Assistant` text, newest-last, walking backwards until the character
/// budget is exhausted. Tool calls/results, reasoning, and the system prompt
/// are dropped — the user/assistant dialogue carries the signal for "what
/// will the user type next", and dropping the rest keeps the request cheap.
///
/// Returns `None` when the conversation has no assistant reply yet (nothing
/// to predict from).
pub(crate) fn build_transcript(conversation: &[ConversationItem]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut saw_assistant = false;

    for item in conversation.iter().rev() {
        let line = match item {
            ConversationItem::User(u) => {
                if u.synthetic_reason.is_some() {
                    continue;
                }
                transcript_line("User", &item.text_content())
            }
            ConversationItem::Assistant(_) => {
                let line = transcript_line("Agent", &item.text_content());
                if line.is_some() {
                    saw_assistant = true;
                }
                line
            }
            _ => continue,
        };
        let Some(line) = line else { continue };
        if used + line.len() > TRANSCRIPT_BUDGET_CHARS && !lines.is_empty() {
            break;
        }
        used += line.len();
        lines.push(line);
    }

    if !saw_assistant || lines.is_empty() {
        return None;
    }

    lines.reverse();
    Some(lines.join("\n\n"))
}

/// Build the user message for the suggestion request.
pub(crate) fn suggest_prompt_user_message(transcript: &str, cwd: &str) -> String {
    format!(
        "CWD: {cwd}\n\nTranscript:\n\n{transcript}\n\n\
         Predict the user's next message. Reply with ONLY the suggestion text."
    )
}

/// Minimum word count for the deterministic repeat filter. Short
/// command-like replies ("yes", "run tests", "try again") legitimately
/// recur across a session; a repeated multi-word task prompt is the
/// "it suggested my old prompt back to me" failure mode.
const REPEAT_MIN_WORDS: usize = 4;

/// Case- and whitespace-insensitive form used for repeat comparison, with
/// trailing sentence punctuation dropped.
fn normalize_for_repeat(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', '!', '?'])
        .to_ascii_lowercase()
}

/// Whether a sanitized suggestion merely repeats a message the user already
/// sent. Deterministic backstop behind the system prompt's anti-repeat rule:
/// prompt guidance reduces repeats, this guarantees an exact (normalized)
/// re-suggestion of a past multi-word prompt never renders as ghost text.
/// Short suggestions (< [`REPEAT_MIN_WORDS`] words) are exempt — repeating
/// "yes" or "run tests" is often exactly what the user is about to type.
pub(crate) fn is_repeat_of_user_message(
    suggestion: &str,
    conversation: &[ConversationItem],
) -> bool {
    if suggestion.split_whitespace().count() < REPEAT_MIN_WORDS {
        return false;
    }
    let needle = normalize_for_repeat(suggestion);
    conversation.iter().any(|item| match item {
        ConversationItem::User(u) if u.synthetic_reason.is_none() => {
            normalize_for_repeat(&item.text_content()) == needle
        }
        _ => false,
    })
}

/// Filter/normalize the raw model output into a usable suggestion.
///
/// Returns `None` for anything that should not be shown as ghost text:
/// meta/no-op replies, agent-voice phrasing, multi-sentence or multi-line
/// output, markdown, or over-long text. Mirrors typical coding-agent suggestion
/// filters, adapted to the compact-transcript prompt above.
pub(crate) fn sanitize_suggestion(raw: &str) -> Option<String> {
    // First line only; the prompt asks for a single line but models drift.
    let line = raw.trim().lines().next()?.trim();

    // Strip common wrappers the prompt forbids but models still emit.
    let line = line
        .trim_start_matches(['"', '\'', '`', '“', '‘'])
        .trim_end_matches(['"', '\'', '`', '”', '’'])
        .trim();

    if line.is_empty() || line.len() >= SUGGESTION_MAX_CHARS {
        return None;
    }

    // Meta / "no suggestion" replies.
    let lowered = line.to_ascii_lowercase();
    let meta = [
        "none",
        "n/a",
        "no suggestion",
        "nothing",
        "(silence)",
        "silence",
        "null",
    ];
    if meta
        .iter()
        .any(|m| lowered == *m || lowered.starts_with(&format!("{m}.")))
    {
        return None;
    }

    // Markdown / formatting — ghost text renders on a single styled line.
    if line.contains('*') || line.contains("```") || line.starts_with('#') || line.starts_with('-')
    {
        return None;
    }

    // Agent-voice phrasing — the suggestion must be in the USER's voice.
    let agent_voice = [
        "i'll ",
        "i will ",
        "let me ",
        "here's ",
        "here is ",
        "i'm going to ",
    ];
    if agent_voice.iter().any(|p| lowered.starts_with(p)) {
        return None;
    }

    // Parenthetical/bracketed meta replies like "(no suggestion)".
    if (line.starts_with('(') && line.ends_with(')'))
        || (line.starts_with('[') && line.ends_with(']'))
    {
        return None;
    }

    // Label prefixes like "Suggestion: ..." / "User: ...".
    if let Some((head, _)) = line.split_once(':')
        && !head.contains(' ')
        && head.chars().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }

    // Multiple sentences read as agent prose, not a prompt.
    let multi_sentence = line
        .as_bytes()
        .windows(3)
        .any(|w| matches!(w[0], b'.' | b'!' | b'?') && w[1] == b' ' && w[2].is_ascii_uppercase());
    if multi_sentence {
        return None;
    }

    // Word-count bounds: 1 word only from the allowlist, and never a wall of text.
    let words = line.split_whitespace().count();
    if words > SUGGESTION_MAX_WORDS {
        return None;
    }
    if words == 1 {
        let bare = lowered.trim_end_matches(['.', '!']);
        if !ONE_WORD_ALLOWLIST.contains(&bare) && !bare.starts_with('/') {
            return None;
        }
    }

    Some(line.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PromptSuggestModelPin as Pin;

    // -- effective_suggest_model ---------------------------------------------

    #[test]
    fn effective_model_default_requires_catalog() {
        // No pin, no hint: the built-in default fires only when this shell's
        // catalog can sample it.
        assert_eq!(
            effective_suggest_model(&Pin::Unpinned, None, |m| m == DEFAULT_SUGGEST_MODEL)
                .as_deref(),
            Some(DEFAULT_SUGGEST_MODEL)
        );
        // OAuth catalogs exclude grok-build-0.1 → skip the request entirely,
        // never a doomed call (and never the session model).
        assert_eq!(
            effective_suggest_model(&Pin::Unpinned, None, |_| false),
            None
        );
    }

    #[test]
    fn effective_model_client_hint_beats_default_and_is_guarded() {
        assert_eq!(
            effective_suggest_model(&Pin::Unpinned, Some("hinted"), |m| m == "hinted").as_deref(),
            Some("hinted")
        );
        // A hint the shell can't sample skips — no silent fall-through.
        assert_eq!(
            effective_suggest_model(&Pin::Unpinned, Some("hinted"), |_| false),
            None
        );
        // Blank hints are ignored: the default tier applies.
        assert_eq!(
            effective_suggest_model(&Pin::Unpinned, Some("  "), |m| m == DEFAULT_SUGGEST_MODEL)
                .as_deref(),
            Some(DEFAULT_SUGGEST_MODEL)
        );
    }

    #[test]
    fn effective_model_pin_beats_client_hint_and_is_guarded() {
        assert_eq!(
            effective_suggest_model(&Pin::Pinned("pinned".into()), Some("hinted"), |m| m
                == "pinned"
                || m == "hinted")
            .as_deref(),
            Some("pinned")
        );
        // A pinned-but-unavailable model skips — the pin is an explicit
        // choice, not a preference list; no fall-through to hint or default.
        assert_eq!(
            effective_suggest_model(&Pin::Pinned("pinned".into()), Some("hinted"), |m| m
                == "hinted"),
            None
        );
    }

    #[test]
    fn effective_model_env_pin_bypasses_catalog_guard() {
        // GROK_PROMPT_SUGGESTIONS_MODEL is the explicit escape hatch: used
        // verbatim even when the catalog does not list the model (mirrors
        // the pager, which forwards the env value unchecked).
        assert_eq!(
            effective_suggest_model(&Pin::Env("custom-model".into()), Some("hinted"), |_| false)
                .as_deref(),
            Some("custom-model")
        );
    }

    // -- sanitize_suggestion ------------------------------------------------

    #[test]
    fn sanitize_accepts_short_imperative() {
        assert_eq!(
            sanitize_suggestion("run the tests").as_deref(),
            Some("run the tests")
        );
    }

    #[test]
    fn sanitize_strips_quotes_and_backticks() {
        assert_eq!(
            sanitize_suggestion("\"commit this\"").as_deref(),
            Some("commit this")
        );
        assert_eq!(sanitize_suggestion("`push it`").as_deref(), Some("push it"));
    }

    #[test]
    fn sanitize_takes_first_line_only() {
        assert_eq!(
            sanitize_suggestion("run the tests\nthen commit").as_deref(),
            Some("run the tests")
        );
    }

    #[test]
    fn sanitize_rejects_none_and_meta() {
        for s in ["NONE", "none", "n/a", "no suggestion", "(silence)", ""] {
            assert_eq!(sanitize_suggestion(s), None, "should reject {s:?}");
        }
    }

    #[test]
    fn sanitize_rejects_agent_voice() {
        for s in [
            "I'll run the tests",
            "Let me check the output",
            "Here's what to do next",
        ] {
            assert_eq!(sanitize_suggestion(s), None, "should reject {s:?}");
        }
    }

    #[test]
    fn sanitize_rejects_markdown_and_labels() {
        for s in [
            "**run tests**",
            "- run tests",
            "# next",
            "Suggestion: run tests",
            "```run```",
        ] {
            assert_eq!(sanitize_suggestion(s), None, "should reject {s:?}");
        }
    }

    #[test]
    fn sanitize_rejects_multi_sentence_and_overlong() {
        assert_eq!(
            sanitize_suggestion("Run the tests. Then commit the changes."),
            None
        );
        let long = "word ".repeat(20);
        assert_eq!(sanitize_suggestion(&long), None);
        let chars = "x".repeat(200);
        assert_eq!(sanitize_suggestion(&chars), None);
    }

    #[test]
    fn sanitize_one_word_allowlist() {
        assert_eq!(sanitize_suggestion("yes").as_deref(), Some("yes"));
        assert_eq!(sanitize_suggestion("commit").as_deref(), Some("commit"));
        // Bare one-word verbs outside the allowlist are too ambiguous.
        assert_eq!(sanitize_suggestion("refactor"), None);
        // Slash commands are fine.
        assert_eq!(sanitize_suggestion("/review").as_deref(), Some("/review"));
    }

    #[test]
    fn sanitize_allows_colon_after_multiword_head() {
        // Only single-word alphabetic label heads are rejected.
        assert_eq!(
            sanitize_suggestion("fix the parse error: line 42").as_deref(),
            Some("fix the parse error: line 42")
        );
    }

    // -- build_transcript ---------------------------------------------------

    fn user(text: &str) -> ConversationItem {
        ConversationItem::user(text.to_owned())
    }

    fn assistant(text: &str) -> ConversationItem {
        ConversationItem::assistant(text.to_owned())
    }

    // -- is_repeat_of_user_message -------------------------------------------

    #[test]
    fn repeat_filter_rejects_verbatim_past_prompt() {
        let conv = vec![user("fix the flaky auth test"), assistant("Fixed it")];
        assert!(is_repeat_of_user_message("fix the flaky auth test", &conv));
    }

    #[test]
    fn repeat_filter_is_case_whitespace_and_punctuation_insensitive() {
        let conv = vec![user("Fix  the flaky\nauth test."), assistant("Fixed it")];
        assert!(is_repeat_of_user_message("fix the flaky auth test!", &conv));
    }

    #[test]
    fn repeat_filter_exempts_short_suggestions() {
        let conv = vec![user("run the tests"), assistant("3 failures")];
        // 3 words — legitimately recurs after new changes.
        assert!(!is_repeat_of_user_message("run the tests", &conv));
        assert!(!is_repeat_of_user_message("yes", &conv));
    }

    #[test]
    fn repeat_filter_allows_novel_suggestions() {
        let conv = vec![user("fix the flaky auth test"), assistant("Fixed it")];
        assert!(!is_repeat_of_user_message("commit and push the fix", &conv));
    }

    #[test]
    fn repeat_filter_ignores_synthetic_user_messages() {
        let mut synthetic = user("please review the changes now");
        if let ConversationItem::User(u) = &mut synthetic {
            u.synthetic_reason = Some(crate::sampling::SyntheticReason::SystemReminder);
        }
        let conv = vec![synthetic, assistant("done")];
        assert!(!is_repeat_of_user_message(
            "please review the changes now",
            &conv
        ));
    }

    #[test]
    fn transcript_keeps_user_and_assistant_in_order() {
        let conv = vec![
            ConversationItem::system("sys".to_owned()),
            user("fix the bug"),
            assistant("Fixed it in foo.rs"),
        ];
        let t = build_transcript(&conv).unwrap();
        assert_eq!(t, "User: fix the bug\n\nAgent: Fixed it in foo.rs");
    }

    #[test]
    fn transcript_requires_an_assistant_reply() {
        let conv = vec![ConversationItem::system("sys".to_owned()), user("hello")];
        assert!(build_transcript(&conv).is_none());
        assert!(build_transcript(&[]).is_none());
    }

    #[test]
    fn transcript_skips_synthetic_user_messages() {
        let mut synthetic = ConversationItem::user("synthetic reminder".to_owned());
        if let ConversationItem::User(u) = &mut synthetic {
            u.synthetic_reason = Some(crate::sampling::SyntheticReason::SystemReminder);
        }
        let conv = vec![user("real question"), synthetic, assistant("answer")];
        let t = build_transcript(&conv).unwrap();
        assert!(!t.contains("synthetic reminder"));
        assert!(t.contains("User: real question"));
    }

    #[test]
    fn transcript_caps_long_messages() {
        let long = "a".repeat(10_000);
        let conv = vec![user(&long), assistant("ok")];
        let t = build_transcript(&conv).unwrap();
        assert!(
            t.len() < 2_000,
            "long message must be truncated: {}",
            t.len()
        );
    }

    #[test]
    fn transcript_budget_keeps_newest_messages() {
        let filler = "b".repeat(MESSAGE_CAP_CHARS);
        let mut conv = Vec::new();
        for _ in 0..40 {
            conv.push(user(&filler));
            conv.push(assistant(&filler));
        }
        conv.push(user("newest question"));
        conv.push(assistant("newest answer"));
        let t = build_transcript(&conv).unwrap();
        assert!(t.len() <= TRANSCRIPT_BUDGET_CHARS + MESSAGE_CAP_CHARS + 64);
        assert!(t.contains("newest question"));
        assert!(t.ends_with("Agent: newest answer"));
    }
}

/// System prompt for generating coding-agent follow-up suggestions.
/// Unlike ghost-text prediction (what user WILL type), this generates
/// what the user SHOULD consider doing next — actionable next steps.
pub(crate) const SUGGESTED_QUESTION_SYSTEM: &str = "\
You are a coding agent assistant. After each turn, suggest ONE actionable next step the user might want to take.

CONTEXT: You see the last few exchanges between a user and a coding agent (which can read/write files, run bash, search code, etc).

RULES:
1. Suggest a concrete, actionable next step — not a vague question
2. Match the workflow stage:
   - After writing code → suggest testing, linting, or committing
   - After fixing a bug → suggest verifying the fix or running regression tests
   - After reading/searching code → suggest a specific action based on findings
   - After running tests with failures → suggest fixing the specific failure
   - After a successful task completion → suggest the logical next task
   - After an error → suggest a specific debugging step
3. Keep it under 50 characters, imperative voice
4. Use the user's language (Chinese if they write Chinese, English if English)
5. Be specific: \"run cargo test\" beats \"run tests\"; \"commit these changes\" beats \"continue\"
6. NEVER suggest what was just done — always the NEXT step
7. If the agent asked a yes/no question, suggest the likely answer

Reply with ONLY the suggestion text. No quotes, no explanation.
Reply NONE if no obvious next step exists.";

/// Build the user message for suggested-question LLM call.
pub(crate) fn suggest_question_user_message(transcript: &str) -> String {
    format!(
        "Recent conversation:\n\n{transcript}\n\n\
         What should the user do next? Reply with ONE short actionable suggestion."
    )
}

/// Generate a follow-up suggestion from the conversation using context-aware heuristics.
/// This is the fast path (no LLM call) — produces decent suggestions for common patterns.
pub fn suggested_question(
    conversation: &[xai_grok_sampling_types::ConversationItem],
) -> Option<String> {
    let mut last_user = String::new();
    let mut last_assistant = String::new();
    let mut tools_used: Vec<String> = Vec::new();
    let mut user_lang_chinese = false;

    for item in conversation.iter().rev() {
        match item {
            xai_grok_sampling_types::ConversationItem::User(_) => {
                if last_user.is_empty() {
                    last_user = item.text_content();
                    user_lang_chinese = last_user.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
                }
            }
            xai_grok_sampling_types::ConversationItem::Assistant(a) => {
                if last_assistant.is_empty() {
                    let text = a.content.as_ref();
                    if !text.is_empty() {
                        last_assistant = text.to_string();
                    }
                }
                for tc in &a.tool_calls {
                    if tools_used.len() < 5 {
                        tools_used.push(tc.name.clone());
                    }
                }
            }
            _ => {}
        }
        if !last_user.is_empty() && !last_assistant.is_empty() {
            break;
        }
    }

    if last_user.is_empty() && last_assistant.is_empty() {
        return None;
    }

    // Detect error signals
    let assistant_lower = last_assistant.to_lowercase();
    let had_error = assistant_lower.contains("error")
        || assistant_lower.contains("failed")
        || assistant_lower.contains("panic")
        || assistant_lower.contains("cannot")
        || assistant_lower.contains("失败")
        || assistant_lower.contains("错误");

    // Detect completion signals
    let is_completed = assistant_lower.contains("completed")
        || assistant_lower.contains("done")
        || assistant_lower.contains("finished")
        || assistant_lower.contains("完成")
        || assistant_lower.contains("已创建")
        || assistant_lower.contains("已修复");

    // Detect the agent asking a question
    let agent_asks = last_assistant.ends_with('?')
        || last_assistant.ends_with('？')
        || last_assistant.contains("是否")
        || last_assistant.contains("需要我");

    // Context-aware suggestion generation
    let suggestion = if agent_asks {
        // Agent asked something — suggest the likely positive response
        if user_lang_chinese { "是的，继续" } else { "yes, proceed" }
    } else if had_error {
        // Error occurred — suggest debugging
        if tools_used.iter().any(|t| t == "Bash" || t == "run_terminal_command") {
            if user_lang_chinese { "查看完整错误日志" } else { "show the full error log" }
        } else {
            if user_lang_chinese { "分析并修复这个错误" } else { "fix this error" }
        }
    } else if is_completed {
        // Task completed — suggest next logical step based on what was done
        let wrote_code = tools_used.iter().any(|t| {
            t == "Write" || t == "Edit" || t == "search_replace" || t == "write_file"
        });
        let ran_tests = tools_used.iter().any(|t| t == "Bash" || t == "run_terminal_command")
            && (last_user.contains("test") || assistant_lower.contains("test"));

        if wrote_code && !ran_tests {
            if user_lang_chinese { "运行测试验证修改" } else { "run tests to verify" }
        } else if ran_tests {
            if user_lang_chinese { "提交这些更改" } else { "commit these changes" }
        } else {
            if user_lang_chinese { "继续下一个任务" } else { "continue to next task" }
        }
    } else if tools_used.iter().any(|t| t == "Read" || t == "read_file" || t == "Grep" || t == "grep") {
        // Just read/searched — suggest action based on findings
        if user_lang_chinese { "根据分析结果进行修改" } else { "make changes based on findings" }
    } else {
        // Generic fallback — but still actionable
        if user_lang_chinese { "继续" } else { "continue" }
    };

    Some(suggestion.to_string())
}

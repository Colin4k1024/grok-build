//! Auto-skill extraction at session end.
//!
//! Record → Analyze → Plan → Build → Export
//!
//! Inspired by Microsoft skill-recorder's multi-stage pipeline:
//! 1. **Record**: grok automatically records conversation + tool calls
//! 2. **Analyze**: extract intent from tool call patterns and user messages
//! 3. **Plan**: generalize the recorded steps into a reusable skill
//! 4. **Build**: produce SKILL.md from the plan
//! 5. **Export**: write to ~/.grok/skills/ for immediate availability
//!
//! High-confidence extractions are auto-approved; medium-confidence
//! drafts are saved for review.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const MIN_TOOL_CALLS: u32 = 3;
const MAX_DAILY_AUTO_SKILLS: u32 = 5;
const HIGH_CONFIDENCE_TOOL_VARIETY: usize = 3;

// ── Stage 1-2: Pattern Analysis ────────────────────────────────────

/// Extract tool call patterns from a conversation and produce a skill plan.
/// Uses heuristics rather than LLM calls — fast and deterministic.
pub fn analyze_and_plan(
    tool_calls: &[ToolCallRecord],
    user_messages: &[String],
) -> Option<SkillPlan> {
    if tool_calls.len() < MIN_TOOL_CALLS as usize {
        return None;
    }

    let intent = extract_intent(user_messages, tool_calls);
    if intent.is_empty() {
        return None;
    }

    let tool_names: Vec<String> = tool_calls
        .iter()
        .map(|tc| tc.tool_name.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    let tool_variety = tool_names.len();
    let confidence = if tool_variety >= HIGH_CONFIDENCE_TOOL_VARIETY
        && tool_calls.len() >= 5
    {
        "high"
    } else {
        "medium"
    };

    let name = slugify(&intent);
    let description = format!(
        "{} TRIGGER when: user needs to {}. DO NOT TRIGGER when: task is unrelated.",
        intent,
        intent.to_lowercase()
    );

    let steps: Vec<String> = tool_calls
        .iter()
        .map(|tc| format!("{}: {}", tc.tool_name, tc.summary))
        .collect();

    let allowed_tools: Vec<String> = tool_names;

    Some(SkillPlan {
        name,
        title: intent.clone(),
        description,
        summary: format!("Auto-extracted workflow for: {}", intent),
        generalization: format!(
            "Generalized from {} tool calls across {} unique tools in a session with intent: {}",
            tool_calls.len(),
            tool_variety,
            intent
        ),
        allowed_tools,
        steps,
        confidence: confidence.to_string(),
    })
}

fn extract_intent(user_messages: &[String], tool_calls: &[ToolCallRecord]) -> String {
    // Find the first substantive user message (not just "yes" / "continue")
    let first_real_msg = user_messages
        .iter()
        .find(|m| m.len() > 30)
        .map(|s| s.chars().take(120).collect::<String>());

    // Fall back to tool-based intent
    let tool_intent = tool_calls
        .first()
        .map(|tc| format!("{} using {}", tc.summary, tc.tool_name));

    first_real_msg.unwrap_or_else(|| tool_intent.unwrap_or_default())
}

// ── Stage 3-4: Build ────────────────────────────────────────────────

fn build_skill_body(plan: &SkillPlan) -> String {
    let steps_md = plan
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "## Overview\n\n\
         {}\n\n\
         ## Trigger\n\n\
         {}\n\n\
         ## Recorded Steps\n\n\
         {}\n\n\
         ## Allowed Tools\n\n\
         {}\n\n\
         ## Notes\n\n\
         This skill was auto-extracted from a session analysis. \
         Review and refine the steps before relying on it.",
        plan.summary,
        plan.description,
        steps_md,
        plan.allowed_tools.join(", "),
    )
}

fn render_skill_md(plan: &SkillPlan, body: &str, auto_approved: bool) -> String {
    let approval = if auto_approved { "auto" } else { "draft" };
    format!(
        "---\n\
         name: {name}\n\
         description: {description}\n\
         origin: auto-extracted\n\
         confidence: {confidence}\n\
         approval: {approval}\n\
         allowed-tools: [{allowed_tools}]\n\
         ---\n\
         # {title}\n\n\
         {body}",
        name = plan.name,
        description = plan.description,
        confidence = plan.confidence,
        approval = approval,
        allowed_tools = plan.allowed_tools.join(", "),
        title = plan.title,
        body = body,
    )
}

// ── Stage 5: Export ─────────────────────────────────────────────────

pub struct ExtractedSkill {
    pub name: String,
    pub title: String,
    pub confidence: String,
    pub auto_approved: bool,
    pub path: PathBuf,
}

/// Run the full pipeline and write the skill to disk.
pub fn run_pipeline(
    tool_calls: &[ToolCallRecord],
    user_messages: &[String],
    output_dir: &Path,
) -> Option<ExtractedSkill> {
    let plan = analyze_and_plan(tool_calls, user_messages)?;
    let auto_approved = plan.confidence == "high";
    let subdir = if auto_approved { "auto" } else { "draft" };
    let skill_dir = output_dir.join(subdir).join(&plan.name);

    let body = build_skill_body(&plan);
    let skill_md = render_skill_md(&plan, &body, auto_approved);

    if let Err(e) = std::fs::create_dir_all(&skill_dir) {
        tracing::error!(error = %e, path = %skill_dir.display(), "auto-skillify: failed to create dir");
        return None;
    }

    let path = skill_dir.join("SKILL.md");
    if let Err(e) = std::fs::write(&path, &skill_md) {
        tracing::error!(error = %e, path = %path.display(), "auto-skillify: failed to write");
        return None;
    }

    // Also write the analysis data for debugging
    let analysis_path = skill_dir.join("analysis.json");
    let _ = std::fs::write(
        &analysis_path,
        serde_json::json!({
            "tool_calls": tool_calls.iter().map(|tc| serde_json::json!({
                "tool": tc.tool_name,
                "summary": tc.summary,
            })).collect::<Vec<_>>(),
            "user_messages": user_messages,
            "plan": {
                "name": plan.name,
                "title": plan.title,
                "confidence": plan.confidence,
                "steps": plan.steps,
            },
        })
        .to_string(),
    );

    tracing::info!(
        name = %plan.name,
        confidence = %plan.confidence,
        auto_approved = auto_approved,
        path = %path.display(),
        "auto-skillify: exported skill"
    );

    increment_daily_count();
    Some(ExtractedSkill {
        name: plan.name,
        title: plan.title,
        confidence: plan.confidence,
        auto_approved,
        path,
    })
}

// ── Data types ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    pub tool_name: String,
    pub summary: String,
}

pub fn build_tool_summary(
    conversation: &[xai_grok_sampling_types::ConversationItem],
) -> (Vec<ToolCallRecord>, Vec<String>) {
    let mut tool_calls = Vec::new();
    let mut user_messages = Vec::new();

    for item in conversation {
        match item {
            xai_grok_sampling_types::ConversationItem::Assistant(assistant) => {
                for tc in &assistant.tool_calls {
                    let summary = extract_command_summary(&tc.name, &tc.arguments);
                    tool_calls.push(ToolCallRecord {
                        tool_name: tc.name.to_string(),
                        summary,
                    });
                }
            }
            xai_grok_sampling_types::ConversationItem::User(_) => {
                let text = item.text_content();
                if !text.is_empty() {
                    user_messages.push(text);
                }
            }
            _ => {}
        }
    }

    (tool_calls, user_messages)
}

fn extract_command_summary(tool_name: &str, arguments: &str) -> String {
    // Extract a short summary from the tool arguments
    let args: HashMap<String, serde_json::Value> =
        serde_json::from_str(arguments).unwrap_or_default();

    match tool_name.to_lowercase().as_str() {
        "run_terminal_command" | "bash" => {
            args.get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(80).collect())
                .unwrap_or_else(|| "shell command".to_string())
        }
        "read_file" | "read" => {
            args.get("file_path")
                .and_then(|v| v.as_str())
                .map(|s| format!("read {}", s))
                .unwrap_or_else(|| "read file".to_string())
        }
        "grep" | "search" => {
            args.get("pattern")
                .and_then(|v| v.as_str())
                .map(|s| format!("grep for '{}'", s))
                .unwrap_or_else(|| "search".to_string())
        }
        "search_replace" | "edit" | "write" => {
            args.get("file_path")
                .and_then(|v| v.as_str())
                .map(|s| format!("edit {}", s))
                .unwrap_or_else(|| "edit file".to_string())
        }
        "spawn_subagent" | "task" => {
            args.get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(80).collect())
                .unwrap_or_else(|| "spawn subagent".to_string())
        }
        "web_search" => {
            args.get("query")
                .and_then(|v| v.as_str())
                .map(|s| format!("search: {}", s.chars().take(60).collect::<String>()))
                .unwrap_or_else(|| "web search".to_string())
        }
        "web_fetch" => {
            args.get("url")
                .and_then(|v| v.as_str())
                .map(|s| format!("fetch: {}", s))
                .unwrap_or_else(|| "web fetch".to_string())
        }
        _ => tool_name.to_string(),
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SkillPlan {
    pub name: String,
    pub title: String,
    pub description: String,
    pub summary: String,
    pub generalization: String,
    pub allowed_tools: Vec<String>,
    pub steps: Vec<String>,
    pub confidence: String,
}

fn slugify(text: &str) -> String {
    let slug = text
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .replace("--", "-")
        .trim_matches('-')
        .to_string();
    if slug.is_empty() || slug == "-" {
        "untitled".to_string()
    } else {
        slug
            .chars()
            .take(60)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string()
    }
}

fn check_daily_limit() -> bool {
    let marker_path = xai_grok_config::grok_home().join(".auto-skillify-count");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let today_days = (now.as_secs() / 86400) as u64;

    let (stored_days, count) = std::fs::read_to_string(&marker_path)
        .ok()
        .and_then(|s| {
            let mut parts = s.trim().splitn(2, ':');
            let d: u64 = parts.next()?.parse().ok()?;
            let c: u32 = parts.next()?.parse().ok()?;
            Some((d, c))
        })
        .unwrap_or((0, 0));

    if stored_days == today_days && count >= MAX_DAILY_AUTO_SKILLS {
        return false;
    }
    let new_count = if stored_days == today_days {
        count + 1
    } else {
        1
    };
    let _ = std::fs::write(&marker_path, format!("{today_days}:{new_count}"));
    true
}

fn increment_daily_count() {
    // Already counted in check_daily_limit
}
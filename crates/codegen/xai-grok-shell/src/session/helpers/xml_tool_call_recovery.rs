//! Recovery of tool call arguments from XML `<tool_call>` content.
//!
//! Some models emit tool calls with empty `arguments` in the structured
//! `tool_calls` array but put the actual parameters as XML in the assistant
//! content text. This module extracts those parameters and serializes them
//! as JSON so the tool dispatch pipeline can process them normally.

use serde_json::json;

/// Extract arguments JSON for a specific tool from XML content.
///
/// Looks for `<tool_call><function={tool_name}><parameter=key>value</parameter>...`
/// in the text and converts found parameters to a JSON object string.
///
/// Returns `None` if no matching XML tool_call is found.
pub fn extract_args_for_tool(content: &str, tool_name: &str) -> Option<String> {
    let start_tag = "<tool_call>";
    let end_tag = "</tool_call>";

    let mut search_from = 0;
    while let Some(start) = content[search_from..].find(start_tag) {
        let abs_start = search_from + start;
        let remaining = &content[abs_start..];

        let block_end = remaining.find(end_tag).map(|p| p + end_tag.len()).unwrap_or(remaining.len());
        let block = &remaining[..block_end];

        if let Some(name) = extract_function_name(block) {
            if name == tool_name {
                let params = extract_parameters(block);
                if !params.is_empty() {
                    let obj: serde_json::Value = params
                        .into_iter()
                        .map(|(k, v)| (k, json!(v)))
                        .collect::<serde_json::Map<String, serde_json::Value>>()
                        .into();
                    return Some(obj.to_string());
                }
            }
        }

        search_from = abs_start + block_end;
    }
    None
}

fn extract_function_name(text: &str) -> Option<String> {
    let marker = "<function=";
    let start = text.find(marker)?;
    let after = &text[start + marker.len()..];
    let end = after.find('>')?;
    let name = after[..end].trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

fn extract_parameters(text: &str) -> Vec<(String, String)> {
    let mut params = Vec::new();
    let param_marker = "<parameter=";

    let mut search_from = 0;
    while let Some(start) = text[search_from..].find(param_marker) {
        let abs_start = search_from + start + param_marker.len();
        let remaining = &text[abs_start..];

        let Some(key_end) = remaining.find('>') else {
            break;
        };
        let key = remaining[..key_end].trim().to_string();
        let value_start = key_end + 1;

        let value_region = &remaining[value_start..];
        let end_tag = "</parameter>";
        let value = if let Some(end_pos) = value_region.find(end_tag) {
            search_from = abs_start + value_start + end_pos + end_tag.len();
            value_region[..end_pos].to_string()
        } else {
            search_from = text.len();
            value_region.to_string()
        };

        params.push((key, value));
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_args_for_matching_tool() {
        let content = r#"<tool_call>
<function=run_terminal_command>
<parameter=command>cargo check --features a2a</parameter>
<parameter=description>Run cargo check</parameter>
<parameter=timeout>120000</parameter>
</function>
</tool_call>"#;

        let result = extract_args_for_tool(content, "run_terminal_command").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["command"], "cargo check --features a2a");
        assert_eq!(parsed["description"], "Run cargo check");
        assert_eq!(parsed["timeout"], "120000");
    }

    #[test]
    fn returns_none_for_non_matching_tool() {
        let content = "<tool_call><function=read_file><parameter=file_path>/tmp/a</parameter></function></tool_call>";
        assert!(extract_args_for_tool(content, "run_terminal_command").is_none());
    }

    #[test]
    fn returns_none_for_no_xml() {
        assert!(extract_args_for_tool("just text", "run_terminal_command").is_none());
    }

    #[test]
    fn handles_text_before_tool_call() {
        let content = "Let me check.\n<tool_call><function=grep><parameter=pattern>foo</parameter></function></tool_call>";
        let result = extract_args_for_tool(content, "grep").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["pattern"], "foo");
    }
}

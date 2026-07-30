use std::collections::HashMap;

pub struct ParsedXmlToolCall {
    pub function_name: String,
    pub parameters: HashMap<String, String>,
}

const START_TAG: &str = "<tool_call>";
const END_TAG: &str = "</tool_call>";

pub fn has_tool_call_start(text: &str) -> bool {
    text.contains(START_TAG)
}

pub fn has_tool_call_end(text: &str) -> bool {
    text.contains(END_TAG)
}

/// Split text at the `<tool_call>` boundary.
/// Returns (text_before, text_from_start_tag_onwards).
/// If no start tag, returns (None, None).
pub fn split_at_start(text: &str) -> (Option<&str>, Option<&str>) {
    if let Some(pos) = text.find(START_TAG) {
        let before = if pos > 0 { Some(&text[..pos]) } else { None };
        (before, Some(&text[pos..]))
    } else {
        (None, None)
    }
}

/// Split buffered text at the `</tool_call>` boundary.
/// Returns (tool_call_content_including_end_tag, text_after_end_tag).
pub fn split_at_end(text: &str) -> (&str, Option<&str>) {
    if let Some(pos) = text.find(END_TAG) {
        let end = pos + END_TAG.len();
        let after = if end < text.len() {
            let tail = &text[end..];
            if tail.trim().is_empty() { None } else { Some(tail) }
        } else {
            None
        };
        (&text[..end], after)
    } else {
        (text, None)
    }
}

/// Parse a buffered `<tool_call>...</tool_call>` block into structured data.
pub fn parse(text: &str) -> Option<ParsedXmlToolCall> {
    let function_name = extract_function_name(text)?;
    let parameters = extract_parameters(text);
    Some(ParsedXmlToolCall {
        function_name,
        parameters,
    })
}

fn extract_function_name(text: &str) -> Option<String> {
    // Match <function=NAME> where NAME can contain word chars, hyphens, dots
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

fn extract_parameters(text: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    let param_marker = "<parameter=";

    let mut search_from = 0;
    while let Some(start) = text[search_from..].find(param_marker) {
        let abs_start = search_from + start + param_marker.len();
        let remaining = &text[abs_start..];

        // Extract key: everything up to the first '>'
        let Some(key_end) = remaining.find('>') else {
            break;
        };
        let key = remaining[..key_end].trim().to_string();
        let value_start = key_end + 1;

        // Extract value: everything up to </parameter>
        let value_region = &remaining[value_start..];
        let end_tag = "</parameter>";
        let value = if let Some(end_pos) = value_region.find(end_tag) {
            let v = &value_region[..end_pos];
            search_from = abs_start + value_start + end_pos + end_tag.len();
            v.to_string()
        } else {
            // No closing tag — take rest as value, stop parsing
            search_from = text.len();
            value_region.to_string()
        };

        params.insert(key, value);
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<tool_call> <function=run_terminal_command> <parameter=command>cd /Users/fanjia/Desktop/code/tsp && for f in scripts/grok/_run-install.sh; do echo "====="; cat "$f" 2>/dev/null || echo "(not found)"; echo; done</parameter>
  <parameter=description>Read all untracked new files for review</parameter>
  <parameter=timeout>30000</parameter>
</function>
</tool_call>"#;

    #[test]
    fn detect_start_and_end() {
        assert!(has_tool_call_start(SAMPLE));
        assert!(has_tool_call_end(SAMPLE));
        assert!(!has_tool_call_start("hello world"));
        assert!(!has_tool_call_end("hello world"));
    }

    #[test]
    fn split_at_start_works() {
        let text = "Let me check.<tool_call> <function=read_file> </function></tool_call>";
        let (before, after) = split_at_start(text);
        assert_eq!(before, Some("Let me check."));
        assert!(after.unwrap().starts_with("<tool_call>"));
    }

    #[test]
    fn split_at_start_no_prefix() {
        let (before, after) = split_at_start(SAMPLE);
        assert_eq!(before, None);
        assert!(after.is_some());
    }

    #[test]
    fn split_at_end_works() {
        let (tc, tail) = split_at_end(SAMPLE);
        assert!(tc.contains("</tool_call>"));
        assert!(tail.is_none());
    }

    #[test]
    fn split_at_end_with_tail() {
        let text = "<tool_call></tool_call>Some trailing text";
        let (tc, tail) = split_at_end(text);
        assert_eq!(tc, "<tool_call></tool_call>");
        assert_eq!(tail, Some("Some trailing text"));
    }

    #[test]
    fn parse_full_tool_call() {
        let parsed = parse(SAMPLE).unwrap();
        assert_eq!(parsed.function_name, "run_terminal_command");
        assert_eq!(parsed.parameters.get("description").unwrap(), "Read all untracked new files for review");
        assert_eq!(parsed.parameters.get("timeout").unwrap(), "30000");
        assert!(parsed.parameters.get("command").unwrap().contains("cd /Users/fanjia"));
    }

    #[test]
    fn parse_minimal() {
        let text = "<tool_call><function=read_file><parameter=file_path>/tmp/a.txt</parameter></function></tool_call>";
        let parsed = parse(text).unwrap();
        assert_eq!(parsed.function_name, "read_file");
        assert_eq!(parsed.parameters.get("file_path").unwrap(), "/tmp/a.txt");
    }

    #[test]
    fn parse_bad_xml_returns_none() {
        assert!(parse("just some text").is_none());
        assert!(parse("<tool_call>no function tag</tool_call>").is_none());
    }
}

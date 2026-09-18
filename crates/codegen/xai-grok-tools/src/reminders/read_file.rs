//! New-architecture `read_file` result reminders.

use crate::types::output::{ReadFileOutput, ToolOutput};
use crate::types::resources::SharedResources;
use crate::types::tool::Reminder;

/// Adds model-visible context for successful reads whose normal content is
/// empty. The structured `ToolOutput` remains unchanged; the registry wraps
/// these strings with the configured system-reminder tag.
#[derive(Debug, Default)]
pub struct ReadFileReminder;

#[async_trait::async_trait]
impl Reminder for ReadFileReminder {
    async fn collect_reminders(
        &self,
        _resources: SharedResources,
        tool_output: &ToolOutput,
    ) -> Vec<String> {
        let ToolOutput::ReadFile(ReadFileOutput::FileContent(file)) = tool_output else {
            return Vec::new();
        };
        if !file.content.is_empty() {
            return Vec::new();
        }
        if file.total_lines == 0 {
            return vec![
                "The file exists but has empty contents; do not treat this as a read failure."
                    .to_string(),
            ];
        }
        if file.offset.is_some_and(|offset| offset > file.total_lines) {
            return vec![format!(
                "The requested read offset is past the end of the file ({} total lines). Retry with an offset at or before {}.",
                file.total_lines, file.total_lines
            )];
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::output::FileContent;
    use crate::types::resources::Resources;

    fn output(total_lines: usize, offset: Option<usize>, content: &str) -> ToolOutput {
        ToolOutput::ReadFile(ReadFileOutput::FileContent(FileContent {
            content: content.to_string(),
            content_concise: None,
            absolute_path: "/tmp/example".into(),
            offset,
            limit: None,
            raw_output: content.to_string(),
            total_lines,
            extracted_images: Vec::new(),
        }))
    }

    #[tokio::test]
    async fn reminds_for_empty_file() {
        let got = ReadFileReminder
            .collect_reminders(Resources::default().into_shared(), &output(0, None, ""))
            .await;
        assert_eq!(got.len(), 1);
        assert!(got[0].contains("empty contents"));
    }

    #[tokio::test]
    async fn reminds_for_offset_past_end() {
        let got = ReadFileReminder
            .collect_reminders(
                Resources::default().into_shared(),
                &output(10, Some(11), ""),
            )
            .await;
        assert_eq!(got.len(), 1);
        assert!(got[0].contains("10 total lines"));
    }

    #[tokio::test]
    async fn does_not_remind_for_normal_content() {
        let got = ReadFileReminder
            .collect_reminders(
                Resources::default().into_shared(),
                &output(1, None, "1→hello"),
            )
            .await;
        assert!(got.is_empty());
    }
}

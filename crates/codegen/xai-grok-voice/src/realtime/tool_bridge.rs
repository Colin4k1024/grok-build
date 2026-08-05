//! Tool bridge for voice-mode function calling.
//!
//! When the model emits a `response.function_call_arguments.done` event the
//! [`VoiceToolBridge`] executes the requested tool locally and returns the
//! result so it can be sent back to the Realtime API.

use crate::realtime::messages::ToolDefinition;

/// Executes tool calls issued by the model during a voice conversation.
///
/// Tool results are returned as plain strings that the caller forwards back
/// to the server via a `conversation.item.create` message.
pub struct VoiceToolBridge {
    /// Registered tool definitions.
    tools: Vec<ToolDefinition>,
}

impl VoiceToolBridge {
    /// Create an empty bridge (no tools registered).
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    /// Register a tool definition.
    pub fn register_tool(&mut self, def: ToolDefinition) {
        self.tools.push(def);
    }

    /// Return all registered tool definitions (for `session.update`).
    pub fn tool_definitions(&self) -> Vec<ToolDefinition> {
        self.tools.clone()
    }

    /// Execute a tool call by name, returning the result as a string.
    ///
    /// The current implementation is a framework placeholder.  The real
    /// implementation will:
    /// 1. Look up the tool in `self.tools`.
    /// 2. Parse `arguments` as JSON.
    /// 3. Dispatch to the appropriate tool handler (e.g. the shared
    ///    `ToolBridge` / `ToolDispatch` used by the text agent).
    /// 4. Serialise the result.
    pub async fn execute(&self, name: &str, arguments: &str) -> String {
        // Verify the tool exists.
        if self.tools.iter().any(|t| t.name == name) {
            format!("Tool '{name}' executed with args: {arguments}")
        } else {
            format!("Unknown tool '{name}'")
        }
    }
}

impl Default for VoiceToolBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn register_and_list() {
        let mut bridge = VoiceToolBridge::new();
        assert!(bridge.tool_definitions().is_empty());

        bridge.register_tool(ToolDefinition {
            name: "search".into(),
            description: "Search the web".into(),
            parameters: json!({"type": "object", "properties": {"q": {"type": "string"}}}),
        });
        assert_eq!(bridge.tool_definitions().len(), 1);
        assert_eq!(bridge.tool_definitions()[0].name, "search");
    }

    #[tokio::test]
    async fn execute_known_tool() {
        let mut bridge = VoiceToolBridge::new();
        bridge.register_tool(ToolDefinition {
            name: "echo".into(),
            description: "Echo args".into(),
            parameters: json!({}),
        });
        let result = bridge.execute("echo", "{\"x\":1}").await;
        assert!(result.contains("echo"));
        assert!(result.contains("{\"x\":1}"));
    }

    #[tokio::test]
    async fn execute_unknown_tool() {
        let bridge = VoiceToolBridge::new();
        let result = bridge.execute("nope", "{}").await;
        assert!(result.contains("Unknown tool"));
    }
}

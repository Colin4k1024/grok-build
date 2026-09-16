use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpServerInfo {
    pub name: String,
    pub enabled: bool,
    pub transport_type: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env: Vec<(String, String)>,
    pub startup_timeout_sec: Option<u64>,
    pub tool_timeout_sec: Option<u64>,
}

fn config_path() -> std::path::PathBuf {
    xai_dirs::grok_home().join("config.toml")
}

#[tauri::command]
pub async fn get_mcp_servers() -> Result<Vec<McpServerInfo>, String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let doc: toml::Value = content.parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    let mut servers = Vec::new();
    if let Some(mcp) = doc.get("mcp_servers").and_then(|v| v.as_table()) {
        for (name, val) in mcp {
            let transport_type = if val.get("command").is_some() {
                "stdio"
            } else if val.get("url").is_some() {
                "http"
            } else {
                "unknown"
            }.to_string();

            let env = val.get("env")
                .and_then(|v| v.as_table())
                .map(|t| {
                    t.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();

            servers.push(McpServerInfo {
                name: name.clone(),
                enabled: val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                transport_type,
                command: val.get("command").and_then(|v| v.as_str()).map(|s| s.to_string()),
                args: val.get("args").and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
                url: val.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()),
                env,
                startup_timeout_sec: val.get("startup_timeout_sec").and_then(|v| v.as_integer()).map(|i| i as u64),
                tool_timeout_sec: val.get("tool_timeout_sec").and_then(|v| v.as_integer()).map(|i| i as u64),
            });
        }
    }
    Ok(servers)
}

#[derive(Debug, Deserialize)]
pub struct SaveMcpServerArgs {
    pub name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env: Vec<(String, String)>,
    pub enabled: Option<bool>,
    pub startup_timeout_sec: Option<u64>,
    pub tool_timeout_sec: Option<u64>,
}

#[tauri::command]
pub async fn save_mcp_server(args: SaveMcpServerArgs) -> Result<(), String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: toml::Value = content.parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    // Build the server entry
    let mut server = toml::value::Table::new();
    if let Some(cmd) = &args.command {
        server.insert("command".to_string(), toml::Value::String(cmd.clone()));
    }
    if !args.args.is_empty() {
        server.insert("args".to_string(), toml::Value::Array(
            args.args.iter().map(|s| toml::Value::String(s.clone())).collect()
        ));
    }
    if let Some(url) = &args.url {
        server.insert("url".to_string(), toml::Value::String(url.clone()));
    }
    if !args.env.is_empty() {
        let mut env = toml::value::Table::new();
        for (k, v) in &args.env {
            env.insert(k.clone(), toml::Value::String(v.clone()));
        }
        server.insert("env".to_string(), toml::Value::Table(env));
    }
    if let Some(enabled) = args.enabled {
        server.insert("enabled".to_string(), toml::Value::Boolean(enabled));
    }
    if let Some(t) = args.startup_timeout_sec {
        server.insert("startup_timeout_sec".to_string(), toml::Value::Integer(t as i64));
    }
    if let Some(t) = args.tool_timeout_sec {
        server.insert("tool_timeout_sec".to_string(), toml::Value::Integer(t as i64));
    }

    // Insert into mcp_servers table
    let mcp = doc.as_table_mut()
        .and_then(|t| t.entry("mcp_servers").or_insert(toml::Value::Table(toml::value::Table::new())).as_table_mut())
        .ok_or("Failed to access mcp_servers")?;
    mcp.insert(args.name, toml::Value::Table(server));

    let output = toml::to_string_pretty(&doc)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, output)
        .map_err(|e| format!("Failed to write config: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_mcp_server(name: String) -> Result<(), String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: toml::Value = content.parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    if let Some(mcp) = doc.as_table_mut().and_then(|t| t.get_mut("mcp_servers")).and_then(|v| v.as_table_mut()) {
        mcp.remove(&name);
    }

    let output = toml::to_string_pretty(&doc)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, output)
        .map_err(|e| format!("Failed to write config: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_mcp_server(name: String, enabled: bool) -> Result<(), String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: toml::Value = content.parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    if let Some(server) = doc.as_table_mut()
        .and_then(|t| t.get_mut("mcp_servers"))
        .and_then(|v| v.as_table_mut())
        .and_then(|t| t.get_mut(&name))
        .and_then(|v| v.as_table_mut())
    {
        server.insert("enabled".to_string(), toml::Value::Boolean(enabled));
    }

    let output = toml::to_string_pretty(&doc)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, output)
        .map_err(|e| format!("Failed to write config: {e}"))?;
    Ok(())
}

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigSnapshot {
    pub models: Vec<ModelInfo>,
    pub default_model: String,
    pub web_search_model: String,
    pub image_description_model: String,
    pub session_summary_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_backend: String,
    pub context_window: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u64>,
    #[serde(default)]
    pub env_key: Vec<String>,
    #[serde(default)]
    pub hidden: bool,
}

fn user_models_path() -> std::path::PathBuf {
    xai_dirs::grok_home().join("default_models.json")
}

fn embedded_models_json() -> &'static str {
    include_str!("../../../crates/codegen/xai-grok-models/default_models.json")
}

fn load_models_config() -> serde_json::Value {
    // Try user override first, then fall back to embedded defaults
    let user_path = user_models_path();
    if user_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&user_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                return parsed;
            }
        }
    }
    serde_json::from_str(embedded_models_json()).unwrap_or_default()
}

fn parse_config(parsed: &serde_json::Value) -> ConfigSnapshot {
    let default = parsed
        .get("default")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let web_search = parsed
        .get("web_search")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let image_description = parsed
        .get("image_description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let session_summary = parsed
        .get("session_summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let models = parsed
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m.get("model")?.as_str()?.to_string(),
                        name: m.get("name")?.as_str()?.to_string(),
                        base_url: m.get("base_url")?.as_str()?.to_string(),
                        api_backend: m
                            .get("api_backend")
                            .and_then(|v| v.as_str())
                            .unwrap_or("chat_completions")
                            .to_string(),
                        context_window: m
                            .get("context_window")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        description: m
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        max_completion_tokens: m
                            .get("max_completion_tokens")
                            .and_then(|v| v.as_u64()),
                        env_key: m
                            .get("env_key")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        hidden: m
                            .get("hidden")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    ConfigSnapshot {
        models,
        default_model: default,
        web_search_model: web_search,
        image_description_model: image_description,
        session_summary_model: session_summary,
    }
}

#[tauri::command]
pub async fn get_config() -> Result<ConfigSnapshot, String> {
    let parsed = load_models_config();
    Ok(parse_config(&parsed))
}

#[tauri::command]
pub async fn save_models(
    app: tauri::AppHandle,
    models: Vec<ModelInfo>,
    defaults: DefaultModels,
) -> Result<(), String> {
    let models_arr: Vec<serde_json::Value> = models
        .iter()
        .map(|m| {
            let mut map = serde_json::Map::new();
            map.insert("model".into(), serde_json::Value::String(m.id.clone()));
            map.insert("name".into(), serde_json::Value::String(m.name.clone()));
            map.insert("base_url".into(), serde_json::Value::String(m.base_url.clone()));
            map.insert("api_backend".into(), serde_json::Value::String(m.api_backend.clone()));
            map.insert("context_window".into(), serde_json::json!(m.context_window));
            if let Some(d) = &m.description {
                map.insert("description".into(), serde_json::Value::String(d.clone()));
            }
            if let Some(t) = m.max_completion_tokens {
                map.insert("max_completion_tokens".into(), serde_json::json!(t));
            }
            if !m.env_key.is_empty() {
                map.insert(
                    "env_key".into(),
                    serde_json::Value::Array(
                        m.env_key.iter().map(|s| serde_json::Value::String(s.clone())).collect(),
                    ),
                );
            }
            map.insert("hidden".into(), serde_json::json!(m.hidden));
            serde_json::Value::Object(map)
        })
        .collect();

    let mut root = serde_json::Map::new();
    root.insert("models".into(), serde_json::Value::Array(models_arr));
    root.insert("default".into(), serde_json::Value::String(defaults.default));
    if !defaults.web_search.is_empty() {
        root.insert("web_search".into(), serde_json::Value::String(defaults.web_search));
    }
    if !defaults.image_description.is_empty() {
        root.insert("image_description".into(), serde_json::Value::String(defaults.image_description));
    }
    if !defaults.session_summary.is_empty() {
        root.insert("session_summary".into(), serde_json::Value::String(defaults.session_summary));
    }

    let json_str = serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    let path = user_models_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    std::fs::write(&path, json_str)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    // Notify active sessions to hot-reload
    use tauri::Emitter;
    let _ = app.emit("config_changed", &serde_json::json!({}));

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct DefaultModels {
    pub default: String,
    pub web_search: String,
    pub image_description: String,
    pub session_summary: String,
}

// Keep the old save_config for backward compat
#[tauri::command]
pub async fn save_config(key: String, value: serde_json::Value) -> Result<(), String> {
    let _ = (key, value);
    Ok(())
}

#[allow(dead_code)]
fn _unused(_m: BTreeMap<String, String>) {}

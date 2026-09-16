use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub models: Vec<ModelInfo>,
    pub default_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_backend: String,
    pub context_window: u64,
}

#[tauri::command]
pub async fn get_config() -> Result<ConfigSnapshot, String> {
    let models_json = include_str!(
        "../../../crates/codegen/xai-grok-models/default_models.json"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(models_json).map_err(|e| e.to_string())?;

    let default = parsed
        .get("default")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
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
                        api_backend: m.get("api_backend")?.as_str()?.to_string(),
                        context_window: m.get("context_window")?.as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(ConfigSnapshot {
        models,
        default_model: default,
    })
}

#[tauri::command]
pub async fn save_config(
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    // Full config persistence in Phase2-11 (#27)
    let _ = (key, value);
    Ok(())
}

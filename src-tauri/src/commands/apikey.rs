use keyring::Entry;
use serde::Serialize;

const SERVICE_NAME: &str = "com.xai.grokbuild.desktop";

#[derive(Debug, Serialize)]
pub struct ApiKeyEntry {
    pub env_key: String,
    pub is_set: bool,
}

fn get_entry(env_key: &str) -> Entry {
    Entry::new(SERVICE_NAME, env_key)
        .unwrap_or_else(|_| Entry::new(SERVICE_NAME, env_key).unwrap())
}

#[tauri::command]
pub async fn save_api_key(env_key: String, value: String) -> Result<(), String> {
    let entry = get_entry(&env_key);
    entry.set_password(&value).map_err(|e| format!("Failed to save API key: {e}"))
}

#[tauri::command]
pub async fn get_api_key(env_key: String) -> Result<Option<String>, String> {
    let entry = get_entry(&env_key);
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read API key: {e}")),
    }
}

#[tauri::command]
pub async fn delete_api_key(env_key: String) -> Result<(), String> {
    let entry = get_entry(&env_key);
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete API key: {e}")),
    }
}

/// Returns whether each given env key has a stored credential.
#[tauri::command]
pub async fn list_api_keys(env_keys: Vec<String>) -> Result<Vec<ApiKeyEntry>, String> {
    let entries: Vec<ApiKeyEntry> = env_keys
        .iter()
        .map(|k| {
            let is_set = get_entry(k)
                .get_password()
                .is_ok();
            ApiKeyEntry {
                env_key: k.clone(),
                is_set,
            }
        })
        .collect();
    Ok(entries)
}

/// Reads all stored API keys and returns them as a map for env injection.
#[tauri::command]
pub async fn get_all_api_keys(env_keys: Vec<String>) -> Result<Vec<(String, String)>, String> {
    let mut result = Vec::new();
    for k in &env_keys {
        if let Ok(v) = get_entry(k).get_password() {
            if !v.is_empty() {
                result.push((k.clone(), v));
            }
        }
    }
    Ok(result)
}


/// Read stored API keys from the OS keychain and inject them into the process
/// environment so the agent can resolve them via `std::env::var`.
///
/// Keychain keys take precedence over any existing shell env var; if no
/// keychain value exists the existing env var (if any) is left untouched as
/// a fallback.
pub fn inject_stored_keys_into_env(env_keys: &[String]) {
    for key in env_keys {
        if let Ok(value) = get_entry(key).get_password() {
            if !value.is_empty() {
                // SAFETY: called from the agent thread before the agent starts
                // processing requests. No concurrent readers exist at this point.
                unsafe {
                    std::env::set_var(key, &value);
                }
            }
        }
    }
}

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct LogArgs {
    pub level: String,
    pub message: String,
}

/// Receives console messages from the frontend webview and forwards them to stderr.
#[tauri::command]
pub async fn log_frontend(args: LogArgs) -> Result<(), String> {
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    match args.level.as_str() {
        "error" => eprintln!("[{ts}] [FE ERROR] {msg}", msg = args.message),
        "warn"  => eprintln!("[{ts}] [FE WARN]  {msg}", msg = args.message),
        "info"  => eprintln!("[{ts}] [FE INFO]  {msg}", msg = args.message),
        _       => eprintln!("[{ts}] [FE LOG]   {msg}", msg = args.message),
    }
    Ok(())
}

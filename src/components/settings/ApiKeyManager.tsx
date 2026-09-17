import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/tauri";
import { getConfig, type ConfigSnapshot } from "../../lib/tauri";

interface KeyStatus {
  envKey: string;
  isSet: boolean;
}

export function ApiKeyManager() {
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [keyStatuses, setKeyStatuses] = useState<KeyStatus[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Collect unique env keys from model config
  const envKeys = Array.from(
    new Set(config?.models.flatMap((m) => m.env_key) || [])
  );

  const refreshStatuses = useCallback(async () => {
    if (envKeys.length === 0) {
      setKeyStatuses([]);
      setLoading(false);
      return;
    }
    try {
      const statuses: KeyStatus[] = await invoke("list_api_keys", { envKeys });
      setKeyStatuses(statuses);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, [envKeys]);

  useEffect(() => {
    getConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (config) refreshStatuses();
  }, [config, refreshStatuses]);

  const handleSave = useCallback(async () => {
    if (!editing) return;
    setError(null);
    try {
      await invoke("save_api_key", { envKey: editing, value: editValue });
      setEditing(null);
      setEditValue("");
      setShowValue(false);
      await refreshStatuses();
    } catch (e) {
      setError(String(e));
    }
  }, [editing, editValue, refreshStatuses]);

  const handleDelete = useCallback(async (key: string) => {
    setError(null);
    try {
      await invoke("delete_api_key", { envKey: key });
      await refreshStatuses();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshStatuses]);

  const handleEdit = useCallback(async (key: string) => {
    setEditing(key);
    setShowValue(false);
    try {
      const existing: string | null = await invoke("get_api_key", { envKey: key });
      setEditValue(existing || "");
    } catch {
      setEditValue("");
    }
  }, []);

  if (loading) return <div className="p-4 text-xs text-gb-muted">Loading...</div>;

  return (
    <div className="flex flex-col gap-4 p-4">
      {error && (
        <div className="rounded border border-gb-red/30 bg-gb-red/10 p-2 text-xs text-gb-red">
          {error}
        </div>
      )}

      <div className="rounded-xl overflow-hidden">
        <div className="border-b border-gb-border px-3 py-2">
          <h3 className="text-xs font-semibold text-gb-text">API Keys (System Keychain)</h3>
          <p className="mt-0.5 text-[10px] text-gb-muted">
            Keys are stored in your OS keychain (macOS Keychain / Windows Credential Manager).
          </p>
        </div>

        <div className="divide-y divide-gb-border">
          {envKeys.length === 0 && (
            <div className="py-4 text-center text-xs text-gb-muted">
              No API key requirements found in model configuration.
            </div>
          )}
          {envKeys.map((key) => {
            const status = keyStatuses.find((s) => s.envKey === key);
            const isSet = status?.isSet ?? false;
            return (
              <div key={key} className="flex items-center justify-between px-3 py-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${isSet ? "bg-gb-green" : "bg-gb-red"}`}
                  />
                  <div>
                    <span className="font-mono text-xs text-gb-text">{key}</span>
                    <p className="text-[10px] text-gb-muted">
                      {isSet ? "Configured" : "Not set"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    className="rounded px-2 py-1 text-[10px] text-gb-muted hover:bg-gb-bg hover:text-gb-text"
                    onClick={() => handleEdit(key)}
                  >
                    {isSet ? "Update" : "Set"}
                  </button>
                  {isSet && (
                    <button
                      className="rounded px-2 py-1 text-[10px] text-gb-red hover:bg-gb-red/10"
                      onClick={() => handleDelete(key)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditing(null)}>
          <div className="w-[420px] rounded-xl border border-gb-border bg-gb-surface-solid p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-sm font-semibold text-gb-text">
              Set API Key
            </h3>
            <label className="mb-1 block text-[10px] font-medium uppercase text-gb-muted">
              {editing}
            </label>
            <div className="flex gap-2">
              <input
                type={showValue ? "text" : "password"}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                placeholder="Enter API key..."
                className="flex-1 rounded-md border border-gb-border bg-gb-bg px-3 py-2 text-sm text-gb-text outline-none focus:border-gb-accent/50"
                autoFocus
              />
              <button
                className="rounded-md border border-gb-border px-3 py-2 text-xs text-gb-muted hover:bg-gb-bg hover:text-gb-text"
                onClick={() => setShowValue((v) => !v)}
              >
                {showValue ? "Hide" : "Show"}
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md border border-gb-border px-3 py-1.5 text-xs text-gb-muted hover:text-gb-text"
                onClick={() => { setEditing(null); setEditValue(""); }}
              >
                Cancel
              </button>
              <button
                className="bg-gb-accent rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                onClick={handleSave}
                disabled={!editValue.trim()}
              >
                Save to Keychain
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import {
  getConfig, saveModels,
  type ConfigSnapshot, type ModelInfo, type DefaultModels,
} from "../../lib/tauri";

export function ModelManager() {
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [editingModel, setEditingModel] = useState<ModelInfo | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<DefaultModels>({
    default: "", web_search: "", image_description: "", session_summary: "",
  });

  useEffect(() => {
    getConfig()
      .then((c) => {
        setConfig(c);
        setDefaults({
          default: c.default_model,
          web_search: c.web_search_model,
          image_description: c.image_description_model,
          session_summary: c.session_summary_model,
        });
      })
      .catch((e) => setError(String(e)));
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await saveModels(config.models, defaults);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, defaults]);

  const handleDelete = useCallback((id: string) => {
    if (!config) return;
    setConfig({ ...config, models: config.models.filter((m) => m.id !== id) });
  }, [config]);

  const handleSaveModel = useCallback((model: ModelInfo) => {
    if (!config) return;
    const exists = config.models.some((m) => m.id === model.id);
    const models = exists
      ? config.models.map((m) => (m.id === model.id ? model : m))
      : [...config.models, model];
    setConfig({ ...config, models });
    setEditingModel(null);
    setIsAdding(false);
  }, [config]);

  if (!config) {
    return <div className="p-4 text-xs text-gb-muted">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {error && (
        <div className="rounded border border-gb-red/30 bg-gb-red/10 p-2 text-xs text-gb-red">
          {error}
        </div>
      )}

      {/* Default models */}
      <div className="rounded-lg border border-gb-border bg-gb-surface p-3">
        <h3 className="mb-3 text-xs font-semibold text-gb-text">Default Models</h3>
        <div className="grid grid-cols-2 gap-3">
          <DefaultSelect label="Default" models={config.models} value={defaults.default}
            onChange={(v) => setDefaults({ ...defaults, default: v })} />
          <DefaultSelect label="Web Search" models={config.models} value={defaults.web_search}
            onChange={(v) => setDefaults({ ...defaults, web_search: v })} />
          <DefaultSelect label="Image Description" models={config.models} value={defaults.image_description}
            onChange={(v) => setDefaults({ ...defaults, image_description: v })} />
          <DefaultSelect label="Session Summary" models={config.models} value={defaults.session_summary}
            onChange={(v) => setDefaults({ ...defaults, session_summary: v })} />
        </div>
      </div>

      {/* Model list */}
      <div className="rounded-lg border border-gb-border bg-gb-surface">
        <div className="flex items-center justify-between border-b border-gb-border px-3 py-2">
          <h3 className="text-xs font-semibold text-gb-text">Models ({config.models.length})</h3>
          <button
            className="rounded bg-gb-accent px-2 py-1 text-[10px] font-medium text-white hover:opacity-80"
            onClick={() => setIsAdding(true)}
          >
            + Add Model
          </button>
        </div>
        <div className="divide-y divide-gb-border">
          {config.models.map((model) => (
            <div key={model.id} className="flex items-center justify-between px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gb-text">{model.name}</span>
                  {model.hidden && (
                    <span className="rounded bg-gb-yellow/20 px-1 text-[9px] text-gb-yellow">hidden</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gb-muted">
                  <span className="rounded bg-gb-bg px-1.5 py-0.5">{model.id}</span>
                  <span>{model.api_backend}</span>
                  <span>{(model.context_window / 1024).toFixed(0)}k ctx</span>
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  className="rounded px-2 py-1 text-[10px] text-gb-muted hover:bg-gb-bg hover:text-gb-text"
                  onClick={() => setEditingModel(model)}
                >
                  Edit
                </button>
                <button
                  className="rounded px-2 py-1 text-[10px] text-gb-red hover:bg-gb-red/10"
                  onClick={() => handleDelete(model.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {config.models.length === 0 && (
            <div className="py-4 text-center text-xs text-gb-muted">No models configured</div>
          )}
        </div>
      </div>

      {/* Save button */}
      <button
        className="rounded-lg bg-gb-accent px-4 py-2 text-sm font-medium text-white hover:opacity-80 disabled:opacity-40"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? "Saving..." : "Save Configuration"}
      </button>

      {/* Model editor */}
      {(editingModel || isAdding) && (
        <ModelEditor
          model={editingModel}
          onSave={handleSaveModel}
          onCancel={() => { setEditingModel(null); setIsAdding(false); }}
        />
      )}
    </div>
  );
}

function DefaultSelect({ label, models, value, onChange }: {
  label: string;
  models: ModelInfo[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase text-gb-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gb-border bg-gb-bg px-2 py-1.5 text-xs text-gb-text outline-none focus:border-gb-accent/50"
      >
        <option value="">— None —</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </label>
  );
}

function ModelEditor({ model, onSave, onCancel }: {
  model: ModelInfo | null;
  onSave: (m: ModelInfo) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ModelInfo>(
    model || {
      id: "", name: "", base_url: "", api_backend: "chat_completions",
      context_window: 131072, description: undefined, max_completion_tokens: undefined,
      env_key: [], hidden: false,
    }
  );

  const field = (key: keyof ModelInfo, value: string | number | boolean | string[] | undefined) =>
    setForm({ ...form, [key]: value });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="w-[500px] rounded-xl border border-gb-border bg-gb-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-sm font-semibold text-gb-text">
          {model ? "Edit Model" : "Add Model"}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Model ID" value={form.id} onChange={(v) => field("id", v)} placeholder="deepseek-v4-pro" />
          <FormField label="Display Name" value={form.name} onChange={(v) => field("name", v)} placeholder="DeepSeek V4 Pro" />
          <FormField label="Base URL" value={form.base_url} onChange={(v) => field("base_url", v)} placeholder="https://..." full />
          <FormField label="API Backend" value={form.api_backend} onChange={(v) => field("api_backend", v)} placeholder="chat_completions" />
          <FormField label="Context Window" value={String(form.context_window)} onChange={(v) => field("context_window", parseInt(v) || 0)} type="number" />
          <FormField label="Max Completion Tokens" value={form.max_completion_tokens ? String(form.max_completion_tokens) : ""} onChange={(v) => field("max_completion_tokens", parseInt(v) || undefined)} type="number" />
          <FormField label="Env Keys (comma-separated)" value={form.env_key.join(", ")} onChange={(v) => field("env_key", v.split(",").map((s) => s.trim()).filter(Boolean))} full />
          <FormField label="Description" value={form.description || ""} onChange={(v) => field("description", v || undefined)} full />
          <label className="flex items-center gap-2 text-xs text-gb-muted">
            <input type="checkbox" checked={form.hidden} onChange={(e) => field("hidden", e.target.checked)} />
            Hidden
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-lg border border-gb-border px-3 py-1.5 text-xs text-gb-muted hover:bg-gb-bg" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rounded-lg bg-gb-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-80 disabled:opacity-40"
            onClick={() => form.id && form.name && onSave(form)}
            disabled={!form.id || !form.name}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, value, onChange, placeholder, type = "text", full }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  full?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-[10px] font-medium uppercase text-gb-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-gb-border bg-gb-bg px-2 py-1.5 text-xs text-gb-text outline-none focus:border-gb-accent/50"
      />
    </label>
  );
}

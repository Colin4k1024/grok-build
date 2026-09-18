import { useState, useEffect, useCallback, useMemo } from "react";
import {
  getConfig, saveModels,
  type ConfigSnapshot, type ModelInfo, type DefaultModels,
} from "../../lib/tauri";

/** Infer a vendor bucket from the model's backend / base_url / id. */
function vendorOf(model: ModelInfo): string {
  const hay = `${model.api_backend} ${(model as { base_url?: string }).base_url ?? ""} ${model.id}`.toLowerCase();
  if (hay.includes("openai") || hay.includes("gpt")) return "OpenAI";
  if (hay.includes("anthropic") || hay.includes("claude")) return "Anthropic";
  if (hay.includes("dashscope") || hay.includes("qwen") || hay.includes("aliyun")) return "Alibaba";
  if (hay.includes("grok") || hay.includes("xai") || hay.includes("x.ai")) return "xAI";
  if (hay.includes("deepseek")) return "DeepSeek";
  if (hay.includes("ollama") || hay.includes("localhost") || hay.includes("127.0.0.1")) return "Local";
  if (hay.includes("google") || hay.includes("gemini")) return "Google";
  if (hay.includes("mistral")) return "Mistral";
  return "Other";
}

const VENDOR_ICONS: Record<string, string> = {
  OpenAI: "🤖",
  Anthropic: "🧠",
  Alibaba: "☁️",
  xAI: "𝕏",
  DeepSeek: "🔍",
  Local: "💻",
  Google: "🌐",
  Mistral: "🌬️",
  Other: "📦",
};

interface TestResult {
  ok: boolean;
  message: string;
}

/** Lightweight connectivity check — we only verify that the endpoint is
 *  reachable; actually calling the model would require a paid API request. */
async function testModelConnection(model: ModelInfo): Promise<TestResult> {
  const url = (model as { base_url?: string }).base_url;
  if (!url) return { ok: false, message: "No base_url configured" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    // HEAD keeps the payload tiny; some providers don't allow it so fall back
    // to GET on 405.
    let res = await fetch(url, { method: "HEAD", signal: controller.signal }).catch(() => null);
    if (res && res.status === 405) {
      res = await fetch(url, { method: "GET", signal: controller.signal }).catch(() => null);
    }
    clearTimeout(timer);
    if (!res) return { ok: false, message: "Unreachable" };
    if (res.status >= 500) return { ok: false, message: `Server error ${res.status}` };
    return { ok: true, message: `Reachable (${res.status})` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function ModelManager() {
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [editingModel, setEditingModel] = useState<ModelInfo | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<DefaultModels>({
    default: "", web_search: "", image_description: "", session_summary: "",
  });

  const [testResults, setTestResults] = useState<Record<string, TestResult | "testing">>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const groupedModels = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of config?.models ?? []) {
      const vendor = vendorOf(m);
      if (!map.has(vendor)) map.set(vendor, []);
      map.get(vendor)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [config?.models]);

  const handleTestConnection = useCallback(async (model: ModelInfo) => {
    setTestResults((prev) => ({ ...prev, [model.id]: "testing" }));
    const result = await testModelConnection(model);
    setTestResults((prev) => ({ ...prev, [model.id]: result }));
  }, []);

  const handleExport = useCallback(() => {
    if (!config) return;
    const blob = new Blob([JSON.stringify({ models: config.models, defaults }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `grok-build-models-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [config, defaults]);

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !config) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as {
          models?: ModelInfo[];
          defaults?: DefaultModels;
        };
        if (parsed.models) setConfig({ ...config, models: parsed.models });
        if (parsed.defaults) setDefaults(parsed.defaults);
        setError(null);
      } catch (err) {
        setError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [config]);

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
    return <div className="p-4 text-xs text-gb-muted">加载中…</div>;
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
        <h3 className="mb-3 text-xs font-semibold text-gb-text">默认模型</h3>
        <div className="grid grid-cols-2 gap-3">
          <DefaultSelect label="默认" models={config.models} value={defaults.default}
            onChange={(v) => setDefaults({ ...defaults, default: v })} />
          <DefaultSelect label="网页搜索" models={config.models} value={defaults.web_search}
            onChange={(v) => setDefaults({ ...defaults, web_search: v })} />
          <DefaultSelect label="图像描述" models={config.models} value={defaults.image_description}
            onChange={(v) => setDefaults({ ...defaults, image_description: v })} />
          <DefaultSelect label="会话摘要" models={config.models} value={defaults.session_summary}
            onChange={(v) => setDefaults({ ...defaults, session_summary: v })} />
        </div>
      </div>

      {/* Model list — grouped by vendor */}
      <div className="rounded-lg border border-gb-border bg-gb-surface">
        <div className="flex items-center justify-between border-b border-gb-border px-3 py-2">
          <h3 className="text-xs font-semibold text-gb-text">Models ({config.models.length})</h3>
          <div className="flex gap-1">
            <button
              className="rounded border border-gb-border/20 px-2 py-1 text-[10px] text-gb-muted hover:text-gb-text"
              onClick={handleExport}
              title="导出模型为 JSON"
            >
              Export
            </button>
            <label className="cursor-pointer rounded border border-gb-border/20 px-2 py-1 text-[10px] text-gb-muted hover:text-gb-text">
              Import
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImport}
              />
            </label>
            <button
              className="rounded bg-gb-accent px-2 py-1 text-[10px] font-medium text-gb-bg hover:opacity-80"
              onClick={() => setIsAdding(true)}
            >
              + Add Model
            </button>
          </div>
        </div>
        <div>
          {groupedModels.map(([vendor, models]) => {
            const collapsed = collapsedGroups.has(vendor);
            return (
              <div key={vendor} className="border-b border-gb-border/10 last:border-b-0">
                <button
                  onClick={() =>
                    setCollapsedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(vendor)) next.delete(vendor);
                      else next.add(vendor);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium uppercase text-gb-muted hover:text-gb-text"
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="currentColor"
                    className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                  >
                    <path d="M2 1l4 3-4 3V1z" />
                  </svg>
                  <span className="text-sm">{VENDOR_ICONS[vendor] ?? VENDOR_ICONS.Other}</span>
                  <span>{vendor}</span>
                  <span className="ml-auto rounded bg-gb-bg px-1.5 py-0.5 text-[9px]">{models.length}</span>
                </button>
                {!collapsed &&
                  models.map((model) => {
                    const test = testResults[model.id];
                    return (
                      <div key={model.id} className="flex items-center justify-between border-t border-gb-border/5 px-3 py-2 pl-8">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gb-text">{model.name}</span>
                            {model.hidden && (
                              <span className="rounded bg-gb-yellow/20 px-1 text-[9px] text-gb-yellow">已隐藏</span>
                            )}
                            {test === "testing" && (
                              <span className="text-[10px] text-gb-muted">测试中…</span>
                            )}
                            {test && test !== "testing" && (
                              <span
                                className={`text-[10px] ${test.ok ? "text-gb-green" : "text-gb-red"}`}
                                title={test.message}
                              >
                                {test.ok ? "✓ reachable" : "✗ failed"}
                              </span>
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
                            onClick={() => handleTestConnection(model)}
                            disabled={test === "testing"}
                          >
                            Test
                          </button>
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
                    );
                  })}
              </div>
            );
          })}
          {config.models.length === 0 && (
            <div className="py-4 text-center text-xs text-gb-muted">尚未配置模型</div>
          )}
        </div>
      </div>

      {/* Save button */}
      <button
        className="rounded-lg bg-gb-accent px-4 py-2 text-sm font-medium text-gb-bg hover:opacity-80 disabled:opacity-40"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? "保存中…" : "保存配置"}
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
        <option value="">— 无 —</option>
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
          {model ? "编辑模型" : "添加模型"}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="模型 ID" value={form.id} onChange={(v) => field("id", v)} placeholder="deepseek-v4-pro" />
          <FormField label="显示名称" value={form.name} onChange={(v) => field("name", v)} placeholder="DeepSeek V4 Pro" />
          <FormField label="Base URL" value={form.base_url} onChange={(v) => field("base_url", v)} placeholder="https://..." full />
          <FormField label="API 后端" value={form.api_backend} onChange={(v) => field("api_backend", v)} placeholder="chat_completions" />
          <FormField label="上下文窗口" value={String(form.context_window)} onChange={(v) => field("context_window", parseInt(v) || 0)} type="number" />
          <FormField label="最大输出 Tokens" value={form.max_completion_tokens ? String(form.max_completion_tokens) : ""} onChange={(v) => field("max_completion_tokens", parseInt(v) || undefined)} type="number" />
          <FormField label="环境变量名（逗号分隔）" value={form.env_key.join(", ")} onChange={(v) => field("env_key", v.split(",").map((s) => s.trim()).filter(Boolean))} full />
          <FormField label="描述" value={form.description || ""} onChange={(v) => field("description", v || undefined)} full />
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
            className="rounded-lg bg-gb-accent px-3 py-1.5 text-xs font-medium text-gb-bg hover:opacity-80 disabled:opacity-40"
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

import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { listSettings, searchSettings, getSetting, listCategories } from "../config/registry";
import {
  applyPreset,
  resolveFromStore,
  resetScopedValue,
  setScopedValue,
} from "../config/storeBridge";
import { restoreSettings, snapshotSettings } from "../config/transfer";
import { toast } from "../components/ui";
import { setUnsavedGuard } from "../lib/unsavedGuard";
import { SettingsLayout, type SettingsCategory } from "../components/settings/SettingsLayout";
import { SettingsToolbar } from "../components/settings/SettingsToolbar";
import { SettingsField } from "../components/settings/SettingsField";
import { SettingsChangeBar } from "../components/settings/SettingsChangeBar";
import { SettingsTransferDialog } from "../components/settings/SettingsTransferDialog";
import { ModelManager } from "../components/settings/ModelManager";
import { ApiKeyManager } from "../components/settings/ApiKeyManager";
import { McpManager } from "../components/settings/McpManager";
import { PluginManager } from "../components/settings/PluginManager";
import { WorktreeManager } from "../components/settings/WorktreeManager";
import { GeneralSettings } from "../components/settings/GeneralSettings";
import { PermissionsManager } from "../components/settings/PermissionsManager";
import { TrustedFoldersManager } from "../components/settings/TrustedFoldersManager";
import { BrowserSettings } from "../components/settings/BrowserSettings";

/**
 * Settings Center (R4-07 #240): grouped navigation + search + scope switch
 * + source badges + staged change bar + presets + import/export. Registry
 * schema is the single source of defaults/metadata; complex IPC-backed
 * sections keep their managers (migrated in #241).
 */

type SectionKind = "registry" | "custom";
interface Section extends SettingsCategory {
  kind: SectionKind;
  /** registry category rendered as fields (kind === "registry"). */
  registryCategory?: string;
  /** search keywords (so custom/manager sections stay findable). */
  keywords?: string[];
  /** extra custom content rendered below the registry fields. */
  extra?: () => React.ReactNode;
  component?: () => React.ReactNode;
}

const SECTIONS: Section[] = [
  { id: "general", label: "常规", group: "工作区", kind: "custom", keywords: ["general", "startup", "autostart", "update", "更新", "启动", "tray"], component: () => <GeneralSettings /> },
  { id: "worktrees", label: "工作树", group: "工作区", kind: "custom", keywords: ["worktree", "工作树", "分支"], component: () => <WorktreeManager /> },
  { id: "models", label: "模型", group: "AI", kind: "custom", keywords: ["model", "模型", "api"], component: () => <ModelManager /> },
  { id: "agent", label: "代理", group: "AI", kind: "registry", registryCategory: "agent", keywords: ["agent", "代理", "autonomous", "自治"] },
  { id: "voice", label: "语音", group: "AI", kind: "registry", registryCategory: "voice", keywords: ["voice", "语音", "stt", "tts", "播报"] },
  { id: "apikeys", label: "API Keys", group: "集成", kind: "custom", keywords: ["api", "key", "密钥", "token"], component: () => <ApiKeyManager /> },
  { id: "mcp", label: "MCP", group: "集成", kind: "custom", keywords: ["mcp", "server", "服务器"], component: () => <McpManager /> },
  { id: "plugins", label: "插件", group: "集成", kind: "custom", keywords: ["plugin", "插件", "扩展"], component: () => <PluginManager /> },
  { id: "browser", label: "浏览器", group: "集成", kind: "custom", keywords: ["browser", "浏览器", "playwright", "puppeteer"], component: () => <BrowserSettings /> },
  { id: "appearance", label: "外观", group: "体验", kind: "registry", registryCategory: "appearance", keywords: ["appearance", "外观", "主题", "theme"] },
  { id: "notifications", label: "通知", group: "体验", kind: "registry", registryCategory: "notifications", keywords: ["notification", "通知", "提醒"] },
  {
    id: "permissions",
    label: "权限",
    group: "安全",
    kind: "registry",
    registryCategory: "permissions",
    extra: () => <PermissionsManager />,
  },
  {
    id: "trusted",
    label: "受信任目录",
    group: "安全",
    kind: "registry",
    registryCategory: "general",
    extra: () => <TrustedFoldersManager />,
  },
  {
    id: "about", label: "关于", group: "系统", kind: "custom",
    component: () => (
      <div className="p-1">
        <h3 className="mb-2 text-gb-md font-medium">Grok Build</h3>
        <p className="text-gb-xs text-gb-text-muted">Version 0.1.0</p>
      </div>
    ),
  },
];

const DEFAULT_SECTION = "models";

export function Settings({ initialTab }: { initialTab?: string }) {
  const [section, setSection] = useState<string>(
    initialTab && SECTIONS.some((s) => s.id === initialTab) ? initialTab : DEFAULT_SECTION,
  );
  const [query, setQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<"import" | "export">("export");

  // Drafts keyed by `${scope}:${settingId}`. A project-scope draft also
  // records the projectId it was staged under, so applying it always writes
  // to the project the user actually edited — never to whatever project is
  // active at apply time (the active session can change while settings is
  // open). The change bar counts/applies/discards ALL drafts so a project
  // draft is never left orphaned and unreachable when the project context
  // changes (e.g. the active tab is closed).
  const [drafts, setDrafts] = useState<Record<string, { value: unknown; projectId?: string }>>({});
  /** Per-field apply errors, keyed the same way (shown ON the field). */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeSessionId));
  const projectId = activeTab?.cwd;
  const projectName = projectId?.replace(/[/\\]+$/, "").split(/[/\\]/).pop();

  // honor deep-link changes while open
  useEffect(() => {
    if (initialTab && SECTIONS.some((s) => s.id === initialTab)) setSection(initialTab);
  }, [initialTab]);

  // If the project context disappears while in project scope, fall back to
  // global — never let the scope switch point at nothing.
  useEffect(() => {
    if (scope === "project" && !projectId) setScope("global");
  }, [scope, projectId]);

  // Draft keys carry scope AND project so a draft staged on project A never
  // displays on project B's field; the draft VALUE also binds its project
  // (applied to its own context even if the active project changes).
  const draftKey = (id: string) => `${scope}:${projectId ?? ""}:${id}`;
  const draftCount = Object.keys(drafts).length;

  // Unsaved-changes guard for navigation away from settings.
  useEffect(() => {
    if (draftCount === 0) return;
    return setUnsavedGuard(() => (draftCount > 0 ? `设置有 ${draftCount} 项未保存的修改` : null));
  }, [draftCount]);

  const visibleDefs = useMemo(() => {
    const all = query.trim() ? searchSettings(query) : listSettings();
    return advanced ? all : all.filter((d) => !d.advanced);
  }, [query, advanced]);

  const searching = query.trim().length > 0;
  // Search covers registry settings AND custom/manager sections.
  const matchingSections = useMemo(() => {
    if (!searching) return [];
    const q = query.trim().toLowerCase();
    return SECTIONS.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        (s.keywords ?? []).some((k) => k.toLowerCase().includes(q)),
    );
  }, [query, searching]);

  const matchCount = searching ? visibleDefs.length + matchingSections.length : 0;

  const onFieldChange = (settingId: string, value: unknown) => {
    const def = getSetting(settingId);
    if (!def) return;
    if (def.saveMode === "immediate") {
      try {
        setScopedValue(settingId, value, scope, projectId);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } else {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[draftKey(settingId)];
        return next;
      });
      setDrafts((prev) => ({
        ...prev,
        // Bind a project draft to the project it was staged under so apply
        // never targets a different active project.
        [draftKey(settingId)]: { value, projectId: scope === "project" ? projectId : undefined },
      }));
    }
  };

  const onFieldReset = (settingId: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[draftKey(settingId)];
      return next;
    });
    try {
      const before = snapshotSettings();
      if (scope === "project") {
        // Never nuke the global layer from a project view with no project.
        if (!projectId) {
          toast.error("没有活跃项目 — 无法重置项目覆盖");
          return;
        }
        resetScopedValue(settingId, projectId);
      } else {
        const def = getSetting(settingId)!;
        setScopedValue(settingId, def.defaultValue, "global");
      }
      const label = getSetting(settingId)?.label ?? settingId;
      toast.success(`已重置「${label}」`, {
        action: { label: "撤销", onClick: () => restoreSettings(before) },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const applyDrafts = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 0)); // let the saving state paint
    const before = snapshotSettings();
    const errors: Record<string, string> = {};
    const keep: Record<string, { value: unknown; projectId?: string }> = {};
    // Apply ALL drafts (both scopes), each to the project it was staged under.
    // This never writes a project draft to the wrong active project, and a
    // project draft orphaned by a project-context change stays reachable
    // here instead of nagging via the leave guard with no remedy.
    for (const [key, entry] of Object.entries(drafts)) {
      // key = `${scope}:${projectId}:${settingId}`; the VALUE also binds the
      // project — apply uses the draft's own context, never the live one.
      const settingId = key.split(":").pop()!;
      const draftScope = key.split(":")[0] as "global" | "project";
      const value = entry.value;
      try {
        setScopedValue(settingId, value, draftScope, entry.projectId);
      } catch (e) {
        errors[key] = e instanceof Error ? e.message : String(e);
        keep[key] = entry; // failed drafts stay editable AND located
      }
    }
    setSaving(false);
    setDrafts(keep);
    setFieldErrors(errors);
    const failCount = Object.keys(errors).length;
    if (failCount === 0) {
      toast.success("设置已保存", {
        action: { label: "撤销", onClick: () => restoreSettings(before) },
      });
    } else {
      toast.error(`${failCount} 项保存失败 — 其余已应用`, {
        action: { label: "全部撤销", onClick: () => restoreSettings(before) },
      });
    }
  };

  const discardDrafts = () => {
    // Discard ALL drafts (both scopes), so orphaned project drafts are
    // reachable from the change bar's 放弃 even when the project context
    // that staged them is no longer active.
    setDrafts({});
    setFieldErrors({});
  };

  /** Save the current scope's non-default values as a user preset.
   *  Collision-safe id generation (pinyin/CJK-safe). */
  const onSavePreset = (label: string) => {
    try {
      const values: Record<string, unknown> = {};
      for (const def of listSettings()) {
        if (def.sensitive) continue;
        // Only capture settings that can be APPLIED at the current scope, so
        // a project-scope preset never carries global-only entries that would
        // fail with scope_not_allowed on every apply.
        if (!def.scopes.includes(scope as never)) continue;
        const r = resolveFromStore(def.id, scope === "project" ? projectId : undefined);
        if (r.overridden) values[def.id] = r.value;
      }
      const existing = useSettingsStore.getState().userPresets;
      let id = label
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!id) id = "preset";
      if (Object.prototype.hasOwnProperty.call(existing, id)) {
        let n = 2;
        while (Object.prototype.hasOwnProperty.call(existing, `${id}-${n}`)) n += 1;
        id = `${id}-${n}`;
      }
      useSettingsStore.getState().saveUserPreset(id, label, values);
      toast.success(`预设「${label}」已保存（${Object.keys(values).length} 项）`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeletePreset = (presetId: string) => {
    if (!window.confirm("删除该预设？已应用的设置不受影响。")) return;
    try {
      useSettingsStore.getState().deleteUserPreset(presetId);
      toast.success("预设已删除");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  /** Layered reset: project scope resets only project overrides; global
   *  scope resets all global values to registry defaults (undoable). */
  const onResetScope = () => {
    if (scope === "project" && projectId) {
      if (!window.confirm("重置当前项目的全部设置覆盖？仅影响本项目，全局值不变。")) return;
      const before = snapshotSettings();
      resetScopedValue(null, projectId);
      toast.success("已重置当前项目的全部覆盖", {
        action: { label: "撤销", onClick: () => restoreSettings(before) },
      });
      return;
    }
    if (scope === "project" && !projectId) {
      toast.error("没有活跃项目 — 无法重置项目覆盖");
      return;
    }
    if (window.confirm("将全部全局设置重置为默认？未保存的修改保留在变更栏中；此操作可用撤销恢复。")) {
      const before = snapshotSettings();
      for (const def of listSettings()) {
        if (def.storeKey) {
          try {
            setScopedValue(def.id, def.defaultValue, "global");
          } catch {
            /* validated defaults never throw */
          }
        }
      }
      // Staged drafts are PRESERVED (they are the user's pending intent) —
      // undo restores values; the change bar keeps its drafts.
      toast.success("已重置全部全局设置", {
        action: { label: "撤销", onClick: () => restoreSettings(before) },
      });
    }
  };

  const onApplyPreset = (presetId: string) => {
    try {
      const before = snapshotSettings();
      const r = applyPreset(presetId, scope, projectId);
      if (r.failed.length > 0) {
        toast.error(`预设部分应用失败：${r.failed[0]}`, {
          action: { label: "撤销", onClick: () => restoreSettings(before) },
        });
      } else if (r.applied.length === 0) {
        toast.success("预设与当前设置一致");
      } else {
        toast.success(`预设已应用（${r.applied.length} 项）`, {
          action: { label: "撤销", onClick: () => restoreSettings(before) },
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- content ------------------------------------------------------------
  const renderField = (id: string) => {
    const def = getSetting(id);
    if (!def) return null;
    const key = draftKey(id);
    return (
      <SettingsField
        key={id}
        settingId={id}
        scope={scope}
        projectId={projectId}
        draft={drafts[key]?.value}
        error={fieldErrors[key]}
        onChange={onFieldChange}
        onReset={onFieldReset}
      />
    );
  };

  const activeSection = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  let content: React.ReactNode;
  if (searching) {
    content =
      visibleDefs.length === 0 && matchingSections.length === 0 ? (
        <p className="py-8 text-center text-gb-xs text-gb-text-muted">没有匹配 “{query}” 的设置</p>
      ) : (
        <div>
          {visibleDefs.length > 0 && (
            <div>
              <p className="mb-2 text-gb-xs text-gb-text-muted">设置项（{visibleDefs.length}）</p>
              {visibleDefs.map((d) => renderField(d.id))}
            </div>
          )}
          {matchingSections.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-gb-xs text-gb-text-muted">分区（{matchingSections.length}）</p>
              <div className="space-y-1">
                {matchingSections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSection(s.id);
                      setQuery("");
                    }}
                    className="flex w-full items-center justify-between rounded-gb-md border gb-border-hairline bg-gb-surface-1 px-3 py-2 text-left text-gb-sm text-gb-text-primary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover"
                  >
                    <span>{s.label}</span>
                    <span className="text-gb-xs text-gb-text-muted">{s.group} →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
  } else if (activeSection.kind === "registry") {
    const defs = listCategories()
      .find((c) => c.category === activeSection.registryCategory)
      ?.settings.filter((d) => advanced || !d.advanced);
    content = (
      <div>
        {defs?.map((d) => renderField(d.id))}
        {activeSection.extra && <div className="mt-4">{activeSection.extra()}</div>}
      </div>
    );
  } else {
    content = activeSection.component?.();
  }

  return (
    <>
      <SettingsLayout
        categories={SECTIONS}
        active={searching ? "" : activeSection.id}
        onSelect={(id) => {
          setSection(id);
          setQuery("");
        }}
        toolbar={
          <SettingsToolbar
            query={query}
            onQuery={setQuery}
            matchCount={matchCount}
            advanced={advanced}
            onToggleAdvanced={() => setAdvanced((v) => !v)}
            scope={scope}
            onScopeChange={setScope}
            projectName={projectName}
            onApplyPreset={onApplyPreset}
            onImport={() => {
              setTransferMode("import");
              setTransferOpen(true);
            }}
            onExport={() => {
              setTransferMode("export");
              setTransferOpen(true);
            }}
            onResetScope={onResetScope}
            onSavePreset={onSavePreset}
            onDeletePreset={onDeletePreset}
          />
        }
        changeBar={
          <SettingsChangeBar
            count={draftCount}
            saving={saving}
            failures={Object.values(fieldErrors)}
            onApply={applyDrafts}
            onDiscard={discardDrafts}
          />
        }
      >
        {content}
      </SettingsLayout>
      <SettingsTransferDialog
        open={transferOpen}
        mode={transferMode}
        onClose={() => setTransferOpen(false)}
      />
    </>
  );
}

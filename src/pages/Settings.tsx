import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { listSettings, searchSettings, getSetting, listCategories } from "../config/registry";
import {
  applyPreset,
  resetScopedValue,
  setScopedValue,
} from "../config/storeBridge";
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
  /** extra custom content rendered below the registry fields. */
  extra?: () => React.ReactNode;
  component?: () => React.ReactNode;
}

const SECTIONS: Section[] = [
  { id: "general", label: "常规", group: "工作区", kind: "custom", component: () => <GeneralSettings /> },
  { id: "worktrees", label: "工作树", group: "工作区", kind: "custom", component: () => <WorktreeManager /> },
  { id: "models", label: "模型", group: "AI", kind: "custom", component: () => <ModelManager /> },
  { id: "agent", label: "代理", group: "AI", kind: "registry", registryCategory: "agent" },
  { id: "voice", label: "语音", group: "AI", kind: "registry", registryCategory: "voice" },
  { id: "apikeys", label: "API Keys", group: "集成", kind: "custom", component: () => <ApiKeyManager /> },
  { id: "mcp", label: "MCP", group: "集成", kind: "custom", component: () => <McpManager /> },
  { id: "plugins", label: "插件", group: "集成", kind: "custom", component: () => <PluginManager /> },
  { id: "browser", label: "浏览器", group: "集成", kind: "custom", component: () => <BrowserSettings /> },
  { id: "appearance", label: "外观", group: "体验", kind: "registry", registryCategory: "appearance" },
  { id: "notifications", label: "通知", group: "体验", kind: "registry", registryCategory: "notifications" },
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

const DEFAULT_SECTION = "appearance";

export function Settings({ initialTab }: { initialTab?: string }) {
  const [section, setSection] = useState<string>(
    initialTab && SECTIONS.some((s) => s.id === initialTab) ? initialTab : DEFAULT_SECTION,
  );
  const [query, setQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [transferOpen, setTransferOpen] = useState(false);

  // Drafts keyed by `${scope}:${settingId}` — staged (high-impact) edits.
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [failures, setFailures] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeSessionId));
  const projectId = activeTab?.cwd;
  const projectName = projectId?.replace(/[/\\]+$/, "").split(/[/\\]/).pop();

  // honor deep-link changes while open
  useEffect(() => {
    if (initialTab && SECTIONS.some((s) => s.id === initialTab)) setSection(initialTab);
  }, [initialTab]);

  const draftKey = (id: string) => `${scope}:${id}`;
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

  const matchCount = query.trim() ? visibleDefs.length : 0;

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
      setFailures([]);
      setDrafts((prev) => ({ ...prev, [draftKey(settingId)]: value }));
    }
  };

  const onFieldReset = (settingId: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[draftKey(settingId)];
      return next;
    });
    try {
      if (scope === "project" && projectId) resetScopedValue(settingId, projectId);
      else {
        const def = getSetting(settingId)!;
        setScopedValue(settingId, def.defaultValue, "global");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const applyDrafts = async () => {
    setSaving(true);
    const failed: string[] = [];
    const keep: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(drafts)) {
      const [draftScope, settingId] = key.split(":", 2) as ["global" | "project", string];
      try {
        setScopedValue(settingId, value, draftScope, projectId);
      } catch (e) {
        failed.push(`${settingId}: ${e instanceof Error ? e.message : String(e)}`);
        keep[key] = value; // failed drafts stay editable
      }
    }
    setSaving(false);
    setFailures(failed);
    setDrafts(keep);
    if (failed.length === 0) toast.success("设置已保存");
    else toast.error(`${failed.length} 项保存失败 — 其余已应用`);
  };

  const discardDrafts = () => {
    setDrafts({});
    setFailures([]);
  };

  const onApplyPreset = (presetId: string) => {
    try {
      const r = applyPreset(presetId, scope, projectId);
      if (r.failed.length > 0) toast.error(`预设部分应用失败：${r.failed[0]}`);
      else if (r.applied.length === 0) toast.success("预设与当前设置一致");
      else toast.success(`预设已应用（${r.applied.length} 项）`);
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
        draft={key in drafts ? drafts[key] : undefined}
        onChange={onFieldChange}
        onReset={onFieldReset}
      />
    );
  };

  const activeSection = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const searching = query.trim().length > 0;

  let content: React.ReactNode;
  if (searching) {
    content = visibleDefs.length === 0 ? (
      <p className="py-8 text-center text-gb-xs text-gb-text-muted">没有匹配 “{query}” 的设置</p>
    ) : (
      <div>
        <p className="mb-2 text-gb-xs text-gb-text-muted">搜索结果（{visibleDefs.length}）</p>
        {visibleDefs.map((d) => renderField(d.id))}
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
            onImport={() => setTransferOpen(true)}
            onExport={() => setTransferOpen(true)}
          />
        }
        changeBar={
          <SettingsChangeBar
            count={draftCount}
            saving={saving}
            failures={failures}
            onApply={applyDrafts}
            onDiscard={discardDrafts}
          />
        }
      >
        {content}
      </SettingsLayout>
      <SettingsTransferDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        projectId={projectId}
      />
    </>
  );
}

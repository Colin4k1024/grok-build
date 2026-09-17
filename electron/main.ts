import { app, BrowserWindow, shell, ipcMain, Notification, clipboard, dialog } from "electron";
import { AcpSession, saveApiKey, getApiKey, deleteApiKey, isApiKeySet } from "./acp-session";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const isDev = process.env.NODE_ENV === "development" || !!process.env.VITE_DEV_SERVER_URL;
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

let mainWindow: BrowserWindow | null = null;

// --- IPC handlers (ported from src-tauri/src/commands/*) ---
// Stage 1: minimal viable set so the frontend can boot without crashing.
// ACP agent wiring lands in stage 1c.

interface SessionRecord {
  id: string;
  cwd: string;
  acp_session_id: string;
  models: { id: string; name: string }[];
  currentModel?: string;
  createdAt: number;
  agent?: AcpSession;
}

const sessions = new Map<string, SessionRecord>();

// --- IPC helpers ---
function ok<T>(data: T) {
  return data;
}

// Global error log for every IPC invoke — essential during migration.
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown) => {
  origHandle(channel, async (...args: unknown[]) => {
    try {
      const result = await listener(...args);
      return result;
    } catch (err) {
      console.error(`[IPC ERROR] ${channel}:`, err);
      throw err;
    }
  });
}) as typeof ipcMain.handle;

ipcMain.handle("check_auth_status", () =>
  ok({ authenticated: true, username: "dev" })
);

ipcMain.handle("login", () => ok({ authenticated: true, username: "dev" }));
ipcMain.handle("logout", () => ok(null));

// --- Model config persistence (ported from src-tauri/src/commands/config.rs) ---
// Config lives at ~/.grok/default_models.json (same path the Rust side uses)
// so the ACP agent process can read it.
const GROK_HOME = path.join(os.homedir(), ".grok");
const MODELS_PATH = path.join(GROK_HOME, "default_models.json");

interface ModelInfoInput {
  id: string;
  name: string;
  base_url: string;
  api_backend: string;
  context_window: number;
  description?: string;
  max_completion_tokens?: number;
  env_key: string[];
  hidden: boolean;
}

interface ModelDefaultsInput {
  default: string;
  web_search: string;
  image_description: string;
  session_summary: string;
}

const DEFAULT_MODELS_DOC = {
  models: [
    {
      model: "grok-4-fast",
      name: "Grok 4 Fast",
      base_url: "https://api.x.ai/v1",
      api_backend: "openai",
      context_window: 128000,
      env_key: ["XAI_API_KEY"],
      hidden: false,
    },
  ],
  default: "grok-4-fast",
  web_search: "grok-4-fast",
  image_description: "grok-4-fast",
  session_summary: "grok-4-fast",
};

function readModelsDoc(): typeof DEFAULT_MODELS_DOC {
  try {
    if (fs.existsSync(MODELS_PATH)) {
      const raw = fs.readFileSync(MODELS_PATH, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("[config] failed to read models:", e);
  }
  return DEFAULT_MODELS_DOC;
}

function toConfigSnapshot(doc: typeof DEFAULT_MODELS_DOC) {
  return {
    models: doc.models.map((m) => ({
      id: (m as { model?: string }).model ?? "",
      name: m.name,
      base_url: m.base_url,
      api_backend: m.api_backend,
      context_window: m.context_window,
      env_key: m.env_key ?? [],
      hidden: m.hidden ?? false,
    })),
    default_model: doc.default || "",
    web_search_model: doc.web_search || "",
    image_description_model: doc.image_description || "",
    session_summary_model: doc.session_summary || "",
  };
}

ipcMain.handle("get_config", () => ok(toConfigSnapshot(readModelsDoc())));

ipcMain.handle("save_models", (_e, args: { models: ModelInfoInput[]; defaults: ModelDefaultsInput }) => {
  const modelsArr = args.models.map((m) => {
    const out: Record<string, unknown> = {
      model: m.id,
      name: m.name,
      base_url: m.base_url,
      api_backend: m.api_backend,
      context_window: m.context_window,
      hidden: m.hidden,
    };
    if (m.description) out.description = m.description;
    if (m.max_completion_tokens) out.max_completion_tokens = m.max_completion_tokens;
    if (m.env_key.length > 0) out.env_key = m.env_key;
    return out;
  });

  const doc: Record<string, unknown> = {
    models: modelsArr,
    default: args.defaults.default,
  };
  if (args.defaults.web_search) doc.web_search = args.defaults.web_search;
  if (args.defaults.image_description) doc.image_description = args.defaults.image_description;
  if (args.defaults.session_summary) doc.session_summary = args.defaults.session_summary;

  fs.mkdirSync(GROK_HOME, { recursive: true });
  fs.writeFileSync(MODELS_PATH, JSON.stringify(doc, null, 2));

  // Notify any listeners (ModelManager, TitleBar) so they can refresh.
  mainWindow?.webContents.send("config_changed", null);
  return ok(null);
});

ipcMain.handle("session_set_model", async (_e, args: Record<string, unknown>) => {
  console.log("[IPC] session_set_model", JSON.stringify(args));
  const sessionId = (args.sessionId ?? args.session_id) as string;
  const modelId = (args.modelId ?? args.model_id) as string;
  if (!sessionId || !modelId) throw new Error(`session_set_model: missing sessionId or modelId. Received: ${JSON.stringify(args)}`);
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error(`Session ${sessionId} not found`);
  if (rec.agent) {
    await rec.agent.setModel(modelId);
  }
  rec.currentModel = modelId;
  mainWindow?.webContents.send("config_changed", { sessionId, modelId });
  return ok(null);
});
ipcMain.handle("session_respond_permission", (_e, args: { sessionId: string; requestId: string; optionId: string }) => {
  const rec = sessions.get(args.sessionId);
  rec?.agent?.respondPermission(args.requestId, args.optionId);
  return ok(null);
});
ipcMain.handle("open_session_window", () => ok(null));

ipcMain.handle("session_create", async (_e, args: { cwd: string }) => {
  const id = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const cfg = toConfigSnapshot(readModelsDoc());
  const rec: SessionRecord = {
    id,
    cwd: args.cwd || ".",
    acp_session_id: id,
    models: cfg.models.map((m) => ({ id: m.id, name: m.name })),
    currentModel: cfg.default_model || cfg.models[0]?.id,
    createdAt: Date.now(),
  };
  sessions.set(id, rec);

  const emit = (event: Record<string, unknown>) => {
    mainWindow?.webContents.send("acp_event", event);
  };
  try {
    const envKeys = Array.from(new Set(cfg.models.flatMap((m) => m.env_key ?? [])));
    const agent = await AcpSession.create(id, rec.cwd, emit, envKeys);
    rec.agent = agent;
    rec.acp_session_id = agent.acpSessionId;
    rec.cwd = agent.cwd; // absolute path resolved by the agent session
    if (agent.models.length > 0) {
      rec.models = agent.models;
      rec.currentModel = agent.currentModelId || rec.currentModel;
    }
    touchProject(rec.cwd);
  } catch (e) {
    sessions.delete(id);
    const msg = e instanceof Error ? e.message : String(e);
    emit({ session_id: id, type: "Error", message: `Couldn't start session: ${msg}` });
    throw new Error(`Couldn't start session: ${msg}`);
  }
  // Return a plain DTO — the record holds a live agent handle which is not
  // structured-cloneable across IPC.
  return ok({
    id: rec.id,
    cwd: rec.cwd,
    acp_session_id: rec.acp_session_id,
    models: rec.models,
    currentModel: rec.currentModel,
    createdAt: rec.createdAt,
  });
});

ipcMain.handle("session_list", () =>
  ok(
    Array.from(sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      title: s.id,
    }))
  )
);

ipcMain.handle("session_send", async (_e, args: { session_id: string; message: string; images: { data: string; mime_type: string }[] }) => {
  const session = sessions.get(args.session_id);
  if (!session) throw new Error(`Session ${args.session_id} not found`);
  if (!session.agent) throw new Error(`Session ${args.session_id} has no live agent`);
  await session.agent.prompt(args.message, args.images ?? []);
  return ok(null);
});

ipcMain.handle("session_cancel", (_e, args: { sessionId?: string; session_id?: string }) => {
  const id = args.sessionId ?? args.session_id;
  const session = id ? sessions.get(id) : undefined;
  session?.agent?.cancel();
  return ok(null);
});
ipcMain.handle("session_compact", async (_e, args: { sessionId?: string; session_id?: string }) => {
  const id = args.sessionId ?? args.session_id;
  const session = id ? sessions.get(id) : undefined;
  if (!session?.agent) throw new Error(`Session ${id} has no live agent`);
  await session.agent.compact();
  return ok(null);
});
ipcMain.handle("session_close", (_e, args: { sessionId?: string; session_id?: string }) => {
  const id = args.sessionId ?? args.session_id;
  if (id) {
    const rec = sessions.get(id);
    rec?.agent?.dispose();
    sessions.delete(id);
  }
  return ok(null);
});

ipcMain.handle("session_list_history", () => ok([]));
ipcMain.handle("session_get_history", () => ok([]));

ipcMain.handle("list_api_keys", (_e, args: { envKeys: string[] }) => {
  const keys = Array.isArray(args) ? args : args?.envKeys ?? [];
  return ok(keys.map((k: string) => ({ env_key: k, is_set: isApiKeySet(k) })));
});
ipcMain.handle("save_api_key", (_e, args: { envKey: string; value: string }) => {
  saveApiKey(args.envKey, args.value);
  return ok(null);
});
ipcMain.handle("get_api_key", (_e, args: { envKey: string }) => ok(getApiKey(args.envKey)));
ipcMain.handle("delete_api_key", (_e, args: { envKey: string }) => {
  deleteApiKey(args.envKey);
  return ok(null);
});

ipcMain.handle("get_mcp_servers", () => ok([]));
ipcMain.handle("save_mcp_server", () => ok(null));
ipcMain.handle("delete_mcp_server", () => ok(null));
ipcMain.handle("toggle_mcp_server", () => ok(null));

ipcMain.handle("git_worktree_list", () => ok([]));
ipcMain.handle("git_worktree_add", () => ok(""));
ipcMain.handle("git_worktree_remove", () => ok(null));
ipcMain.handle("git_list_branches", () => ok([]));

ipcMain.handle("is_autostart_enabled", () => ok(false));
ipcMain.handle("enable_autostart", () => ok(null));
ipcMain.handle("disable_autostart", () => ok(null));

ipcMain.handle("log_frontend", (_e, args: { level: string; message: string }) => {
  console.log(`[FE ${args.level.toUpperCase()}]`, args.message);
  return ok(null);
});


// --- Projects (directory bookmarks) --------------------------------------
// Stored at ~/.grok/projects.json so both the Electron app and future CLI
// surfaces share one source of truth.
interface ProjectEntry {
  path: string;
  addedAt: number;
  lastUsedAt: number;
}

const PROJECTS_PATH = path.join(GROK_HOME, "projects.json");

function readProjects(): ProjectEntry[] {
  try {
    if (fs.existsSync(PROJECTS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf-8"));
      if (Array.isArray(raw)) return raw.filter((p) => typeof p?.path === "string");
    }
  } catch (e) {
    console.error("[projects] failed to read:", e);
  }
  return [];
}

function writeProjects(list: ProjectEntry[]): void {
  fs.mkdirSync(GROK_HOME, { recursive: true });
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(list, null, 2));
}

function touchProject(dir: string): void {
  const list = readProjects();
  const hit = list.find((p) => p.path === dir);
  if (hit) {
    hit.lastUsedAt = Date.now();
    writeProjects(list);
  }
}

ipcMain.handle("pick_directory", async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "Choose project directory",
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle("projects_list", () =>
  ok(readProjects().sort((a, b) => b.lastUsedAt - a.lastUsedAt))
);

ipcMain.handle("projects_add", (_e, args: { path: string }) => {
  if (!args?.path) throw new Error("projects_add: missing path");
  const list = readProjects().filter((p) => p.path !== args.path);
  const now = Date.now();
  list.push({ path: args.path, addedAt: now, lastUsedAt: now });
  writeProjects(list);
  return ok(list.sort((a, b) => b.lastUsedAt - a.lastUsedAt));
});

ipcMain.handle("projects_remove", (_e, args: { path: string }) => {
  const list = readProjects().filter((p) => p.path !== args?.path);
  writeProjects(list);
  return ok(list.sort((a, b) => b.lastUsedAt - a.lastUsedAt));
});

// --- Window / clipboard / notification / updater handlers ---
ipcMain.handle("window_minimize", () => { mainWindow?.minimize(); });
ipcMain.handle("window_toggle_maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window_close", () => { mainWindow?.close(); });
ipcMain.handle("window_start_dragging", () => {
  // Electron handles drag via CSS `-webkit-app-region: drag`; no-op here.
});
ipcMain.handle("window_set_focus", () => { mainWindow?.focus(); });
ipcMain.handle("window_is_focused", () => mainWindow?.isFocused() ?? false);

ipcMain.handle("clipboard_write_text", (_e, { text }: { text: string }) => {
  clipboard.writeText(text);
});
ipcMain.handle("clipboard_read_text", () => clipboard.readText());

ipcMain.handle("notification_send", (_e, { title, body }: { title: string; body?: string }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body: body || "" }).show();
  }
});
ipcMain.handle("notification_is_permitted", () => Notification.isSupported());
ipcMain.handle("notification_request_permission", () => ok("granted"));

ipcMain.handle("updater_check", () => ok(null)); // no update server configured in dev
ipcMain.handle("app_relaunch", () => {
  app.relaunch();
  app.exit(0);
});

// --- Window setup ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Grok Build",
    titleBarStyle: "default",
    backgroundColor: "#212121",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const rec of sessions.values()) {
    rec.agent?.dispose();
  }
  sessions.clear();
});

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
 
 function isTauriAvailable(): boolean {
   return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
 }
 
 async function safeListen<T>(
   event: string,
   handler: (payload: T) => void
 ): Promise<UnlistenFn> {
   if (!isTauriAvailable()) {
     console.warn(`[tauri] listen("${event}") called outside Tauri context — no-op`);
     return () => {};
   }
   try {
     return await listen<T>(event, (e) => handler(e.payload));
   } catch (err) {
     console.error(`[tauri] listen("${event}") failed:`, err);
     return () => {};
   }
 }

export interface SessionInfo {
  id: string;
  cwd: string;
  acp_session_id: string;
  models: { id: string; name: string }[];
}

export interface ModelInfo {
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

export interface ConfigSnapshot {
  models: ModelInfo[];
  default_model: string;
  web_search_model: string;
  image_description_model: string;
  session_summary_model: string;
}

export interface DefaultModels {
  default: string;
  web_search: string;
  image_description: string;
  session_summary: string;
}

export async function saveModels(
  models: ModelInfo[],
  defaults: DefaultModels
): Promise<void> {
  return invoke("save_models", { models, defaults });
}

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
}

export async function createSession(cwd: string): Promise<SessionInfo> {
  return invoke<SessionInfo>("session_create", { args: { cwd } });
}

export async function sendMessage(sessionId: string, message: string, images: { data: string; mime_type: string }[] = []): Promise<void> {
  return invoke("session_send", { args: { session_id: sessionId, message, images } });
}

export async function cancelSession(sessionId: string): Promise<void> {
  return invoke("session_cancel", { sessionId });
}

export async function compactSession(sessionId: string): Promise<void> {
  return invoke("session_compact", { sessionId });
}

export async function closeSession(sessionId: string): Promise<void> {
  return invoke("session_close", { sessionId });
}

const EMPTY_CONFIG: ConfigSnapshot = {
  models: [],
  default_model: "",
  web_search_model: "",
  image_description_model: "",
  session_summary_model: "",
};

export async function getConfig(): Promise<ConfigSnapshot> {
  if (!isTauriAvailable()) {
    return EMPTY_CONFIG;
  }
  try {
    return await Promise.race([
      invoke<ConfigSnapshot>("get_config"),
      new Promise<ConfigSnapshot>((resolve) => setTimeout(() => resolve(EMPTY_CONFIG), 5000)),
    ]);
  } catch {
    return EMPTY_CONFIG;
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  if (!isTauriAvailable()) {
    return { authenticated: false, username: null };
  }
  try {
    return await Promise.race([
      invoke<AuthStatus>("check_auth_status"),
      new Promise<AuthStatus>((resolve) =>
        setTimeout(() => resolve({ authenticated: false, username: null }), 5000)
      ),
    ]);
  } catch {
    return { authenticated: false, username: null };
  }
}

export async function login(): Promise<AuthStatus> {
  return invoke<AuthStatus>("login");
}

export async function logout(): Promise<void> {
  return invoke<void>("logout");
}

export function onAcpEvent(
  handler: (event: AcpEventPayload) => void
): Promise<UnlistenFn> {
  return safeListen<AcpEventPayload>("acp_event", handler);
}

export interface AcpEventPayload {
  type: string;
  session_id?: string;
  message_id?: string;
  delta?: string;
  tool_name?: string;
  args?: unknown;
  output?: string;
  success?: boolean;
  message?: string;
  request_id?: string;
  command?: string;
  options?: PermissionOption[];
  entries?: { content: string; status: string; priority: string }[];
  used?: number;
  size?: number;
  compaction_status?: string;
  compaction_tokens_before?: number;
  compaction_tokens_after?: number;
  compaction_summary?: string;
  compaction_error?: string;
}

export function onAuthMessage(
  handler: (message: string) => void
): Promise<UnlistenFn> {
  return safeListen<string>("auth_message", handler);
}

export interface SessionListItem {
  id: string;
  cwd: string;
  acp_session_id: string;
}

export async function listSessions(): Promise<SessionListItem[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  return invoke<SessionListItem[]>("session_list");
}

export async function openSessionInNewWindow(sessionId: string, title: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = new WebviewWindow(`session-${sessionId}`, {
    url: `index.html?session=${sessionId}`,
    title: title || "Grok Build",
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
  });
  win.once("tauri://error", (e) => {
    console.error("Failed to create window:", e);
  });
}

export interface HistorySession {
  id: string;
  cwd: string;
  title: string;
  model: string;
  created_at: string;
  last_active_at: string;
  num_messages: number;
}

export interface ChatHistoryEntry {
  role: string;
  content: string;
}

export async function listHistorySessions(): Promise<HistorySession[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  return invoke<HistorySession[]>("session_list_history");
}

export async function getSessionHistory(sessionId: string, cwd: string): Promise<ChatHistoryEntry[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  return invoke<ChatHistoryEntry[]>("session_get_history", { sessionId, cwd });
}

export async function setSessionModel(sessionId: string, modelId: string): Promise<void> {
  return invoke("session_set_model", { args: { session_id: sessionId, model_id: modelId } });
}

export interface PermissionOption {
  id: string;
  label: string;
  kind: string;
}

export async function respondPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
  remember: boolean
): Promise<void> {
  return invoke("respond_permission", {
    args: { session_id: sessionId, request_id: requestId, option_id: optionId, remember }
  });
}

// --- Autostart ---

export async function enableAutostart(): Promise<void> {
  return invoke("autostart_enable");
}

export async function disableAutostart(): Promise<void> {
  return invoke("autostart_disable");
}

export async function isAutostartEnabled(): Promise<boolean> {
  if (!isTauriAvailable()) {
    return false;
  }
  return invoke<boolean>("autostart_is_enabled");
}

// --- Tray events ---

export function onTrayAction(handler: (action: string) => void): Promise<UnlistenFn> {
  return safeListen<string>("tray-action", handler);
}

export async function updateTrayBadge(unread: number): Promise<void> {
  return invoke("update_tray_badge", { unread });
}
 
 export function onConfigChanged(handler: () => void): Promise<UnlistenFn> {
   return safeListen("config_changed", handler);
 }

// --- MCP Server Management ---

export interface McpServerInfo {
  name: string;
  enabled: boolean;
  transport_type: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: [string, string][];
  startup_timeout_sec: number | null;
  tool_timeout_sec: number | null;
}

export async function getMcpServers(): Promise<McpServerInfo[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  return invoke<McpServerInfo[]>("get_mcp_servers");
}

export async function saveMcpServer(args: {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: [string, string][];
  enabled?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
}): Promise<void> {
  return invoke("save_mcp_server", { args });
}

export async function deleteMcpServer(name: string): Promise<void> {
  return invoke("delete_mcp_server", { name });
}

export async function toggleMcpServer(name: string, enabled: boolean): Promise<void> {
  return invoke("toggle_mcp_server", { name, enabled });
}

// --- Git Worktree ---

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  return invoke<WorktreeInfo[]>("git_worktree_list", { cwd });
}

export async function addWorktree(cwd: string, branch: string, path: string, newBranch: boolean): Promise<string> {
  return invoke<string>("git_worktree_add", { args: { cwd, branch, path, new_branch: newBranch } });
}

export async function removeWorktree(cwd: string, path: string, force: boolean): Promise<void> {
  return invoke("git_worktree_remove", { args: { cwd, path, force } });
}

export async function listBranches(cwd: string): Promise<string[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  return invoke<string[]>("git_list_branches", { cwd });
}

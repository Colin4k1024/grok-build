import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export async function closeSession(sessionId: string): Promise<void> {
  return invoke("session_close", { sessionId });
}

export async function getConfig(): Promise<ConfigSnapshot> {
  return invoke<ConfigSnapshot>("get_config");
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("check_auth_status");
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
  return listen<AcpEventPayload>("acp_event", (e) => handler(e.payload));
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
}

export function onAuthMessage(
  handler: (message: string) => void
): Promise<UnlistenFn> {
  return listen<string>("auth_message", (e) => handler(e.payload));
}

export interface SessionListItem {
  id: string;
  cwd: string;
  acp_session_id: string;
}

export async function listSessions(): Promise<SessionListItem[]> {
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
  return invoke<HistorySession[]>("session_list_history");
}

export async function getSessionHistory(sessionId: string, cwd: string): Promise<ChatHistoryEntry[]> {
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

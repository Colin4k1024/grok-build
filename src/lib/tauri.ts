/**
 * Desktop runtime transport — Electron-only.
 *
 * The app was originally written against Tauri; we've migrated to Electron.
 * All frontend code calls these helpers, which route through window.electron
 * (exposed by electron/preload.ts via contextBridge).
 */

export type UnlistenFn = () => void;

interface ElectronBridge {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  on: (channel: string, handler: (payload: unknown) => void) => () => void;
  platform: string;
}

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

function bridge(): ElectronBridge {
  if (typeof window === "undefined" || !window.electron) {
    throw new Error(
      "Electron bridge not available — preload script did not expose window.electron"
    );
  }
  return window.electron;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return bridge().invoke<T>(cmd, args);
}

export function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  const un = bridge().on(event, (p) => handler(p as T));
  return Promise.resolve(un);
}

export async function safeListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  try {
    return await listen<T>(event, handler);
  } catch (err) {
    console.error(`[transport] listen("${event}") failed:`, err);
    return () => {};
  }
}

// ===== Types =====

export interface SessionInfo {
  id: string;
  cwd: string;
  acp_session_id: string;
  models: { id: string; name: string }[];
  currentModel?: string;
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

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
  /** Auth surface in effect: OAuth endpoint, API-key store, or dev bypass. */
  mode?: "oauth" | "api-key" | "dev";
  /** True when the OAuth/device-code endpoint probe succeeded. */
  oauthAvailable?: boolean;
  /** Where the winning credential came from. */
  source?: "file" | "keychain" | "env";
  envKey?: string;
}

export interface AcpEventPayload {
  session_id?: string;
  type: string;
  delta?: string;
  text?: string;
  replay?: boolean;
  tool_name?: string;
  output?: string;
  success?: boolean;
  request_id?: string;
  command?: string;
  options?: PermissionOption[];
  message?: string;
  compaction_status?: string;
  compaction_tokens_before?: number | null;
  compaction_tokens_after?: number | null;
  compaction_summary?: string | null;
  entries?: { content: string; status: string; priority: string }[];
  questions?: UserQuestion[];
  mode?: string;
  used?: number;
  size?: number;
  retry_after_seconds?: number;
}

export interface PermissionOption {
  id: string;
  label: string;
  kind: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface UserQuestion {
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  id?: string;
}

export interface SessionListItem {
  id: string;
  cwd: string;
  title: string;
}

export interface HistorySession {
  id: string;
  session_id: string;
  title: string;
  cwd: string;
  updated_at: number;
  last_active_at: string;
  model: string;
  num_messages: number;
}

export interface ChatHistoryEntry {
  role: string;
  content: string;
  timestamp: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
}

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  url: string | null;
  enabled: boolean;
  transport_type: string;
  env: [string, string][];
}

// ===== Session =====

export async function createSession(cwd: string): Promise<SessionInfo> {
  return invoke<SessionInfo>("session_create", { cwd });
}

/**
 * Resume a persisted thread: spawns the agent with `session/load` so the full
 * conversation context comes back and the transcript replays into the tab.
 */
/** Respond to an agent ask_user_question request. response = { outcome: "accepted", answers } | { outcome: "cancelled" }. */
export async function respondUserQuestion(
  sessionId: string,
  requestId: string,
  response: Record<string, unknown>
): Promise<void> {
  await invoke("user_question_respond", { sessionId, requestId, response });
}

export async function resumeSession(acpSessionId: string, cwd: string): Promise<SessionInfo> {
  return invoke<SessionInfo>("session_resume", { acp_session_id: acpSessionId, cwd });
}

export interface HistoryMessage {
  role: string;
  content: string;
  timestamp: number;
}

/** Disk-persisted transcript of a history thread (fallback when ACP replay is empty). */
export async function getSessionHistoryMessages(sessionId: string, cwd: string): Promise<HistoryMessage[]> {
  try {
    return await invoke<HistoryMessage[]>("session_get_history", { session_id: sessionId, cwd });
  } catch {
    return [];
  }
}

export async function sendMessage(
  sessionId: string,
  message: string,
  images: { data: string; mime_type: string }[] = []
): Promise<void> {
  console.log("[tauri.ts] sendMessage called", { sessionId, msgLen: message.length, images: images.length });
  const result: unknown = await invoke("session_send", { session_id: sessionId, message, images });
  console.log("[tauri.ts] sendMessage invoke done", result);
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

export async function listSessions(): Promise<SessionListItem[]> {
  return invoke<SessionListItem[]>("session_list");
}

export async function listHistorySessions(): Promise<HistorySession[]> {
  return invoke<HistorySession[]>("session_list_history");
}

export async function getSessionHistory(
  sessionId: string,
  cwd: string
): Promise<ChatHistoryEntry[]> {
  return invoke<ChatHistoryEntry[]>("session_get_history", { sessionId, cwd });
}

/** Permanently delete a persisted thread from disk (codex `/delete` parity). */
export async function deleteHistorySession(sessionId: string, cwd: string): Promise<void> {
  return invoke("session_delete_history", { sessionId, cwd });
}

/** Persist a thread rename into its summary.json (ISS-079). */
export async function renameHistorySession(
  sessionId: string,
  cwd: string,
  title: string
): Promise<{ title: string }> {
  return invoke<{ title: string }>("session_rename_history", { sessionId, cwd, title });
}

export async function setSessionModel(sessionId: string, modelId: string): Promise<void> {
  return invoke("session_set_model", { sessionId, modelId });
}

// ===== Projects (directory bookmarks) =====

export interface ProjectEntry {
  path: string;
  addedAt: number;
  lastUsedAt: number;
}

/** Native directory picker. Returns the chosen absolute path or null. */
export async function pickDirectory(): Promise<string | null> {
  return invoke<string | null>("pick_directory");
}

export async function listProjects(): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("projects_list");
}

export async function addProject(path: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("projects_add", { path });
}

export async function removeProject(path: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>("projects_remove", { path });
}

// ===== Config / Auth =====

const EMPTY_CONFIG: ConfigSnapshot = {
  models: [],
  default_model: "",
  web_search_model: "",
  image_description_model: "",
  session_summary_model: "",
};

export async function getConfig(): Promise<ConfigSnapshot> {
  try {
    return await invoke<ConfigSnapshot>("get_config");
  } catch {
    return EMPTY_CONFIG;
  }
}

export async function saveModels(models: ModelInfo[], defaults: DefaultModels): Promise<void> {
  return invoke("save_models", { models, defaults });
}

export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    return await invoke<AuthStatus>("check_auth_status");
  } catch {
    return { authenticated: false, username: null };
  }
}

export async function login(): Promise<AuthStatus> {
  return invoke<AuthStatus>("login");
}

/** API-key first-screen login (ISS-073): store the provider key securely. */
export async function loginWithApiKey(envKey: string, value: string): Promise<AuthStatus> {
  return invoke<AuthStatus>("login_api_key", { envKey, value });
}

/** Env keys the desktop shell accepts as provider credentials. */
export async function listAuthEnvKeys(): Promise<string[]> {
  try {
    return await invoke<string[]>("auth_env_keys");
  } catch {
    return [];
  }
}

export async function logout(): Promise<void> {
  return invoke("logout");
}

// ===== Events =====

export function onAcpEvent(handler: (event: AcpEventPayload) => void): Promise<UnlistenFn> {
  return safeListen<AcpEventPayload>("acp_event", handler);
}

export function onAuthMessage(handler: (message: string) => void): Promise<UnlistenFn> {
  return safeListen<string>("auth_message", handler);
}

export function onConfigChanged(handler: () => void): Promise<UnlistenFn> {
  return safeListen("config_changed", handler);
}

export function onTrayAction(handler: (action: string) => void): Promise<UnlistenFn> {
  return safeListen("tray_action", handler);
}

// ===== API keys =====

export interface ApiKeyEntry {
  env_key: string;
  is_set: boolean;
}

export async function listApiKeys(envKeys: string[]): Promise<ApiKeyEntry[]> {
  return invoke<ApiKeyEntry[]>("list_api_keys", { envKeys });
}

export async function saveApiKey(envKey: string, value: string): Promise<void> {
  return invoke("save_api_key", { envKey, value });
}

export async function getApiKey(envKey: string): Promise<string | null> {
  return invoke<string | null>("get_api_key", { envKey });
}

export async function deleteApiKey(envKey: string): Promise<void> {
  return invoke("delete_api_key", { envKey });
}

// ===== MCP =====

export async function getMcpServers(): Promise<McpServerInfo[]> {
  return invoke<McpServerInfo[]>("get_mcp_servers");
}

export async function saveMcpServer(input: {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: [string, string][];
  enabled: boolean;
}): Promise<void> {
  return invoke("save_mcp_server", input);
}

export async function deleteMcpServer(name: string): Promise<void> {
  return invoke("delete_mcp_server", { name });
}

export async function toggleMcpServer(name: string, enabled: boolean): Promise<void> {
  return invoke("toggle_mcp_server", { name, enabled });
}

// ===== Worktree =====

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  try {
    return await invoke<WorktreeInfo[]>("git_worktree_list", { cwd });
  } catch {
    return [];
  }
}

export async function addWorktree(
  cwd: string,
  branch: string,
  path: string,
  newBranch: boolean
): Promise<string> {
  return invoke<string>("git_worktree_add", { args: { cwd, branch, path, new_branch: newBranch } });
}

export async function removeWorktree(cwd: string, path: string, force: boolean): Promise<void> {
  return invoke("git_worktree_remove", { args: { cwd, path, force } });
}

export async function listBranches(cwd: string): Promise<string[]> {
  return invoke<string[]>("git_list_branches", { cwd });
}

// ===== Composer support (@ files, $ skills) =====

/** Tracked files of the workspace for "@" fuzzy search. */
export async function listRepoFiles(cwd: string): Promise<string[]> {
  try {
    return await invoke<string[]>("git_ls_files", { cwd });
  } catch {
    return [];
  }
}

export interface SkillInfo {
  name: string;
  description: string;
}

/** Available skill names for the "$" trigger. */
export async function listSkills(): Promise<SkillInfo[]> {
  try {
    return await invoke<SkillInfo[]>("skills_list");
  } catch {
    return [];
  }
}

// ===== Side panel (Files / Review / Terminal) =====

export interface GitStatusEntry {
  status: string;
  file: string;
}

export async function gitStatus(cwd: string): Promise<GitStatusEntry[]> {
  return invoke<GitStatusEntry[]>("git_status", { cwd });
}

export async function gitDiff(cwd: string, path?: string): Promise<string> {
  return invoke<string>("git_diff", { cwd, path });
}

/** Staged (cached) diff — shows what's in the index versus HEAD. */
export async function gitDiffStaged(cwd: string, path?: string): Promise<string> {
  return invoke<string>("git_diff_staged", { cwd, path });
}

/** Unstage a single file. */
export async function gitResetFile(cwd: string, path: string): Promise<void> {
  return invoke<void>("git_reset_file", { cwd, path });
}

/** Discard working-tree changes to a single file. */
export async function gitRestoreFile(cwd: string, path: string): Promise<void> {
  return invoke<void>("git_restore_file", { cwd, path });
}

export async function runCommand(cwd: string, command: string): Promise<{ stdout: string; stderr: string }> {
  return invoke<{ stdout: string; stderr: string }>("run_command", { cwd, command });
}

/** Triage Approve — stage all changes and commit on the reviewed branch. */
export async function gitCommit(cwd: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { cwd, message });
}

// ===== Claude Code import (ISS-083) =====

export interface ClaudeProbeInfo {
  available: boolean;
  root: string;
  sessions: number;
  projects: number;
  hasInstructions: boolean;
  docs: number;
}

export interface ClaudeSessionItem {
  sourceId: string;
  cwd: string;
  title: string;
  mtime: number;
  size: number;
  /** Already has an imported destination — UI must not re-import. */
  imported: boolean;
}

export type ClaudeImportOutcome =
  | { status: "imported"; entries: { role: string; content: string; timestamp: number }[]; skippedLines: number }
  | { status: "already-imported" }
  | { status: "conflict" }
  | { status: "error"; message: string };

export async function claudeProbe(): Promise<ClaudeProbeInfo> {
  return invoke<ClaudeProbeInfo>("claude_probe");
}
export async function claudeListSessions(): Promise<ClaudeSessionItem[]> {
  return invoke<ClaudeSessionItem[]>("claude_list_sessions");
}
export async function claudeImportSession(sourceId: string): Promise<ClaudeImportOutcome> {
  return invoke<ClaudeImportOutcome>("claude_import_session", { sourceId });
}
export async function claudeImportInstructions(projectRoot: string): Promise<{ status: string; message?: string }> {
  return invoke<{ status: string; message?: string }>("claude_import_instructions", { projectRoot });
}

/** Preview a source session WITHOUT registering it (retry-safe import flow). */
export async function claudePeekSession(
  sourceId: string
): Promise<{ entries: { role: string; content: string; timestamp: number }[]; skippedLines: number; error?: string }> {
  return invoke("claude_peek_session", { sourceId });
}

/** Mark a source imported — call only after the destination thread exists. */
export async function claudeMarkImported(sourceId: string): Promise<void> {
  await invoke("claude_mark_imported", { sourceId });
}

export type ClaudeClaim =
  | { status: "claimed"; entries: { role: string; content: string; timestamp: number }[]; skippedLines: number }
  | { status: "already-imported" }
  | { status: "error"; message: string };

/** Atomic claim — duplicate destinations are impossible across windows. */
export async function claudeClaimSession(sourceId: string): Promise<ClaudeClaim> {
  return invoke<ClaudeClaim>("claude_claim_session", { sourceId });
}

/** Release a claim after destination creation failed (retry-safe). */
export async function claudeUnmarkSession(sourceId: string): Promise<void> {
  await invoke("claude_unmark_session", { sourceId });
}

/** Persist a seeded transcript so restart/session-load restores it. */
export async function persistTranscript(args: {
  acpSessionId: string;
  cwd: string;
  title: string;
  entries: { role: string; content: string; timestamp: number }[];
}): Promise<{ written: number }> {
  return invoke<{ written: number }>("session_persist_transcript", args);
}

// ===== Review workflow (ISS-080) =====

/** Dangling worktree snapshot (`git stash create`); null when clean. */
export async function gitTurnSnapshot(cwd: string): Promise<{ sha: string | null }> {
  return invoke<{ sha: string | null }>("git_turn_snapshot", { cwd });
}

/** Worktree diff vs a turn snapshot (null → HEAD). */
export async function gitDiffSince(cwd: string, sha: string | null): Promise<string> {
  return invoke<string>("git_diff_since", { cwd, sha });
}

/** Files in unresolved merge-conflict state. */
export async function gitConflicted(cwd: string): Promise<string[]> {
  return invoke<string[]>("git_conflicted", { cwd });
}

// ===== Autostart =====

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_autostart_enabled");
  } catch {
    return false;
  }
}

export async function enableAutostart(): Promise<void> {
  return invoke("enable_autostart");
}

export async function disableAutostart(): Promise<void> {
  return invoke("disable_autostart");
}

// Platform lifecycle (R3-14)
export async function getCrashRecoveryStatus(): Promise<{ crashed: boolean; marker: string }> {
  return invoke("crash_recovery_status");
}

export async function getOsPermissions(): Promise<Record<string, string>> {
  return invoke("os_permissions");
}

// ===== Logging =====

export async function logFrontend(level: "error" | "warn" | "info" | "log", message: string) {
  return invoke("log_frontend", { args: { level, message } });
}

// ===== Permissions =====

export async function respondPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
  remember: boolean
): Promise<void> {
  return invoke("session_respond_permission", {
    sessionId,
    requestId,
    optionId,
    remember,
  });
}

// ===== PTY terminal (ISS-075: Rust-side ptyctl, ADR 0002) =====

export interface PtySession {
  id: string;
  port: number;
  /** Per-session auth token — required on the ws URL. */
  token: string;
  pid: number;
  cols: number;
  rows: number;
  shell: string;
}

/** Start an interactive terminal session; bytes flow over its WebSocket. */
export async function ptySpawn(
  cwd: string,
  cols = 80,
  rows = 24
): Promise<PtySession> {
  return invoke<PtySession>("pty_spawn", { cwd, cols, rows });
}

/** Kill a session's controller; the PTY process group dies with it. */
export async function ptyDispose(id: string): Promise<void> {
  await invoke("pty_dispose", { id });
}

export async function ptyEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("pty_enabled");
  } catch {
    return false;
  }
}

export function onPtyExit(handler: (p: { id: string; code: number }) => void): Promise<UnlistenFn> {
  return safeListen<{ id: string; code: number }>("pty_exit", handler);
}

// ===== Window helpers =====

export async function openSessionInNewWindow(sessionId: string, _title: string): Promise<void> {
  return invoke("open_session_window", { sessionId });
}

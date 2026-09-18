/**
 * ACP (Agent Client Protocol) stdio client for the Electron main process.
 *
 * Spawns the `xai-grok-pager agent stdio` binary and drives the same ACP
 * lifecycle the Tauri bridge used: initialize -> authenticate -> session/new,
 * then session/prompt per turn. Agent notifications are translated into the
 * `acp_event` payloads the frontend already understands.
 */

import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";

// ---- agent binary resolution ------------------------------------------------

/**
 * Resolution order:
 *  1. GROK_AGENT_BIN env override (explicit path to the binary)
 *  2. Packaged app: <resources>/xai-grok-pager (bundled via extraResources)
 *  3. <repo>/target/release/xai-grok-pager
 *  4. <repo>/target/debug/xai-grok-pager
 *  5. "xai-grok-pager" from PATH
 */
export function resolveAgentBinary(): string {
  if (process.env.GROK_AGENT_BIN) return process.env.GROK_AGENT_BIN;
  try {
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, "xai-grok-pager");
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch {
    // app not ready yet — fall through
  }
  let appPath = process.cwd();
  try {
    appPath = app.getAppPath();
  } catch {
    // app not ready yet — fall back to cwd
  }
  const release = path.join(appPath, "target", "release", "xai-grok-pager");
  const debug = path.join(appPath, "target", "debug", "xai-grok-pager");
  if (fs.existsSync(release)) return release;
  if (fs.existsSync(debug)) return debug;
  return "xai-grok-pager";
}

// ---- API key store (file-backed; keychain parity can come later) ------------

const GROK_HOME = path.join(os.homedir(), ".grok");
const API_KEYS_PATH = path.join(GROK_HOME, "api_keys.json");

function readKeyStore(): Record<string, string> {
  try {
    if (fs.existsSync(API_KEYS_PATH)) {
      return JSON.parse(fs.readFileSync(API_KEYS_PATH, "utf-8"));
    }
  } catch (e) {
    console.error("[apikey] failed to read store:", e);
  }
  return {};
}

function writeKeyStore(store: Record<string, string>): void {
  fs.mkdirSync(GROK_HOME, { recursive: true });
  fs.writeFileSync(API_KEYS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function saveApiKey(envKey: string, value: string): void {
  const store = readKeyStore();
  store[envKey] = value;
  writeKeyStore(store);
}

export function getApiKey(envKey: string): string | null {
  return readKeyStore()[envKey] ?? process.env[envKey] ?? null;
}

export function deleteApiKey(envKey: string): void {
  const store = readKeyStore();
  delete store[envKey];
  writeKeyStore(store);
}

export function isApiKeySet(envKey: string): boolean {
  const v = readKeyStore()[envKey] ?? process.env[envKey];
  return typeof v === "string" && v.length > 0;
}

/**
 * Keychain compat: the Tauri build stored keys in the macOS Keychain under
 * service "com.xai.grokbuild.desktop". Read-through so existing users don't
 * have to re-enter keys. Results are cached for the process lifetime; misses
 * are cached too so we never prompt twice for the same key.
 */
const KEYCHAIN_SERVICE = "com.xai.grokbuild.desktop";
const keychainCache = new Map<string, string | null>();

function keychainLookup(envKey: string): Promise<string | null> {
  if (keychainCache.has(envKey)) return Promise.resolve(keychainCache.get(envKey) ?? null);
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", envKey, "-w"],
      { timeout: 8000 },
      (err, stdout) => {
        const value = err ? null : stdout.trim() || null;
        keychainCache.set(envKey, value);
        resolve(value);
      }
    );
    child.on("error", () => {
      keychainCache.set(envKey, null);
      resolve(null);
    });
  });
}

/**
 * Build the child-process env for the agent: process.env + file store +
 * keychain read-through for the given env keys.
 */
export async function buildAgentEnv(envKeys: string[] = []): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...readKeyStore() };
  await Promise.all(
    envKeys.map(async (k) => {
      if (!env[k]) {
        const v = await keychainLookup(k);
        if (v) env[k] = v;
      }
    })
  );
  return env;
}

// ---- JSON-RPC plumbing ------------------------------------------------------

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface JsonRpcError {
  code: number;
  message: string;
}

type Emit = (event: Record<string, unknown>) => void;

function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join("");
}

export interface SessionModel {
  id: string;
  name: string;
}

export class AcpSession {
  readonly id: string;
  readonly cwd: string;
  acpSessionId = "";
  models: SessionModel[] = [];
  currentModelId = "";

  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private emit: Emit;
  private permissionResponders = new Map<string, (optionId: string | null) => void>();
  private userQuestionResponders = new Map<string, (response: Record<string, unknown>) => void>();
  private disposed = false;

  private constructor(id: string, cwd: string, proc: ChildProcessWithoutNullStreams, emit: Emit) {
    this.id = id;
    this.cwd = cwd;
    this.proc = proc;
    this.emit = emit;

    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      console.error(`[agent ${this.id}] ${chunk.toString().trimEnd()}`);
    });
    proc.on("error", (err) => {
      console.error(`[agent ${this.id}] process error:`, err);
      this.failAllPending(err);
    });
    proc.on("exit", (code, signal) => {
      console.error(`[agent ${this.id}] exited code=${code} signal=${signal}`);
      this.failAllPending(new Error(`Agent process exited (code=${code} signal=${signal})`));
      if (!this.disposed) {
        this.emit({ session_id: this.id, type: "Error", message: "Agent process exited" });
      }
    });
  }

  /**
   * Spawn the agent and run the ACP handshake. Rejects on any failure.
   * Pass `resume` to restore a persisted session instead of starting fresh:
   * the agent replays the stored conversation as `session/update`
   * notifications flagged `_meta.isReplay`, so the transcript rebuilds in the
   * client exactly like Codex thread resume.
   */
  static async create(
    id: string,
    cwd: string,
    emit: Emit,
    envKeys: string[] = [],
    resume?: { acpSessionId: string }
  ): Promise<AcpSession> {
    const bin = resolveAgentBinary();
    // ACP session/new rejects relative paths ("Path is not absolute").
    const absCwd = path.resolve(cwd || ".");
    console.log(`[acp] spawning agent: ${bin} agent stdio (cwd=${absCwd})`);
    const env = await buildAgentEnv(envKeys);
    const proc = spawn(bin, ["agent", "stdio"], {
      cwd: absCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session = new AcpSession(id, absCwd, proc, emit);
    await session.handshake();
    const resp = await session.request(
      resume ? "session/load" : "session/new",
      resume
        ? { sessionId: resume.acpSessionId, cwd: session.cwd, mcpServers: [] }
        : { cwd: session.cwd, mcpServers: [] }
    );
    session.adoptSession(resp);
    if (resume) session.acpSessionId = resume.acpSessionId;
    return session;
  }

  /** Resume a persisted session by its ACP session id (see `create`). */
  static async load(
    id: string,
    acpSessionId: string,
    cwd: string,
    emit: Emit,
    envKeys: string[] = []
  ): Promise<AcpSession> {
    return AcpSession.create(id, cwd, emit, envKeys, { acpSessionId });
  }

  private async handshake(): Promise<void> {
    const initResp = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })) as {
      authMethods?: { id: string; name?: string }[];
      _meta?: { defaultAuthMethodId?: string };
    };

    const authMethods = initResp.authMethods ?? [];
    if (authMethods.length > 0) {
      const defaultId = initResp._meta?.defaultAuthMethodId;
      const pick =
        (defaultId && authMethods.find((m) => m.id === defaultId)) ||
        authMethods.find((m) => m.id.toLowerCase().includes("cached")) ||
        authMethods[0];
      await this.request("authenticate", { methodId: pick.id });
    }
  }

  /** Adopt the sessionId/models from a session/new or session/load response. */
  private adoptSession(resp: unknown): void {
    const r = resp as {
      sessionId?: string;
      models?: { availableModels?: { modelId: string; name: string }[]; currentModelId?: string };
    };
    this.acpSessionId = r.sessionId ?? "";
    this.models = (r.models?.availableModels ?? []).map((m) => ({
      id: m.modelId,
      name: m.name,
    }));
    this.currentModelId = r.models?.currentModelId ?? "";
    console.log(`[acp] session ready: acp=${this.acpSessionId} models=${this.models.length}`);
  }

  // ---- public commands ----

  /** Send a user prompt; resolves when the turn completes. */
  async prompt(message: string, images: { data: string; mime_type: string }[] = []): Promise<void> {
    const blocks: Record<string, unknown>[] = [];
    if (message) blocks.push({ type: "text", text: message });
    for (const img of images) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mime_type });
    }
    try {
      await this.request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: blocks,
        _meta: { promptId: randomUUID(), screenMode: "desktop" },
      });
      this.emit({ session_id: this.id, type: "TurnComplete" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ session_id: this.id, type: "Error", message: msg });
      throw e;
    }
  }

  async compact(): Promise<void> {
    await this.prompt("/compact");
  }

  async setModel(modelId: string): Promise<void> {
    await this.request("session/set_model", {
      sessionId: this.acpSessionId,
      modelId,
    });
    this.currentModelId = modelId;
  }

  cancel(): void {
    this.notify("session/cancel", { sessionId: this.acpSessionId });
  }

  /** Answer or dismiss an `x.ai/ask_user_question` ext request. */
  respondUserQuestion(requestId: string, response: Record<string, unknown>): void {
    const responder = this.userQuestionResponders.get(requestId);
    if (responder) {
      this.userQuestionResponders.delete(requestId);
      responder(response);
    }
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const responder = this.permissionResponders.get(requestId);
    if (responder) {
      this.permissionResponders.delete(requestId);
      responder(optionId);
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  // ---- wire protocol ----

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.proc.stdin.write(payload + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin.write(payload + "\n");
  }

  private respond(id: number | string, result: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    );
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn(`[acp] non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = msg.method as string | undefined;

    // Response to one of our requests
    if (hasId && !method) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg.error) {
          const e = msg.error as JsonRpcError;
          p.reject(new Error(`${p.method} failed: ${e.message ?? JSON.stringify(e)}`));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Agent -> client request
    if (hasId && method) {
      this.onAgentRequest(msg.id as number | string, method, msg.params as Record<string, unknown>);
      return;
    }

    // Notification
    if (method) {
      this.onAgentNotification(method, msg.params as Record<string, unknown>);
    }
  }

  private onAgentRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "session/request_permission": {
        const requestId = randomUUID();
        const toolCall = (params?.toolCall ?? {}) as { title?: string };
        const options = ((params?.options ?? []) as { optionId: string; name: string; kind: string }[]).map(
          (o) => ({ id: o.optionId, label: o.name, kind: snakeToPascal(o.kind ?? "") })
        );
        const command =
          ((params?.options ?? []) as { name: string; kind: string }[]).find((o) => o.kind === "allow_once")
            ?.name ?? "";
        this.permissionResponders.set(requestId, (optionId) => {
          if (optionId === null) {
            this.respond(id, { outcome: { outcome: "cancelled" } });
          } else {
            this.respond(id, { outcome: { outcome: "selected", optionId } });
          }
        });
        this.emit({
          session_id: this.id,
          type: "PermissionRequest",
          request_id: requestId,
          tool_name: toolCall.title ?? "Unknown",
          command,
          options,
        });
        break;
      }
      case "_x.ai/ask_user_question":
      case "x.ai/ask_user_question": {
        const requestId = randomUUID();
        this.userQuestionResponders.set(requestId, (response) => {
          this.respond(id, response);
        });
        this.emit({
          session_id: this.id,
          type: "UserQuestionRequest",
          request_id: requestId,
          questions: (params?.questions ?? []) as unknown[],
          mode: (params?.mode as string) ?? "default",
        });
        break;
      }
      case "fs/read_text_file":
        // Mirror the Tauri bridge: empty content (agent-side tools do real fs work).
        this.respond(id, { content: "" });
        break;
      case "fs/write_text_file":
        this.respond(id, null);
        break;
      default:
        // terminal/* and anything else we didn't advertise support for
        this.respondError(id, -32601, `Method not supported by client: ${method}`);
    }
  }

  private onAgentNotification(method: string, params: Record<string, unknown>): void {
    if (method === "session/update") {
      const meta = (params?._meta ?? {}) as { isReplay?: boolean };
      this.onSessionUpdate((params?.update ?? {}) as Record<string, unknown>, !!meta.isReplay);
      return;
    }
    if (method === "x.ai/session_notification" || method === "x.ai/session/update") {
      this.onExtSessionNotification(params ?? {});
    }
  }

  private onSessionUpdate(update: Record<string, unknown>, replay: boolean): void {
    const kind = update.sessionUpdate as string | undefined;
    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.emit({
            session_id: this.id,
            type: "TextDelta",
            delta: content.text,
            replay,
          });
        }
        break;
      }
      case "user_message_chunk": {
        // Emitted during session/load replay so the restored transcript shows
        // both sides of the conversation.
        const content = update.content as { type?: string; text?: string } | undefined;
        if (replay && content?.type === "text" && content.text) {
          this.emit({
            session_id: this.id,
            type: "UserMessage",
            text: content.text,
            replay,
          });
        }
        break;
      }
      case "tool_call": {
        this.emit({
          session_id: this.id,
          type: "ToolCall",
          tool_name: (update.title as string) ?? "",
          replay,
        });
        break;
      }
      case "tool_call_update": {
        const status = update.status as string | undefined;
        if (status === "completed" || status === "failed") {
          const contentArr = (update.content ?? []) as unknown[];
          this.emit({
            session_id: this.id,
            type: "ToolResult",
            tool_name: "",
            output: contentArr.length > 0 ? JSON.stringify(contentArr[0]) : "",
            success: status === "completed",
            replay,
          });
        }
        break;
      }
      case "plan": {
        const entries = ((update.entries ?? []) as { content: string; status: string; priority: string }[]).map(
          (e) => ({
            content: e.content,
            status: snakeToPascal(e.status ?? ""),
            priority: snakeToPascal(e.priority ?? ""),
          })
        );
        this.emit({ session_id: this.id, type: "PlanUpdate", entries, replay });
        break;
      }
      case "usage_update": {
        this.emit({
          session_id: this.id,
          type: "UsageUpdate",
          used: update.used as number,
          size: update.size as number,
        });
        break;
      }
    }
  }

  private onExtSessionNotification(params: Record<string, unknown>): void {
    const updateType = params.sessionUpdate as string | undefined;
    switch (updateType) {
      case "auto_compact_started":
        this.emit({
          session_id: this.id,
          type: "CompactionStatus",
          compaction_status: "started",
          compaction_tokens_before: (params.tokens_used as number) ?? null,
        });
        break;
      case "auto_compact_completed":
        this.emit({
          session_id: this.id,
          type: "CompactionStatus",
          compaction_status: "completed",
          compaction_tokens_before: (params.tokens_before as number) ?? null,
          compaction_tokens_after: (params.tokens_after as number) ?? null,
          compaction_summary: (params.summary_preview as string) ?? null,
        });
        break;
      case "auto_compact_failed":
        this.emit({
          session_id: this.id,
          type: "CompactionStatus",
          compaction_status: "failed",
          compaction_error: (params.error as string) ?? null,
        });
        break;
      case "auto_compact_cancelled":
        this.emit({
          session_id: this.id,
          type: "CompactionStatus",
          compaction_status: "cancelled",
        });
        break;
    }
  }
}

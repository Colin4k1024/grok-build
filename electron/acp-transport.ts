/**
 * Managed ACP transport (R3-02 / #187).
 *
 * The old model spawned one `xai-grok-pager agent stdio` process per tab —
 * N tabs, N agent processes, N connections. This module replaces that with
 * a single managed `agent serve` process (a loopback WebSocket server that
 * hosts multiple isolated sessions on one connection). One process, one
 * connection, N sessions — the architecture the issue demands.
 *
 * The transport owns:
 *   - the `agent serve` child process lifecycle
 *   - the single WebSocket connection (authenticate once, then multiplex)
 *   - a SessionRegistry: UI session id → agent sessionId, with per-session
 *     pending-request maps and event routing keyed by the agent sessionId
 *     in each `session/update` notification
 *   - typed capability negotiation: the `initialize` response's
 *     `agentCapabilities` is parsed into a typed shape; unknown capabilities
 *     are explicitly dropped (degraded), never silently assumed
 *
 * Rollback: `ACP_MULTI_SESSION=off` makes the callers fall back to the old
 * per-tab stdio `AcpSession` model. The transport is not constructed.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { permissionStateMachine } from "./permission-state";
import {
  FsBridgeError,
  FS_ERR_IO,
  bridgeReadTextFile,
  bridgeWriteTextFile,
  type ReadParams,
  type WriteParams,
} from "./fs-bridge";
import { readKeyStore, securityKeychain } from "./auth";

export type EmitFn = (event: Record<string, unknown>) => void;

// ---- capability negotiation ----------------------------------------------

export interface AgentCapabilities {
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  sessionList: boolean;
  sessionResume: boolean;
  sessionClose: boolean;
  /** Raw capabilities from the agent we did not type — for auditing. */
  raw: Record<string, unknown>;
}

export interface CapabilityNegotiationResult {
  capabilities: AgentCapabilities;
  /** Capabilities the agent advertised that we did not recognize. */
  unknown: string[];
  /** Capabilities we requested that the agent did not advertise. */
  unsupported: string[];
}

// ---- session registry -----------------------------------------------------

interface ManagedSession {
  /** UI-facing session id (the one the renderer and journal know). */
  uiId: string;
  /** Agent-assigned session id (from session/new). */
  agentSessionId: string;
  /** Per-session event emitter. */
  emit: EmitFn;
  /** Per-session pending JSON-RPC requests. */
  pending: Map<number, PendingRequest>;
  /** Per-session permission/user-question responders. */
  permissionResponders: Map<string, (optionId: string | null) => void>;
  userQuestionResponders: Map<string, (response: Record<string, unknown>) => void>;
  /** Monotonic request id counter for this session. */
  nextId: number;
  cwd: string;
  disposed: boolean;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

// ---- transport ------------------------------------------------------------

export const ACP_TRANSPORT_ERR_DISABLED = -34001;
export const ACP_TRANSPORT_ERR_NOT_READY = -34002;
export const ACP_TRANSPORT_ERR_SESSION_NOT_FOUND = -34003;
export const ACP_TRANSPORT_ERR_SPAWN = -34004;
export const ACP_TRANSPORT_ERR_WS = -34005;

export class AcpTransportError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "AcpTransportError";
  }
}

/**
 * The shared, process-wide managed transport. One agent serve process,
 * one WebSocket connection, many sessions. The old per-tab AcpSession path
 * remains as the rollback when ACP_MULTI_SESSION=off.
 */
export class AcpTransport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ws: import("ws").WebSocket | null = null;
  private port: number | null = null;
  private secret: string | null = null;
  private nextRequestId = 1;
  private transportPending = new Map<number, PendingRequest>();
  private sessionsByUi = new Map<string, ManagedSession>();
  private sessionsByAgent = new Map<string, ManagedSession>();
  private capabilities: CapabilityNegotiationResult | null = null;
  private ready = false;
  private connecting = false;
  private disposed = false;
  private readonly agentBin: string;
  /** Backpressure: if the agent sends faster than the renderer can drain,
   *  queued events are coalesced rather than dropped. */
  private eventQueue = new Map<string, Record<string, unknown>[]>();
  private maxQueuePerSession = 1000;

  constructor() {
    this.agentBin = this.resolveAgentBinary();
  }

  /** Whether the multi-session transport is enabled (not rolled back). */
  static enabled(): boolean {
    return process.env.ACP_MULTI_SESSION !== "off";
  }

  /** Spawn the agent serve process and establish the WebSocket connection.
   *  Resolves once initialize + authenticate have completed. */
  async connect(): Promise<void> {
    if (this.ready || this.connecting || this.disposed) return;
    this.connecting = true;
    try {
      await this.spawnServe();
      await this.connectWs();
      await this.handshake();
      this.ready = true;
      this.connecting = false;
    } catch (e) {
      this.connecting = false;
      await this.kill();
      throw e;
    }
  }

  isReady(): boolean {
    return this.ready && !this.disposed && this.ws !== null;
  }

  getCapabilities(): CapabilityNegotiationResult | null {
    return this.capabilities;
  }

  /** Create a new session on the shared transport. */
  async createSession(uiId: string, cwd: string, emit: EmitFn, envKeys: string[] = []): Promise<string> {
    if (!this.isReady()) await this.connect();
    if (!this.isReady()) throw new AcpTransportError(ACP_TRANSPORT_ERR_NOT_READY, "transport not ready");

    const session: ManagedSession = {
      uiId,
      agentSessionId: "",
      emit,
      pending: new Map(),
      permissionResponders: new Map(),
      userQuestionResponders: new Map(),
      nextId: 1,
      cwd: path.resolve(cwd || "."),
      disposed: false,
    };
    this.sessionsByUi.set(uiId, session);

    const resp = (await this.request("session/new", {
      cwd: session.cwd,
      mcpServers: [],
    })) as { sessionId?: string; models?: { availableModels?: { modelId: string; name: string }[]; currentModelId?: string } };
    session.agentSessionId = resp.sessionId ?? "";
    if (session.agentSessionId) {
      this.sessionsByAgent.set(session.agentSessionId, session);
    }
    session.emit({
      session_id: uiId,
      type: "SessionReady",
      acp_session_id: session.agentSessionId,
      models: (resp.models?.availableModels ?? []).map((m) => ({ id: m.modelId, name: m.name })),
      currentModel: resp.models?.currentModelId ?? "",
    });
    return session.agentSessionId;
  }

  /** Resume a persisted session on the shared transport. */
  async loadSession(uiId: string, agentSessionId: string, cwd: string, emit: EmitFn, envKeys: string[] = []): Promise<string> {
    if (!this.isReady()) await this.connect();
    if (!this.isReady()) throw new AcpTransportError(ACP_TRANSPORT_ERR_NOT_READY, "transport not ready");

    const session: ManagedSession = {
      uiId,
      agentSessionId,
      emit,
      pending: new Map(),
      permissionResponders: new Map(),
      userQuestionResponders: new Map(),
      nextId: 1,
      cwd: path.resolve(cwd || "."),
      disposed: false,
    };
    this.sessionsByUi.set(uiId, session);

    const resp = (await this.request("session/load", {
      sessionId: agentSessionId,
      cwd: session.cwd,
      mcpServers: [],
    })) as { sessionId?: string; models?: { availableModels?: { modelId: string; name: string }[]; currentModelId?: string } };
    if (resp.sessionId) {
      // The agent may assign a new sessionId on load.
      this.sessionsByAgent.set(resp.sessionId, session);
      session.agentSessionId = resp.sessionId;
    } else {
      this.sessionsByAgent.set(agentSessionId, session);
    }
    return session.agentSessionId;
  }

  /** Send a prompt to a specific session. */
  async prompt(uiId: string, message: string, images: { data: string; mime_type: string }[] = []): Promise<void> {
    const session = this.sessionsByUi.get(uiId);
    if (!session) throw new AcpTransportError(ACP_TRANSPORT_ERR_SESSION_NOT_FOUND, `session ${uiId} not found`);
    const blocks: Record<string, unknown>[] = [];
    if (message) blocks.push({ type: "text", text: message });
    for (const img of images) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mime_type });
    }
    try {
      await this.sessionRequest(session, "session/prompt", {
        sessionId: session.agentSessionId,
        prompt: blocks,
        _meta: { promptId: randomUUID(), screenMode: "desktop" },
      });
      session.emit({ session_id: uiId, type: "TurnComplete" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      session.emit({ session_id: uiId, type: "Error", message: msg });
      throw e;
    }
  }

  /** Cancel one session without affecting others. */
  cancel(uiId: string): void {
    const session = this.sessionsByUi.get(uiId);
    if (!session) return;
    // session/cancel is a notification — does not affect other sessions.
    this.notify("session/cancel", { sessionId: session.agentSessionId });
  }

  /** Close a specific session. When the last session closes, the transport
   *  reclaims the process and connection (issue requirement). */
  async closeSession(uiId: string): Promise<void> {
    const session = this.sessionsByUi.get(uiId);
    if (!session) return;
    session.disposed = true;
    try {
      this.notify("session/close", { sessionId: session.agentSessionId });
    } catch { /* best-effort */ }
    this.sessionsByAgent.delete(session.agentSessionId);
    this.sessionsByUi.delete(uiId);
    this.eventQueue.delete(uiId);
    // If this was the last session, reclaim the transport's resources.
    if (this.sessionsByUi.size === 0) {
      await this.kill();
    }
  }

  /** Respond to a permission request on a specific session. */
  respondPermission(uiId: string, requestId: string, optionId: string | null): void {
    const session = this.sessionsByUi.get(uiId);
    if (!session) return;
    const responder = session.permissionResponders.get(requestId);
    if (responder) {
      session.permissionResponders.delete(requestId);
      responder(optionId);
    }
  }

  respondUserQuestion(uiId: string, requestId: string, response: Record<string, unknown>): void {
    const session = this.sessionsByUi.get(uiId);
    if (!session) return;
    const responder = session.userQuestionResponders.get(requestId);
    if (responder) {
      session.userQuestionResponders.delete(requestId);
      responder(response);
    }
  }

  async setModel(uiId: string, modelId: string): Promise<void> {
    const session = this.sessionsByUi.get(uiId);
    if (!session) throw new AcpTransportError(ACP_TRANSPORT_ERR_SESSION_NOT_FOUND, `session ${uiId} not found`);
    await this.sessionRequest(session, "session/set_model", {
      sessionId: session.agentSessionId,
      modelId,
    });
  }

  /** Dispose the transport entirely — kill the process, close the socket. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.ready = false;
    for (const session of this.sessionsByUi.values()) {
      session.disposed = true;
      session.emit({ session_id: session.uiId, type: "Error", message: "Transport disposed" });
    }
    this.sessionsByUi.clear();
    this.sessionsByAgent.clear();
    await this.kill();
  }

  /** Active session count — for the resource-cleanup invariant. */
  sessionCount(): number {
    return this.sessionsByUi.size;
  }

  // ---- internals ---------------------------------------------------------

  private resolveAgentBinary(): string {
    if (process.env.GROK_AGENT_BIN) return process.env.GROK_AGENT_BIN;
    try {
      if (app?.isPackaged) {
        const bundled = path.join(process.resourcesPath, "xai-grok-pager");
        if (fs.existsSync(bundled)) return bundled;
      }
    } catch { /* app not ready */ }
    let appPath = process.cwd();
    try { appPath = app.getAppPath(); } catch { /* keep cwd */ }
    const release = path.join(appPath, "target", "release", "xai-grok-pager");
    const debug = path.join(appPath, "target", "debug", "xai-grok-pager");
    if (fs.existsSync(release)) return release;
    if (fs.existsSync(debug)) return debug;
    return "xai-grok-pager";
  }

  private async spawnServe(): Promise<void> {
    // Find a free loopback port.
    this.port = await this.findFreePort();
    this.secret = randomUUID();
    const args = [
      "agent", "serve",
      "--bind", `127.0.0.1:${this.port}`,
      "--secret", this.secret,
    ];
    const env = { ...process.env, ...readKeyStore() };
    this.proc = spawn(this.agentBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    this.proc.stderr?.on("data", (c: Buffer) => {
      const s = c.toString("utf-8").trim();
      if (s) console.error(`[acp-transport] stderr: ${s.slice(0, 300)}`);
    });
    this.proc.on("error", (e) => {
      console.error("[acp-transport] process error:", e);
    });
    this.proc.on("exit", (code, signal) => {
      console.error(`[acp-transport] exited code=${code} signal=${signal}`);
      if (!this.disposed && this.ready) {
        // The agent died unexpectedly — surface to all sessions and mark
        // not-ready so the next call reconnects.
        this.ready = false;
        for (const session of this.sessionsByUi.values()) {
          session.emit({ session_id: session.uiId, type: "Error", message: "Agent process exited" });
        }
      }
    });
    // Wait for the server to be listening.
    await this.waitForPort(this.port, 5000);
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (typeof addr === "object" && addr) {
          const p = addr.port;
          srv.close(() => resolve(p));
        } else {
          reject(new Error("could not find a free port"));
        }
      });
    });
  }

  private waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const sock = net.createConnection({ host: "127.0.0.1", port, timeout: 500 });
        sock.on("connect", () => { sock.destroy(); resolve(); });
        sock.on("error", () => {
          if (Date.now() > deadline) reject(new AcpTransportError(ACP_TRANSPORT_ERR_SPAWN, `agent serve did not listen on port ${port}`));
          else setTimeout(attempt, 100);
        });
        sock.on("timeout", () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new AcpTransportError(ACP_TRANSPORT_ERR_SPAWN, `agent serve did not listen on port ${port}`));
          else setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  private async connectWs(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?server-key=${this.secret}`);
      const timer = setTimeout(() => {
        reject(new AcpTransportError(ACP_TRANSPORT_ERR_WS, "WebSocket connect timeout"));
      }, 5000);
      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        ws.on("message", (data: Buffer) => this.onMessage(data.toString("utf-8")));
        ws.on("close", () => {
          if (!this.disposed) {
            this.ready = false;
            for (const session of this.sessionsByUi.values()) {
              session.emit({ session_id: session.uiId, type: "Error", message: "Transport connection closed" });
            }
          }
        });
        ws.on("error", (e: Error) => {
          console.error("[acp-transport] ws error:", e.message);
        });
        resolve();
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(new AcpTransportError(ACP_TRANSPORT_ERR_WS, `WebSocket error: ${e.message}`));
      });
    });
  }

  private async handshake(): Promise<void> {
    const initResp = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })) as {
      protocolVersion?: number;
      agentCapabilities?: Record<string, unknown>;
      authMethods?: { id: string; name?: string }[];
      _meta?: { defaultAuthMethodId?: string };
    };

    // Typed capability negotiation: parse what we know, flag the rest.
    this.capabilities = this.negotiateCapabilities(initResp?.agentCapabilities ?? {});

    // Authenticate (once for the whole transport).
    const authMethods = initResp?.authMethods ?? [];
    if (authMethods.length > 0) {
      const defaultId = initResp?._meta?.defaultAuthMethodId;
      const pick =
        (defaultId && authMethods.find((m) => m.id === defaultId)) ||
        authMethods.find((m) => m.id.toLowerCase().includes("api_key")) ||
        authMethods.find((m) => m.id.toLowerCase().includes("cached")) ||
        authMethods[0];
      await this.request("authenticate", { methodId: pick.id });
    }
  }

  private negotiateCapabilities(raw: Record<string, unknown>): CapabilityNegotiationResult {
    const known: AgentCapabilities = {
      loadSession: Boolean((raw as { loadSession?: boolean }).loadSession),
      promptImage: Boolean((raw as { promptCapabilities?: { image?: boolean } }).promptCapabilities?.image),
      promptAudio: Boolean((raw as { promptCapabilities?: { audio?: boolean } }).promptCapabilities?.audio),
      promptEmbeddedContext: Boolean((raw as { promptCapabilities?: { embeddedContext?: boolean } }).promptCapabilities?.embeddedContext),
      mcpHttp: Boolean((raw as { mcpCapabilities?: { http?: boolean } }).mcpCapabilities?.http),
      mcpSse: Boolean((raw as { mcpCapabilities?: { sse?: boolean } }).mcpCapabilities?.sse),
      sessionList: Boolean((raw as { sessionCapabilities?: { list?: {} } }).sessionCapabilities?.list),
      sessionResume: Boolean((raw as { sessionCapabilities?: { resume?: {} } }).sessionCapabilities?.resume),
      sessionClose: Boolean((raw as { sessionCapabilities?: { close?: {} } }).sessionCapabilities?.close),
      raw,
    };
    // Detect unknown capabilities — keys we didn't type.
    const knownKeys = new Set([
      "loadSession", "promptCapabilities", "mcpCapabilities", "sessionCapabilities", "auth", "_meta",
    ]);
    const unknown = Object.keys(raw).filter((k) => !knownKeys.has(k));
    // Capabilities we requested that the agent did not advertise.
    const requested = ["fs.readTextFile", "fs.writeTextFile", "terminal"];
    const unsupported: string[] = [];
    // terminal is always false (we set it); flag if the agent didn't echo.
    // (The agent's own capabilities don't include terminal, so this is informational.)
    return { capabilities: known, unknown, unsupported };
  }

  private onMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`[acp-transport] non-JSON message: ${line.slice(0, 200)}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = msg.method as string | undefined;
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);

    // Response to a transport-level request (initialize, authenticate).
    if (hasId && !method) {
      const p = this.transportPending.get(id);
      if (p) {
        this.transportPending.delete(id);
        if (msg.error) {
          const e = msg.error as { code: number; message: string };
          p.reject(new Error(`${p.method} failed: ${e.message ?? JSON.stringify(e)}`));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Response to a session-level request.
    if (hasId && method === undefined) {
      // This branch is unreachable — responses have no method.
    }

    // Request from agent (session/request_permission, fs/read_text_file, etc.)
    if (hasId && method) {
      this.onAgentRequest(id, method, msg.params as Record<string, unknown>);
      return;
    }

    // Notification from agent (session/update, etc.)
    if (!hasId && method) {
      this.onAgentNotification(method, msg.params as Record<string, unknown>);
      return;
    }
  }

  private onAgentRequest(id: number, method: string, params: Record<string, unknown>): void {
    const agentSessionId = (params?.sessionId ?? params?.session_id) as string | undefined;
    const session = agentSessionId ? this.sessionsByAgent.get(agentSessionId) : undefined;

    switch (method) {
      case "session/request_permission": {
        if (!session) { this.respondError(id, -32602, "session not found"); return; }
        const requestId = randomUUID();
        const toolCall = (params?.toolCall ?? {}) as { title?: string };
        const options = ((params?.options ?? []) as { optionId: string; name: string; kind: string }[]).map(
          (o) => ({ id: o.optionId, label: o.name, kind: snakeToPascal(o.kind ?? "") })
        );
        const command =
          ((params?.options ?? []) as { name: string; kind: string }[]).find((o) => o.kind === "allow_once")
            ?.name ?? "";
        session.permissionResponders.set(requestId, (optionId) => {
          if (optionId === null) {
            this.respond(id, { outcome: { outcome: "cancelled" } });
          } else {
            this.respond(id, { outcome: { outcome: "selected", optionId } });
          }
        });
        permissionStateMachine.request({
          requestId,
          sessionId: session.uiId,
          toolName: toolCall.title ?? "Unknown",
          command,
        });
        session.emit({
          session_id: session.uiId,
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
        if (!session) { this.respondError(id, -32602, "session not found"); return; }
        const requestId = randomUUID();
        session.userQuestionResponders.set(requestId, (response) => {
          this.respond(id, response);
        });
        session.emit({
          session_id: session.uiId,
          type: "UserQuestionRequest",
          request_id: requestId,
          questions: (params?.questions ?? []) as unknown[],
          mode: (params?.mode as string) ?? "default",
        });
        break;
      }
      case "fs/read_text_file": {
        this.bridgeFsCall(id, method, session, () =>
          bridgeReadTextFile(session?.cwd ?? process.cwd(), params as ReadParams)
        );
        break;
      }
      case "fs/write_text_file": {
        this.bridgeFsCall(id, method, session, async () => {
          if (!session) throw new FsBridgeError(FS_ERR_IO, "no session");
          await bridgeWriteTextFile(session.cwd, session.uiId, params as WriteParams);
          return null;
        });
        break;
      }
      default:
        this.respondError(id, -32601, `Method not supported by transport: ${method}`);
    }
  }

  private bridgeFsCall(
    id: number,
    method: string,
    session: ManagedSession | undefined,
    op: () => Promise<unknown>
  ): void {
    op()
      .then((result) => this.respond(id, result))
      .catch((e) => {
        if (e instanceof FsBridgeError) {
          this.respondError(id, e.code, e.message);
        } else {
          this.respondError(id, FS_ERR_IO, `${method} failed: ${e?.message ?? e}`);
        }
      });
  }

  private onAgentNotification(method: string, params: Record<string, unknown>): void {
    if (method === "session/update") {
      const meta = (params?._meta ?? {}) as { isReplay?: boolean };
      const sessionId = (params?.sessionId ?? params?.session_id) as string | undefined;
      const session = sessionId ? this.sessionsByAgent.get(sessionId) : undefined;
      if (!session) return; // event for an unknown session — drop, no cross-talk
      this.onSessionUpdate(session, (params?.update ?? params) as Record<string, unknown>, !!meta.isReplay);
      return;
    }
    if (method === "x.ai/session_notification" || method === "x.ai/session/update") {
      const sessionId = (params?.sessionId ?? params?.session_id) as string | undefined;
      const session = sessionId ? this.sessionsByAgent.get(sessionId) : undefined;
      if (!session) return;
      this.onExtSessionNotification(session, params);
      return;
    }
    // Other notifications (e.g. _x.ai/mcp/servers_updated) are transport-level;
    // they don't carry a sessionId and are not routed to any session.
  }

  private onSessionUpdate(session: ManagedSession, update: Record<string, unknown>, replay: boolean): void {
    const kind = update.sessionUpdate as string | undefined;
    const uiId = session.uiId;
    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.enqueueEvent(uiId, { session_id: uiId, type: "TextDelta", delta: content.text, replay });
        }
        break;
      }
      case "user_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (replay && content?.type === "text" && content.text) {
          this.enqueueEvent(uiId, { session_id: uiId, type: "UserMessage", text: content.text, replay });
        }
        break;
      }
      case "tool_call": {
        this.enqueueEvent(uiId, { session_id: uiId, type: "ToolCall", tool_name: (update.title as string) ?? "", replay });
        break;
      }
      case "tool_call_update": {
        const status = update.status as string | undefined;
        if (status === "completed" || status === "failed") {
          const contentArr = (update.content ?? []) as unknown[];
          this.enqueueEvent(uiId, {
            session_id: uiId,
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
          (e) => ({ content: e.content, status: snakeToPascal(e.status ?? ""), priority: snakeToPascal(e.priority ?? "") })
        );
        this.enqueueEvent(uiId, { session_id: uiId, type: "PlanUpdate", entries, replay });
        break;
      }
      case "usage_update": {
        this.enqueueEvent(uiId, { session_id: uiId, type: "UsageUpdate", used: update.used as number, size: update.size as number });
        break;
      }
    }
  }

  private onExtSessionNotification(session: ManagedSession, params: Record<string, unknown>): void {
    const uiId = session.uiId;
    const updateType = params.sessionUpdate as string | undefined;
    switch (updateType) {
      case "auto_compact_started":
        this.enqueueEvent(uiId, { session_id: uiId, type: "CompactionStatus", compaction_status: "started", compaction_tokens_before: (params.tokens_used as number) ?? null });
        break;
      case "auto_compact_completed":
        this.enqueueEvent(uiId, { session_id: uiId, type: "CompactionStatus", compaction_status: "completed", compaction_tokens_before: (params.tokens_before as number) ?? null, compaction_tokens_after: (params.tokens_after as number) ?? null, compaction_summary: (params.summary_preview as string) ?? null });
        break;
      case "auto_compact_failed":
        this.enqueueEvent(uiId, { session_id: uiId, type: "CompactionStatus", compaction_status: "failed", compaction_error: (params.error as string) ?? null });
        break;
      case "auto_compact_cancelled":
        this.enqueueEvent(uiId, { session_id: uiId, type: "CompactionStatus", compaction_status: "cancelled" });
        break;
      default:
        // Unknown ext notification — surface as a generic notification.
        break;
    }
  }

  /** Backpressure: coalesce events per session instead of dropping them.
   *  Each event is flushed immediately (setImmediate) — the queue is a
   *  safety valve, not a delay. */
  private enqueueEvent(uiId: string, event: Record<string, unknown>): void {
    const session = this.sessionsByUi.get(uiId);
    if (!session || session.disposed) return;
    const q = this.eventQueue.get(uiId) ?? [];
    if (q.length >= this.maxQueuePerSession) {
      // Drop the oldest to make room — never silently drop the newest
      // (the newest carries the current state).
      q.shift();
    }
    q.push(event);
    this.eventQueue.set(uiId, q);
    // Flush immediately.
    setImmediate(() => {
      const queue = this.eventQueue.get(uiId);
      if (!queue) return;
      this.eventQueue.delete(uiId);
      for (const e of queue) {
        const s = this.sessionsByUi.get(uiId);
        if (s && !s.disposed) s.emit(e);
      }
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.transportRequest(method, params);
  }

  private sessionRequest(session: ManagedSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.transportRequest(method, params);
  }

  private transportRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
        reject(new AcpTransportError(ACP_TRANSPORT_ERR_NOT_READY, "transport not connected"));
        return;
      }
      const id = this.nextRequestId++;
      this.transportPending.set(id, { method, resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.ws.send(msg, (err) => {
        if (err) {
          this.transportPending.delete(id);
          reject(new AcpTransportError(ACP_TRANSPORT_ERR_WS, `send failed: ${err.message}`));
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private respond(id: number, result: unknown): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(id: number, code: number, message: string): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private async kill(): Promise<void> {
    this.ready = false;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
      // Give it a moment, then force.
      await new Promise((r) => setTimeout(r, 200));
      try {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      } catch { /* already dead */ }
    }
    this.proc = null;
    this.transportPending.clear();
  }
}

/** Shared transport singleton — constructed lazily so the module can be
 *  imported without spawning a process. */
let sharedTransport: AcpTransport | null = null;

export function getSharedTransport(): AcpTransport {
  if (!sharedTransport) sharedTransport = new AcpTransport();
  return sharedTransport;
}

// ---- helpers --------------------------------------------------------------

function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

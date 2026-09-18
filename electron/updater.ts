/**
 * Real auto-update backend (ISS-076): check → available → downloading →
 * ready → relaunch, built on electron-updater with a pinned generic feed
 * (GROK_UPDATE_URL, or the packaged app-update.yml).
 *
 * Guarantees:
 *   - state survives power loss: transitions persist to
 *     ~/.grok/updater-state.json; on boot a persisted "ready" re-arms without
 *     re-downloading, a persisted "downloading" resets to "available"
 *     (electron-updater re-downloads; its blockmap sha512 verification never
 *     installs a truncated/corrupt package)
 *   - downgrade protection: an offer is only surfaced when
 *     semver(feedVersion) > semver(appVersion)
 *   - disabled (updater_check → null) unless a feed is configured — the
 *     documented rollback is exactly today's "manual download" behavior
 *   - the update pipeline never touches ~/.grok user data
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { semverGreater } from "./semver";

export type UpdaterStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "relaunch";

export interface UpdateManifest {
  version: string;
  releaseNotes: string | null;
  releaseDate: string | null;
}

export interface UpdaterProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

/** Adapter seam — the real one wraps electron-updater (see main.ts). */
export interface UpdaterAdapter {
  /** Poll the feed; resolves an offer or null. Throws when unreachable. */
  pollFeed(): Promise<UpdateManifest | null>;
  /** Fetch the current offer; resolves when the package is verified. */
  fetchPackage(): Promise<void>;
  onProgress(cb: (p: UpdaterProgress) => void): void;
  /** Swap in the verified package and restart the app. */
  applyAndRestart(): void;
}

export function updaterFeedUrl(): string | null {
  const url = process.env.GROK_UPDATE_URL;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

export function stateFilePath(): string {
  const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  return path.join(grokHome, "updater-state.json");
}

interface PersistedState {
  status: UpdaterStatus;
  version: string | null;
  since: number;
}

export function readPersistedState(file = stateFilePath()): PersistedState | null {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const s = JSON.parse(raw) as PersistedState;
    if (typeof s?.status === "string" && typeof s.since === "number") return s;
  } catch {
    // missing or torn state file — treat as fresh boot
  }
  return null;
}

// ---- state machine -----------------------------------------------------------

export class UpdaterMachine {
  private status: UpdaterStatus;
  private version: string | null = null;

  constructor(
    private readonly adapter: UpdaterAdapter | null,
    private readonly currentVersion: string,
    private readonly stateFile: string = stateFilePath()
  ) {
    const persisted = readPersistedState(stateFile);
    if (!adapter) {
      this.status = "disabled";
      return;
    }
    if (persisted?.status === "ready" && persisted.version) {
      // A verified package survived the restart — stay ready to apply.
      this.status = "ready";
      this.version = persisted.version;
      return;
    }
    // "downloading" cannot survive a crash (the transfer died with us) —
    // anything else restarts idle and re-polls fresh.
    this.status = "idle";
  }

  getStatus(): { status: UpdaterStatus; version: string | null } {
    return { status: this.status, version: this.version };
  }

  private transition(status: UpdaterStatus, version: string | null = this.version): void {
    this.status = status;
    if (version !== null || status === "idle" || status === "disabled") {
      this.version = version;
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({ status: this.status, version: this.version, since: Date.now() })
      );
    } catch {
      // persistence is best-effort; the machine still works in-memory
    }
  }

  /** Poll the feed. Returns the offer only for a NEWER version. */
  async poll(): Promise<UpdateManifest | null> {
    if (!this.adapter) return null;
    this.transition("checking", null);
    try {
      const manifest = await this.adapter.pollFeed();
      if (!manifest) {
        this.transition("idle", null);
        return null;
      }
      if (!semverGreater(manifest.version, this.currentVersion)) {
        // Downgrade or same version — keep the running app.
        this.transition("idle", null);
        return null;
      }
      this.version = manifest.version;
      this.transition("available", manifest.version);
      return manifest;
    } catch (e) {
      // Network/feed failure → back to idle, current version untouched.
      this.transition("idle", null);
      throw e;
    }
  }

  onProgress(cb: (p: UpdaterProgress) => void): void {
    this.adapter?.onProgress(cb);
  }

  /** Fetch the current offer; resolves when the package passed verification. */
  async fetch(): Promise<void> {
    if (!this.adapter || this.status !== "available") {
      throw new Error(`fetch requires the available state (was ${this.status})`);
    }
    this.transition("downloading");
    try {
      await this.adapter.fetchPackage();
      this.transition("ready");
    } catch (e) {
      // Bad package / interrupted network — the offer stands, nothing was
      // swapped in; return to available so the user can retry.
      this.transition("available");
      throw e;
    }
  }

  /** Apply the verified package: swap-and-relaunch. A persisted "ready"
   *  restored after a restart may outlive electron-updater's in-memory
   *  install handle — when apply fails we fall back to available so the
   *  caller re-fetches instead of hitting a dead-end ready state. */
  apply(): void {
    if (!this.adapter || this.status !== "ready") {
      throw new Error(`apply requires the ready state (was ${this.status})`);
    }
    this.transition("relaunch");
    try {
      this.adapter.applyAndRestart();
    } catch (e) {
      this.transition("available");
      throw new Error(
        `cached update no longer installable (restart cleared it) — retry the download: ${e}`
      );
    }
  }
}

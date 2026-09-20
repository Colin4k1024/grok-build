/**
 * Real authentication for the desktop shell (ISS-073).
 *
 * Mode resolution:
 *   - GROK_DESKTOP_AUTH=off  → "dev": the old hardcoded dev bypass (rollback)
 *   - OAuth endpoint probe succeeds (GROK_AUTH_URL, default xAI OIDC
 *     discovery) → "oauth" capability advertised to the renderer
 *   - otherwise → "api-key" first-screen validation: the session is
 *     authenticated iff a known provider key resolves from the file store,
 *     the macOS keychain, or the environment.
 *
 * Token storage is the same surface the agent reads: ~/.grok/api_keys.json
 * (0600, atomic tmp+rename writes — a crash mid-login never leaves a torn
 * store) with macOS keychain write-through under the legacy service name.
 * Logout revokes every stored token: file store deleted, keychain entries
 * removed. Environment-provided keys outlive logout by design (we never
 * mutate the parent environment); they are reported as source "env".
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

export type AuthMode = "oauth" | "api-key" | "dev";
export type AuthSource = "file" | "keychain" | "env";

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
  mode: AuthMode;
  oauthAvailable?: boolean;
  source?: AuthSource;
  envKey?: string;
}

/** Env vars this build accepts as provider credentials. */
export const KNOWN_ENV_KEYS = [
  "XAI_API_KEY",
  "GROK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "BIGMODEL_API_KEY",
] as const;

export const KEYCHAIN_SERVICE = "com.xai.grokbuild.desktop";

export function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

export function apiKeyStorePath(): string {
  return path.join(grokHome(), "api_keys.json");
}

// ---- keychain adapter --------------------------------------------------------

export interface KeychainAdapter {
  set(account: string, value: string): Promise<void>;
  find(account: string): Promise<string | null>;
  remove(account: string): Promise<void>;
}

const keychainCache = new Map<string, string | null>();

export const securityKeychain: KeychainAdapter = {
  set(account, value) {
    return new Promise((resolve, reject) => {
      if (process.platform !== "darwin") return resolve();
      execFile(
        "/usr/bin/security",
        ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value],
        { timeout: 8000 },
        (err) => {
          keychainCache.set(account, value);
          if (err) reject(new Error(`keychain write failed: ${err.message}`));
          else resolve();
        }
      );
    });
  },
  find(account) {
    if (keychainCache.has(account)) {
      return Promise.resolve(keychainCache.get(account) ?? null);
    }
    return new Promise((resolve) => {
      if (process.platform !== "darwin") {
        keychainCache.set(account, null);
        return resolve(null);
      }
      execFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { timeout: 8000 },
        (err, stdout) => {
          const value = err ? null : stdout.trim() || null;
          keychainCache.set(account, value);
          resolve(value);
        }
      );
    });
  },
  remove(account) {
    return new Promise((resolve) => {
      keychainCache.delete(account);
      if (process.platform !== "darwin") return resolve();
      execFile(
        "/usr/bin/security",
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
        { timeout: 8000 },
        () => resolve() // "not found" is a successful logout
      );
    });
  },
};

/** Test seam: swap the keychain adapter (stubbed in unit tests). */
export function setKeychainAdapterForTests(adapter: KeychainAdapter | null): void {
  activeKeychain = adapter ?? securityKeychain;
  keychainCache.clear();
}

let activeKeychain: KeychainAdapter = securityKeychain;

// ---- file store (atomic) ------------------------------------------------------

let _keyStoreCache: Record<string, string> | null = null;

export function readKeyStore(storePath = apiKeyStorePath()): Record<string, string> {
  if (_keyStoreCache) return _keyStoreCache;
  try {
    if (fs.existsSync(storePath)) {
      _keyStoreCache = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, string>;
      return _keyStoreCache;
    }
  } catch (e) {
    console.error("[auth] failed to read key store:", e);
  }
  _keyStoreCache = {};
  return _keyStoreCache;
}

function invalidateKeyStoreCache(): void {
  _keyStoreCache = null;
}

/** Atomic write: tmp file + rename, so a crash mid-login leaves the previous
 *  store intact and never a torn/partial one. */
export function writeKeyStoreAtomic(
  store: Record<string, string>,
  storePath = apiKeyStorePath()
): void {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.api_keys.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  invalidateKeyStoreCache();
}

// ---- auth state ----------------------------------------------------------------

export function maskKey(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 2)}…${value.slice(-4)}`;
}

function lookupKey(envKey: string): { value: string; source: AuthSource } | null {
  const fromFile = readKeyStore()[envKey];
  if (typeof fromFile === "string" && fromFile.length > 0) {
    return { value: fromFile, source: "file" };
  }
  const fromEnv = process.env[envKey];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { value: fromEnv, source: "env" };
  }
  return null; // keychain hits are async — surfaced via checkAuthStatus
}

export interface CheckDeps {
  keychain?: KeychainAdapter;
  oauthFetch?: typeof fetch | null;
}

export async function probeOAuth(
  fetchImpl: typeof fetch,
  url = process.env.GROK_AUTH_URL || "https://auth.x.ai/.well-known/openid-configuration",
  timeoutMs = 3000
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function checkAuthStatus(deps: CheckDeps = {}): Promise<AuthStatus> {
  if (process.env.GROK_DESKTOP_AUTH === "off") {
    return { authenticated: true, username: "dev", mode: "dev", oauthAvailable: false };
  }

  const keychain = deps.keychain ?? activeKeychain;
  let oauthAvailable = false;
  if (deps.oauthFetch) {
    oauthAvailable = await probeOAuth(deps.oauthFetch);
  }

  for (const envKey of KNOWN_ENV_KEYS) {
    const hit = lookupKey(envKey);
    if (hit) {
      return {
        authenticated: true,
        username: `${envKey} (${maskKey(hit.value)})`,
        mode: "api-key",
        oauthAvailable,
        source: hit.source,
        envKey,
      };
    }
    const kc = await keychain.find(envKey);
    if (kc) {
      return {
        authenticated: true,
        username: `${envKey} (${maskKey(kc)})`,
        mode: "api-key",
        oauthAvailable,
        source: "keychain",
        envKey,
      };
    }
  }
  return { authenticated: false, username: null, mode: "api-key", oauthAvailable };
}

// ---- login / logout --------------------------------------------------------------

/** Minimal provider-side format checks: an arbitrary string must not pass
 *  as a credential. Real validation still happens on first agent use; these
 *  rules reject obvious garbage before anything is persisted. */
const KEY_FORMAT_RULES: Record<string, { minLen: number; pattern?: RegExp }> = {
  XAI_API_KEY: { minLen: 20, pattern: /^xai-[A-Za-z0-9_-]+$/ },
  OPENAI_API_KEY: { minLen: 20, pattern: /^sk-[A-Za-z0-9_-]+$/ },
  ANTHROPIC_API_KEY: { minLen: 20, pattern: /^sk-ant-[A-Za-z0-9_-]+$/ },
  OPENROUTER_API_KEY: { minLen: 20, pattern: /^sk-or-[A-Za-z0-9_-]+$/ },
};

export function apiKeyLooksValid(envKey: string, value: string): boolean {
  const rule = KEY_FORMAT_RULES[envKey];
  const v = value.trim();
  if (!rule) return v.length >= 20; // unknown providers: length floor only
  if (v.length < rule.minLen) return false;
  if (rule.pattern && !rule.pattern.test(v)) return false;
  return true;
}

export async function loginWithApiKey(
  envKey: string,
  value: string,
  deps: { keychain?: KeychainAdapter; storePath?: string } = {}
): Promise<AuthStatus> {
  if (!KNOWN_ENV_KEYS.includes(envKey as (typeof KNOWN_ENV_KEYS)[number])) {
    throw new Error(`unknown env key: ${envKey}`);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("api key must be a non-empty string");
  }
  if (!apiKeyLooksValid(envKey, value)) {
    throw new Error(`value does not look like a valid ${envKey} key (format/length check failed)`);
  }
  const keychain = deps.keychain ?? activeKeychain;
  const storePath = deps.storePath ?? apiKeyStorePath();

  const store = readKeyStore(storePath);
  store[envKey] = value.trim();
  writeKeyStoreAtomic(store, storePath);

  // Write-through: mirror into the keychain; a failure is non-fatal (the
  // file store is the agent's source of truth) but must be visible.
  try {
    await keychain.set(envKey, value.trim());
  } catch (e) {
    console.error("[auth] keychain write-through failed:", e);
  }

  return {
    authenticated: true,
    username: `${envKey} (${maskKey(value.trim())})`,
    mode: "api-key",
    source: "file",
    envKey,
  };
}

export interface LogoutResult {
  revokedFileKeys: string[];
  revokedKeychainKeys: string[];
  envKeysRemaining: string[];
}

export async function logoutAuth(
  deps: { keychain?: KeychainAdapter; storePath?: string } = {}
): Promise<LogoutResult> {
  const keychain = deps.keychain ?? activeKeychain;
  const storePath = deps.storePath ?? apiKeyStorePath();

  const store = readKeyStore(storePath);
  const revokedFileKeys = Object.keys(store);

  // Revoke every token we own: keychain entries for all known keys, then the
  // plaintext store file itself — logout leaves no api_keys.json residue.
  const revokedKeychainKeys: string[] = [];
  for (const envKey of KNOWN_ENV_KEYS) {
    try {
      await keychain.remove(envKey);
      if (store[envKey] || revokedFileKeys.includes(envKey)) revokedKeychainKeys.push(envKey);
    } catch {
      /* keychain removal is best-effort */
    }
  }

  try {
    fs.rmSync(storePath, { force: true });
    invalidateKeyStoreCache();
  } catch (e) {
    console.error("[auth] failed to remove key store:", e);
  }

  const envKeysRemaining = KNOWN_ENV_KEYS.filter((k) => {
    const v = process.env[k];
    return typeof v === "string" && v.length > 0;
  });

  return { revokedFileKeys, revokedKeychainKeys, envKeysRemaining };
}

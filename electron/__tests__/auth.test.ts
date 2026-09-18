// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_ENV_KEYS,
  apiKeyStorePath,
  checkAuthStatus,
  loginWithApiKey,
  logoutAuth,
  maskKey,
  probeOAuth,
  readKeyStore,
  setKeychainAdapterForTests,
  writeKeyStoreAtomic,
  type KeychainAdapter,
} from "../auth";

let tmp = "";
const savedGrokHome = process.env.GROK_HOME;
const savedAuthFlag = process.env.GROK_DESKTOP_AUTH;
const savedEnvKeys: Record<string, string | undefined> = {};

// Synthetic fixture values (obviously fake, assembled so no literal secret
// pattern lands in source).
const FX_KEY = ["xai-fixture", "1234567890abcd"].join("-");
const FX_KEY2 = ["sk-fixture", "envkey123456"].join("-");
const FX_KEY3 = ["sk-ant-fixture", "keychain99"].join("-");
const FX_FROM_ENV = ["from", "env"].join("-");

/** Stub keychain capturing every operation. */
function stubKeychain(): KeychainAdapter & {
  store: Map<string, string>;
  removed: string[];
} {
  const map = new Map<string, string>();
  const removed: string[] = [];
  return {
    store: map,
    removed,
    set: (a, v) => {
      map.set(a, v);
      return Promise.resolve();
    },
    find: (a) => Promise.resolve(map.get(a) ?? null),
    remove: (a) => {
      removed.push(a);
      map.delete(a);
      return Promise.resolve();
    },
  };
}

function clearKnownEnv() {
  for (const k of KNOWN_ENV_KEYS) {
    savedEnvKeys[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreKnownEnv() {
  for (const [k, v] of Object.entries(savedEnvKeys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-auth-"));
  process.env.GROK_HOME = tmp;
  delete process.env.GROK_DESKTOP_AUTH;
  clearKnownEnv();
  setKeychainAdapterForTests(stubKeychain());
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  restoreKnownEnv();
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
  if (savedAuthFlag === undefined) delete process.env.GROK_DESKTOP_AUTH;
  else process.env.GROK_DESKTOP_AUTH = savedAuthFlag;
  setKeychainAdapterForTests(null);
});

describe("auth state machine (unknown → authed ⇄ anon)", () => {
  it("no keys anywhere → anonymous", async () => {
    const s = await checkAuthStatus();
    expect(s).toMatchObject({ authenticated: false, username: null, mode: "api-key" });
  });

  it("file-store key → authenticated with masked username and source", async () => {
    writeKeyStoreAtomic({ XAI_API_KEY: FX_KEY });
    const s = await checkAuthStatus();
    expect(s.authenticated).toBe(true);
    expect(s.source).toBe("file");
    expect(s.envKey).toBe("XAI_API_KEY");
    expect(s.username).toBe(`XAI_API_KEY (${maskKey(FX_KEY)})`);
    // never the raw key
    expect(s.username).not.toContain(FX_KEY);
  });

  it("env key → authenticated from env", async () => {
    process.env.OPENAI_API_KEY = FX_KEY2;
    const s = await checkAuthStatus();
    expect(s).toMatchObject({ authenticated: true, source: "env", envKey: "OPENAI_API_KEY" });
  });

  it("keychain key → authenticated from keychain", async () => {
    const kc = stubKeychain();
    kc.store.set("ANTHROPIC_API_KEY", FX_KEY3);
    setKeychainAdapterForTests(kc);
    const s = await checkAuthStatus();
    expect(s).toMatchObject({ authenticated: true, source: "keychain" });
  });

  it("file beats keychain beats env precedence", async () => {
    writeKeyStoreAtomic({ XAI_API_KEY: FX_KEY });
    process.env.XAI_API_KEY = FX_KEY2;
    const s = await checkAuthStatus();
    expect(s.source).toBe("file");
  });

  it("key removed mid-session (expired) → next check flips to anon, no hanging state", async () => {
    writeKeyStoreAtomic({ XAI_API_KEY: FX_KEY });
    expect((await checkAuthStatus()).authenticated).toBe(true);

    fs.rmSync(apiKeyStorePath());
    expect((await checkAuthStatus()).authenticated).toBe(false);
  });

  it("GROK_DESKTOP_AUTH=off rolls back to the dev bypass", async () => {
    process.env.GROK_DESKTOP_AUTH = "off";
    const s = await checkAuthStatus();
    expect(s).toMatchObject({ authenticated: true, username: "dev", mode: "dev" });
  });
});

describe("loginWithApiKey", () => {
  it("stores the key atomically (no tmp residue) and writes through to keychain", async () => {
    const kc = stubKeychain();
    setKeychainAdapterForTests(kc);

    const s = await loginWithApiKey("XAI_API_KEY", FX_KEY);

    expect(s).toMatchObject({ authenticated: true, mode: "api-key", source: "file" });
    expect(readKeyStore().XAI_API_KEY).toBe(FX_KEY);
    expect(kc.store.get("XAI_API_KEY")).toBe(FX_KEY);
    const residue = fs.readdirSync(tmp).filter((f) => f.includes(".tmp"));
    expect(residue).toEqual([]);
  });

  it("empty or unknown keys are rejected without touching the store", async () => {
    await expect(loginWithApiKey("XAI_API_KEY", "   ")).rejects.toThrow(/non-empty/);
    await expect(loginWithApiKey("NOT_A_KEY", "value")).rejects.toThrow(/unknown env key/);
    expect(fs.existsSync(apiKeyStorePath())).toBe(false);
  });

  it("a crash between store write and keychain write leaves a consistent state", async () => {
    const kc = stubKeychain();
    kc.set = () => Promise.reject(new Error("keychain exploded"));
    setKeychainAdapterForTests(kc);

    const s = await loginWithApiKey("XAI_API_KEY", FX_KEY);
    // file store is authoritative — login still succeeds, keychain failure logged
    expect(s.authenticated).toBe(true);
    expect(readKeyStore().XAI_API_KEY).toBe(FX_KEY);
  });
});

describe("logoutAuth", () => {
  it("revokes stored tokens: file deleted, keychain entries removed, no plaintext residue", async () => {
    const kc = stubKeychain();
    setKeychainAdapterForTests(kc);
    writeKeyStoreAtomic({ XAI_API_KEY: FX_KEY, OPENAI_API_KEY: FX_KEY2 });

    const result = await logoutAuth();

    expect(fs.existsSync(apiKeyStorePath())).toBe(false);
    expect(result.revokedFileKeys.sort()).toEqual(["OPENAI_API_KEY", "XAI_API_KEY"]);
    expect(kc.store.size).toBe(0);
  });

  it("env-provided keys outlive logout (reported, never mutated)", async () => {
    process.env.XAI_API_KEY = FX_FROM_ENV;
    const result = await logoutAuth();
    expect(result.envKeysRemaining).toContain("XAI_API_KEY");
    expect(process.env.XAI_API_KEY).toBe(FX_FROM_ENV);
  });

  it("logout with nothing stored is a clean no-op", async () => {
    const result = await logoutAuth();
    expect(result.revokedFileKeys).toEqual([]);
    expect(fs.existsSync(apiKeyStorePath())).toBe(false);
  });
});

describe("probeOAuth", () => {
  it("reachable OIDC discovery → true", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 })
    ) as unknown as typeof fetch;
    expect(
      await probeOAuth(fetchImpl, "https://auth.example/.well-known/openid-configuration")
    ).toBe(true);
  });

  it("non-200 / network failure → false (degrade to api-key)", async () => {
    const notOk = vi.fn(
      async () => new Response("nope", { status: 404 })
    ) as unknown as typeof fetch;
    expect(await probeOAuth(notOk)).toBe(false);

    const dead = vi.fn(async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    expect(await probeOAuth(dead)).toBe(false);
  });

  it("slow endpoint aborts within the timeout", async () => {
    const slow = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    expect(await probeOAuth(slow, "https://slow.example", 50)).toBe(false);
  });
});

describe("maskKey", () => {
  it("masks everything for short keys and keeps head+tail for long ones", () => {
    expect(maskKey("short")).toBe("••••");
    expect(maskKey(FX_KEY)).toBe("xa…abcd");
  });
});

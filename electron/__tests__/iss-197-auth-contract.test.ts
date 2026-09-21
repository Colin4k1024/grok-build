// @vitest-environment node
/**
 * Auth contract tests (R3-12 / #197).
 * Proves: format validation, keychain lifecycle, logout semantics, maskKey,
 * checkAuthStatus structured result.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_ENV_KEYS,
  apiKeyStorePath,
  apiKeyLooksValid,
  checkAuthStatus,
  invalidateKeyStoreCache,
  loginWithApiKey,
  logoutAuth,
  maskKey,
  readKeyStore,
  setKeychainAdapterForTests,
  writeKeyStoreAtomic,
  type KeychainAdapter,
} from "../auth";

let tmp = "";
let savedGrokHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-auth-197-"));
  savedGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tmp;
  invalidateKeyStoreCache();
  const store = new Map<string, string>();
  const mockKeychain: KeychainAdapter = {
    async find(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async remove(k: string) { store.delete(k); },
    name: "mock-keychain",
  };
  setKeychainAdapterForTests(mockKeychain);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
  invalidateKeyStoreCache();
  setKeychainAdapterForTests(null as never);
});

describe("format validation (R3-12 #197)", () => {
  it("empty key is rejected", () => {
    expect(apiKeyLooksValid("OPENAI_API_KEY", "").ok).toBe(false);
  });
  it("too-short key is rejected", () => {
    const r = apiKeyLooksValid("OPENAI_API_KEY", "sk-abc");
    expect(r.ok).toBe(false);
  });
  it("wrong-format key is rejected (sk- for ANTHROPIC)", () => {
    const r = apiKeyLooksValid("ANTHROPIC_API_KEY", "sk-wrongformatkey1234567890abcdef");
    expect(r.ok).toBe(false);
  });
  it("correct-format key passes", () => {
    expect(apiKeyLooksValid("OPENAI_API_KEY", "sk-validformatkey1234567890abcdef").ok).toBe(true);
  });
  it("loginWithApiKey throws for invalid format — never stores", async () => {
    await expect(loginWithApiKey("OPENAI_API_KEY", "short")).rejects.toThrow();
    expect(readKeyStore()["OPENAI_API_KEY"] ?? null).toBeFalsy();
  });
  it("loginWithApiKey throws for unknown env key", async () => {
    await expect(loginWithApiKey("UNKNOWN_KEY" as never, "some-value-1234567890123456")).rejects.toThrow(/unknown/i);
  });
  it("format-valid key is stored and checkAuthStatus sees it", async () => {
    await loginWithApiKey("OPENAI_API_KEY", "sk-validformatkey1234567890abcdef");
    expect(readKeyStore()["OPENAI_API_KEY"]).toBe("sk-validformatkey1234567890abcdef");
    const status = await checkAuthStatus();
    expect(status.envKey).toBe("OPENAI_API_KEY");
  });
});

describe("keychain lifecycle (R3-12 #197)", () => {
  it("writing a key and reading it back", async () => {
    await loginWithApiKey("OPENAI_API_KEY", "sk-validformatkey1234567890abcdef");
    const status = await checkAuthStatus();
    expect(status.envKey).toBe("OPENAI_API_KEY");
  });
  it("key store file is mode 0600", () => {
    writeKeyStoreAtomic({ OPENAI_API_KEY: "sk-test-audit-1234567890abcdef" });
    if (process.platform !== "win32") {
      expect(fs.statSync(apiKeyStorePath()).mode & 0o777).toBe(0o600);
    }
  });
});

describe("credential masking (R3-12 #197)", () => {
  it("maskKey redacts the middle of a key", () => {
    const masked = maskKey("sk-1234567890abcdef");
    expect(masked).not.toContain("1234567890abcdef");
    expect(masked.length).toBeLessThan("sk-1234567890abcdef".length);
  });
  it("maskKey handles short keys", () => {
    expect(typeof maskKey("sk-")).toBe("string");
  });
});

describe("logout semantics (R3-12 #197)", () => {
  it("logout removes keys from the store", async () => {
    await loginWithApiKey("OPENAI_API_KEY", "sk-validformatkey1234567890abcdef");
    expect(readKeyStore()["OPENAI_API_KEY"]).toBeTruthy();
    await logoutAuth();
    expect(readKeyStore()["OPENAI_API_KEY"] ?? null).toBeFalsy();
  });
  it("logout is idempotent", async () => {
    await loginWithApiKey("OPENAI_API_KEY", "sk-validformatkey1234567890abcdef");
    await logoutAuth();
    await expect(logoutAuth()).resolves.not.toThrow();
  });
  it("after logout, checkAuthStatus shows authenticated=false", async () => {
    await loginWithApiKey("OPENAI_API_KEY", "sk-validformatkey1234567890abcdef");
    await logoutAuth();
    const status = await checkAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.envKey).toBeUndefined();
  });
});

describe("checkAuthStatus structured result (R3-12 #197)", () => {
  it("returns authenticated=false without any keys", async () => {
    const status = await checkAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(typeof status.mode).toBe("string");
  });
  it("KNOWN_ENV_KEYS covers major providers", () => {
    expect(KNOWN_ENV_KEYS).toContain("OPENAI_API_KEY");
    expect(KNOWN_ENV_KEYS.length).toBeGreaterThan(0);
  });
});

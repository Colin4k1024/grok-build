// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sha256File, findArtifacts, buildReport } from "../rehearse-candidate.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("rehearse-candidate (R6-06 #284)", () => {
  it("sha256File computes the hash of a file (and null for missing)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-cand-"));
    const f = path.join(tmp, "test.bin");
    fs.writeFileSync(f, "hello");
    expect(sha256File(f)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256File(path.join(tmp, "nope"))).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("findArtifacts extracts dmg/zip + manifest + app from a dir listing", () => {
    const files = ["Grok-Build-0.1.0-arm64.dmg", "Grok-Build-0.1.0-arm64.zip", "latest-mac.yml", "mac-arm64", "builder-debug.yml"];
    const { artifacts, manifest, app } = findArtifacts(files);
    expect(artifacts).toHaveLength(2);
    expect(artifacts).toContain("Grok-Build-0.1.0-arm64.dmg");
    expect(manifest).toBe("latest-mac.yml");
    expect(app).toBe("mac-arm64/Grok Build.app");
  });

  it("findArtifacts returns empty when no artifacts", () => {
    const { artifacts, manifest, app } = findArtifacts(["readme.txt"]);
    expect(artifacts).toEqual([]);
    expect(manifest).toBeNull();
    expect(app).toBeNull();
  });

  describe("buildReport state machine (built -> verified -> rehearsed -> accepted|rejected)", () => {
    const base = { sha: "abc123", version: "0.1.0", platform: "darwin-arm64", artifacts: [{ name: "x.dmg", sha256: "h", size: 100 }], signatureStatus: "unsigned-smoke" };

    it("accepted when manifest + agent-bins + e2e all pass", () => {
      const { state, accepted } = buildReport({ ...base, manifestOk: true, agentBinsOk: true, e2ePassed: true, e2eCount: 13 });
      expect(state).toBe("accepted");
      expect(accepted).toBe(true);
    });

    it("verified-failed when manifest fails", () => {
      const { state, accepted } = buildReport({ ...base, manifestOk: false, agentBinsOk: true, e2ePassed: true, e2eCount: 13 });
      expect(state).toBe("verified-failed");
      expect(accepted).toBe(false); // rejected candidates can never be promoted
    });

    it("verified-failed when agent-bins missing", () => {
      const { state, accepted } = buildReport({ ...base, manifestOk: true, agentBinsOk: false, e2ePassed: true, e2eCount: 13 });
      expect(state).toBe("verified-failed");
      expect(accepted).toBe(false);
    });

    it("rehearsed-failed when e2e fails (verified but launch-smoke red)", () => {
      const { state, accepted } = buildReport({ ...base, manifestOk: true, agentBinsOk: true, e2ePassed: false, e2eCount: 0 });
      expect(state).toBe("rehearsed-failed");
      expect(accepted).toBe(false);
    });
  });
});

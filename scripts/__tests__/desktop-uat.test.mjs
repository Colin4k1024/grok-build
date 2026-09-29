// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UAT_ITEMS,
  UAT_ITEM_IDS,
  appendResult,
  buildReport,
  collectResults,
  runDir,
  writeManifest,
} from "../lib/uat-state.mjs";
import { spliceMatrix } from "../desktop-uat.mjs";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-uat-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeManifest(id = "run-1") {
  return {
    id,
    startedAt: new Date().toISOString(),
    appVersion: "0.1.0",
    commit: "deadbeef",
    paths: {
      grokHome: path.join(tmp, id, "grok-home"),
      journalDir: path.join(tmp, id, "journal"),
      userData: path.join(tmp, id, "user-data"),
      workspace: path.join(tmp, id, "workspace"),
    },
    withCredentials: false,
  };
}

describe("uat-state registry (R5-04 #260)", () => {
  it("registers exactly the 34 R4 matrix rows with unique sequential ids", () => {
    expect(UAT_ITEMS).toHaveLength(34);
    expect(new Set(UAT_ITEM_IDS).size).toBe(34);
    expect(UAT_ITEMS[0].id).toBe("UAT-01");
    expect(UAT_ITEMS[33].id).toBe("UAT-34");
  });

  it("flags the real-account items (never mockable)", () => {
    const real = UAT_ITEMS.filter((i) => i.requiresRealAccount).map((i) => i.id);
    expect(real).toEqual(["UAT-02", "UAT-03", "UAT-04", "UAT-32"]);
  });
});

describe("result recording and resume", () => {
  it("appends records; the latest per item wins on resume", () => {
    writeManifest(tmp, makeManifest());
    appendResult(tmp, "run-1", { item: "UAT-01", status: "fail", at: "t1", executor: "tester", note: "first try" });
    appendResult(tmp, "run-1", { item: "UAT-01", status: "pass", at: "t2", executor: "tester" });
    const results = collectResults(tmp, "run-1");
    expect(results.get("UAT-01")?.status).toBe("pass");
  });

  it("rejects unknown items and invalid statuses", () => {
    writeManifest(tmp, makeManifest());
    expect(() => appendResult(tmp, "run-1", { item: "UAT-99", status: "pass", at: "t", executor: "x" })).toThrow(/unknown UAT item/);
    expect(() => appendResult(tmp, "run-1", { item: "UAT-01", status: "meh", at: "t", executor: "x" })).toThrow(/invalid status/);
  });

  it("refuses run ids that would escape .uat/runs", () => {
    expect(() => runDir(tmp, "../escape")).toThrow(/invalid run id/);
    expect(() => runDir(tmp, "a/b")).toThrow(/invalid run id/);
  });
});

describe("strict report gate", () => {
  it("fails while items are unexecuted", () => {
    writeManifest(tmp, makeManifest());
    const report = buildReport(tmp, "run-1");
    expect(report.counts.missing).toBe(34);
    expect(report.strictFailures.length).toBe(34);
  });

  it("rejects partial until it converges to pass/fail", () => {
    writeManifest(tmp, makeManifest());
    for (const item of UAT_ITEMS) {
      appendResult(tmp, "run-1", { item: item.id, status: item.id === "UAT-31" ? "partial" : "pass", at: "t", executor: "x" });
    }
    const report = buildReport(tmp, "run-1");
    expect(report.counts.partial).toBe(1);
    expect(report.strictFailures.some((f) => f.includes("UAT-31") && f.includes("部分通过"))).toBe(true);
  });

  it("rejects a fail without a linked issue, accepts one with it", () => {
    writeManifest(tmp, makeManifest());
    for (const item of UAT_ITEMS) {
      appendResult(tmp, "run-1", { item: item.id, status: item.id === "UAT-22" ? "fail" : "pass", at: "t", executor: "x" });
    }
    let report = buildReport(tmp, "run-1");
    expect(report.strictFailures.some((f) => f.includes("UAT-22") && f.includes("issue"))).toBe(true);

    appendResult(tmp, "run-1", { item: "UAT-22", status: "fail", at: "t2", executor: "x", issueUrl: "https://github.com/Colin4k1024/grok-build/issues/999" });
    report = buildReport(tmp, "run-1");
    expect(report.strictFailures).toEqual([]);
  });

  it("a fully green run passes strict", () => {
    writeManifest(tmp, makeManifest());
    for (const item of UAT_ITEMS) {
      appendResult(tmp, "run-1", { item: item.id, status: "pass", at: "t", executor: "x" });
    }
    const report = buildReport(tmp, "run-1");
    expect(report.counts.pass).toBe(34);
    expect(report.strictFailures).toEqual([]);
  });
});

describe("matrix splice into the R4 acceptance doc", () => {
  it("replaces only the result cell of numbered rows", () => {
    const doc = [
      "| # | 步骤 | 预期 | 结果 |",
      "| --- | --- | --- | --- |",
      "| 1 | 新建会话 | 出现并获焦 | ☐ |",
      "| 22 | VoiceOver | 可访问名称 | ☐ |",
      "| 35 | 不在矩阵内 | 不动我 | ☐ |",
      "普通文本行不动",
    ].join("\n");
    writeManifest(tmp, makeManifest());
    appendResult(tmp, "run-1", { item: "UAT-01", status: "pass", at: "t", executor: "x" });
    appendResult(tmp, "run-1", { item: "UAT-22", status: "fail", at: "t", executor: "x", note: "缺少名称", issueUrl: "https://github.com/o/r/issues/1" });
    const report = buildReport(tmp, "run-1");
    const out = spliceMatrix(doc, report).join("\n");
    expect(out).toContain("| 1 | 新建会话 | 出现并获焦 | ✅ |");
    expect(out).toContain("| 22 | VoiceOver | 可访问名称 | ❌ 缺少名称（https://github.com/o/r/issues/1） |");
    // rows beyond the 34-item matrix and non-table lines stay untouched
    expect(out).toContain("| 35 | 不在矩阵内 | 不动我 | ☐ |");
    expect(out).toContain("普通文本行不动");
  });
});

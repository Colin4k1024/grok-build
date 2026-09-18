import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/sessionStore";
import { aggregateUsage, formatRetry } from "../usage";

beforeEach(() => {
  useSessionStore.setState({
    tokenUsage: {},
    rateLimits: {},
  });
});

describe("setTokenUsage monotonic guard (ISS-081)", () => {
  it("counts only ever increase — stale/out-of-order events are dropped", () => {
    const store = useSessionStore.getState();
    store.setTokenUsage("s1", 100, 1000);
    // late-arriving older event must not shrink the counter
    useSessionStore.getState().setTokenUsage("s1", 40, 1000);
    expect(useSessionStore.getState().tokenUsage.s1).toEqual({ used: 100, size: 1000 });

    // forward events land
    useSessionStore.getState().setTokenUsage("s1", 150, 1000);
    expect(useSessionStore.getState().tokenUsage.s1).toEqual({ used: 150, size: 1000 });
  });

  it("a size change (model switch) updates size without losing the max used", () => {
    useSessionStore.getState().setTokenUsage("s1", 100, 1000);
    useSessionStore.getState().setTokenUsage("s1", 50, 2000);
    expect(useSessionStore.getState().tokenUsage.s1).toEqual({ used: 100, size: 2000 });
  });

  it("first event for a session always lands", () => {
    useSessionStore.getState().setTokenUsage("fresh", 7, 100);
    expect(useSessionStore.getState().tokenUsage.fresh).toEqual({ used: 7, size: 100 });
  });
});

describe("setRateLimit slice", () => {
  it("set and clear", () => {
    const until = Date.now() + 30_000;
    useSessionStore.getState().setRateLimit("s1", { until, message: "429" });
    expect(useSessionStore.getState().rateLimits.s1).toEqual({ until, message: "429" });

    useSessionStore.getState().setRateLimit("s1", null);
    expect(useSessionStore.getState().rateLimits.s1).toBeUndefined();
  });

  it("clearing an absent entry is a no-op", () => {
    expect(() => useSessionStore.getState().setRateLimit("ghost", null)).not.toThrow();
  });
});

describe("aggregateUsage", () => {
  it("threads without usage data render as 未知, others with percentages", () => {
    const agg = aggregateUsage(
      [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ],
      { a: { used: 500, size: 1000 } }
    );
    expect(agg.rows).toEqual([
      { sessionId: "a", title: "Alpha", used: 500, size: 1000, known: true, percent: 50 },
      { sessionId: "b", title: "Beta", used: null, size: null, known: false, percent: null },
    ]);
    expect(agg.totalUsed).toBe(500);
    expect(agg.knownCount).toBe(1);
    expect(agg.threadCount).toBe(2);
  });

  it("all-unknown → total unknown, never a wrong number", () => {
    const agg = aggregateUsage([{ id: "x", title: "X" }], {});
    expect(agg.totalUsed).toBeNull();
    expect(agg.knownCount).toBe(0);
  });

  it("per-session isolation: concurrent threads aggregate independently", () => {
    const agg = aggregateUsage(
      [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
      { a: { used: 100, size: 200 }, b: { used: 900, size: 1000 } }
    );
    expect(agg.totalUsed).toBe(1000);
    expect(agg.rows.find((r) => r.sessionId === "a")!.percent).toBe(50);
    expect(agg.rows.find((r) => r.sessionId === "b")!.percent).toBe(90);
  });

  it("zero-size threads show null percent instead of NaN", () => {
    const agg = aggregateUsage([{ id: "z", title: "Z" }], { z: { used: 10, size: 0 } });
    expect(agg.rows[0].percent).toBeNull();
  });
});

describe("formatRetry", () => {
  it("formats seconds and minutes", () => {
    const now = Date.now();
    expect(formatRetry(now - 1000, now)).toBe("现在可重试");
    expect(formatRetry(now + 45_000, now)).toBe("45 秒后重试");
    expect(formatRetry(now + 125_000, now)).toBe("2 分 5 秒后重试");
  });
});

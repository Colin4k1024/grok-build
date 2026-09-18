import { describe, it, expect, beforeEach } from "vitest";
import { usePermissionsStore, type PermissionRule } from "../permissionsStore";

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    toolName: "bash",
    commandPattern: "npm test",
    decision: "allow",
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  usePermissionsStore.setState({ rules: [] });
});

describe("pattern matching", () => {
  it("matches exact commands only", () => {
    usePermissionsStore.getState().addRule(rule());
    const lookup = usePermissionsStore.getState().lookup;

    expect(lookup("bash", "npm test")?.decision).toBe("allow");
    expect(lookup("bash", "npm test --watch")).toBeNull();
    expect(lookup("bash", "NPM TEST")).toBeNull();
  });

  it("matches a trailing-* prefix pattern", () => {
    usePermissionsStore.getState().addRule(rule({ commandPattern: "git *" }));
    const lookup = usePermissionsStore.getState().lookup;

    expect(lookup("bash", "git status")?.decision).toBe("allow");
    expect(lookup("bash", "git")).toBeNull();
    expect(lookup("bash", "gitx status")).toBeNull();
  });

  it("rules are scoped per tool", () => {
    usePermissionsStore.getState().addRule(rule({ toolName: "bash" }));
    expect(
      usePermissionsStore.getState().lookup("write_file", "npm test")
    ).toBeNull();
  });
});

describe("scope precedence", () => {
  it("session-scoped rules beat global rules", () => {
    const store = usePermissionsStore.getState();
    store.addRule(rule({ decision: "deny", sessionId: "s1" })); // session deny
    store.addRule(rule({ decision: "allow" })); // global allow

    const hit = usePermissionsStore.getState().lookup("bash", "npm test", "s1");
    expect(hit).toEqual({ decision: "deny", scope: "session" });
  });

  it("the most recent global rule for the same pattern wins", () => {
    const store = usePermissionsStore.getState();
    store.addRule(rule({ decision: "deny", createdAt: 1 }));
    store.addRule(rule({ decision: "allow", createdAt: 2 }));

    const hit = usePermissionsStore.getState().lookup("bash", "npm test");
    expect(hit).toEqual({ decision: "allow", scope: "global" });
  });

  it("without a sessionId only global rules apply", () => {
    usePermissionsStore.getState().addRule(rule({ sessionId: "s1" }));
    expect(usePermissionsStore.getState().lookup("bash", "npm test")).toBeNull();
    expect(
      usePermissionsStore.getState().lookup("bash", "npm test", "other")
    ).toBeNull();
  });

  it("a session rule from another session does not leak", () => {
    usePermissionsStore.getState().addRule(rule({ sessionId: "s1" }));
    expect(
      usePermissionsStore.getState().lookup("bash", "npm test", "s2")
    ).toBeNull();
  });
});

describe("rule management", () => {
  it("addRule replaces an existing rule for the same (tool, pattern, session) triple", () => {
    const store = usePermissionsStore.getState();
    store.addRule(rule({ decision: "allow" }));
    store.addRule(rule({ decision: "deny" }));

    const s = usePermissionsStore.getState();
    expect(s.rules).toHaveLength(1);
    expect(s.rules[0].decision).toBe("deny");
  });

  it("the same pattern can exist as both a session rule and a global rule", () => {
    const store = usePermissionsStore.getState();
    store.addRule(rule({ sessionId: "s1" }));
    store.addRule(rule());

    expect(usePermissionsStore.getState().rules).toHaveLength(2);
  });

  it("removeRule drops only the targeted index", () => {
    const store = usePermissionsStore.getState();
    store.addRule(rule({ commandPattern: "a" }));
    store.addRule(rule({ commandPattern: "b" }));

    usePermissionsStore.getState().removeRule(0);

    expect(
      usePermissionsStore.getState().rules.map((r) => r.commandPattern)
    ).toEqual(["b"]);
  });

  it("clearForSession removes only that session's rules", () => {
    const store = usePermissionsStore.getState();
    store.addRule(rule({ sessionId: "s1", commandPattern: "x" }));
    store.addRule(rule({ sessionId: "s2", commandPattern: "y" }));
    store.addRule(rule({ commandPattern: "z" }));

    usePermissionsStore.getState().clearForSession("s1");

    expect(
      usePermissionsStore.getState().rules.map((r) => r.commandPattern).sort()
    ).toEqual(["y", "z"]);
  });

  it("clearAll wipes every rule", () => {
    usePermissionsStore.getState().addRule(rule());
    usePermissionsStore.getState().clearAll();
    expect(usePermissionsStore.getState().rules).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard } from "../ApprovalCard";
import { usePermissionsStore } from "../../../stores/permissionsStore";
import { respondPermission, type PermissionOption } from "../../../lib/tauri";

vi.mock("../../../lib/tauri", () => ({
  respondPermission: vi.fn(() => Promise.resolve()),
}));

const OPTIONS: PermissionOption[] = [
  { id: "o-allow-once", label: "允许", kind: "AllowOnce" },
  { id: "o-allow-always", label: "始终允许", kind: "AllowAlways" },
  { id: "o-deny", label: "拒绝", kind: "Deny" },
];

function setup(overrides: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
  const props = {
    sessionId: "s1",
    requestId: "r1",
    toolName: "bash",
    command: "rm -rf build",
    options: OPTIONS,
    onResolved: vi.fn(),
    ...overrides,
  };
  render(<ApprovalCard {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePermissionsStore.setState({ rules: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rendering", () => {
  it("shows the tool name, command, and the countdown hint", () => {
    setup();

    expect(screen.getByText("需要授权")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
    expect(screen.getByText(/秒后自动拒绝/)).toBeInTheDocument();
  });

  it("renders all three decision buttons when every option kind exists", () => {
    setup();
    expect(screen.getByRole("button", { name: "✓ 允许" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✓ 始终允许" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✕ 拒绝" })).toBeInTheDocument();
  });
});

describe("user decisions", () => {
  it("允许 responds once, remembers nothing, resolves the card", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "✓ 允许" }));

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith("s1", "r1", "o-allow-once", false);
    expect(usePermissionsStore.getState().rules).toEqual([]);
  });

  it("始终允许 persists a global allow rule", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "✓ 始终允许" }));

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(respondPermission).toHaveBeenCalledWith("s1", "r1", "o-allow-always", true);
    const lookup = usePermissionsStore.getState().lookup;
    expect(lookup("bash", "rm -rf build")).toEqual({ decision: "allow", scope: "global" });
  });

  it("拒绝 persists a session-scoped deny rule", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "✕ 拒绝" }));

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(respondPermission).toHaveBeenCalledWith("s1", "r1", "o-deny", false);
    const lookup = usePermissionsStore.getState().lookup;
    expect(lookup("bash", "rm -rf build", "s1")).toEqual({ decision: "deny", scope: "session" });
    // deny is session-scoped: must not leak into other tabs/projects
    expect(lookup("bash", "rm -rf build")).toBeNull();
  });

  it("a failed backend call resolves the card but persists no rule", async () => {
    vi.mocked(respondPermission).mockRejectedValueOnce(new Error("ipc down"));
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByRole("button", { name: "✓ 允许" }));

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(usePermissionsStore.getState().rules).toEqual([]);
  });

  it("double-clicking cannot answer twice", async () => {
    const user = userEvent.setup();
    setup();

    const allow = screen.getByRole("button", { name: "✓ 允许" });
    await user.click(allow);
    await user.click(allow);

    expect(respondPermission).toHaveBeenCalledTimes(1);
  });
});

describe("pre-approval from persisted rules", () => {
  it("a session allow rule auto-answers with the once-option", async () => {
    usePermissionsStore.getState().addRule({
      toolName: "bash",
      commandPattern: "rm -rf build",
      decision: "allow",
      createdAt: 1,
      sessionId: "s1",
    });
    const props = setup();

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(respondPermission).toHaveBeenCalledWith("s1", "r1", "o-allow-once", false);
  });

  it("a global allow rule auto-answers with the always-option", async () => {
    usePermissionsStore.getState().addRule({
      toolName: "bash",
      commandPattern: "rm -rf build",
      decision: "allow",
      createdAt: 1,
    });
    const props = setup();

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(respondPermission).toHaveBeenCalledWith("s1", "r1", "o-allow-always", true);
  });

  it("a deny rule does NOT auto-answer — deny is a per-decision choice", async () => {
    usePermissionsStore.getState().addRule({
      toolName: "bash",
      commandPattern: "rm -rf build",
      decision: "deny",
      createdAt: 1,
      sessionId: "s1",
    });
    setup();

    // Give the pre-approve effect a chance to (wrongly) fire
    await act(async () => { await Promise.resolve(); });
    expect(respondPermission).not.toHaveBeenCalled();
  });
});

describe("30s timeout auto-deny", () => {
  /** The countdown chains one setTimeout per second — step it inside act()
   *  so every state update renders before the next timer fires. */
  async function tickSeconds(seconds: number) {
    for (let i = 0; i < seconds; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
  }

  it("auto-denies on timeout without blacklisting the command", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const props = setup();

    await tickSeconds(31);

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith("s1", "r1", "o-deny", false);
    expect(props.onResolved).toHaveBeenCalled();
    // Going AFK must not write a deny rule
    expect(usePermissionsStore.getState().rules).toEqual([]);
  });

  it("without any Deny option the timeout closes the card WITHOUT sending anything (#162)", async () => {
    // Timeout is deny intent: falling back to the last option (an allow id)
    // would silently grant permission — now aligned with the click guard.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const props = setup({ options: [OPTIONS[0]] });

    await tickSeconds(31);

    expect(respondPermission).not.toHaveBeenCalled();
    expect(props.onResolved).toHaveBeenCalled();
    expect(usePermissionsStore.getState().rules).toEqual([]);
  });

  it("拒绝 with no Deny option refuses to fall back to an allow id", async () => {
    const user = userEvent.setup();
    const props = setup({ options: [OPTIONS[0], OPTIONS[1]] });

    await user.click(screen.getByRole("button", { name: "✕ 拒绝" }));

    await waitFor(() => expect(props.onResolved).toHaveBeenCalled());
    expect(respondPermission).not.toHaveBeenCalled();
    expect(usePermissionsStore.getState().rules).toEqual([]);
  });
});

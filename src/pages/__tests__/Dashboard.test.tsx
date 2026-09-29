// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { useSessionStore } from "../../stores/sessionStore";

function resetSession() {
  useSessionStore.setState({
    tabs: [],
    activeSessionId: null,
    messages: {},
    subagents: {},
    tokenUsage: {},
    isStreaming: false,
    pendingPermissions: {},
    pendingQuestions: {},
  } as never);
}

describe("Dashboard (R4-09 #242)", () => {
  it("shows the empty state when there are no sessions", () => {
    resetSession();
    render(<Dashboard onOpenSession={vi.fn()} />);
    expect(screen.getByText("没有活跃会话")).toBeInTheDocument();
  });

  it("surfaces a needs-attention card for a session with a failed subagent", () => {
    resetSession();
    useSessionStore.setState({
      tabs: [{ id: "t1", title: "alpha", cwd: "/p", model: "m", reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1 }],
      activeSessionId: "t1",
      subagents: { t1: [{ id: "a1", name: "worker", status: "failed", summary: "boom", createdAt: 2, toolCallId: "tc" }] },
    } as never);
    render(<Dashboard onOpenSession={vi.fn()} />);
    expect(screen.getByText("需要处理")).toBeInTheDocument();
    expect(screen.getByText("1 失败代理")).toBeInTheDocument();
  });

  it("does NOT render the removed vanity metrics bar", () => {
    resetSession();
    useSessionStore.setState({
      tabs: [{ id: "t1", title: "alpha", cwd: "/p", model: "m", reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1 }],
      activeSessionId: "t1",
    } as never);
    render(<Dashboard onOpenSession={vi.fn()} />);
    // the old decorative stats labels must be gone
    expect(screen.queryByText("活跃会话")).not.toBeInTheDocument();
    expect(screen.queryByText("Token 总量")).not.toBeInTheDocument();
    expect(screen.queryByText("上下文容量")).not.toBeInTheDocument();
  });

  it("opens a session when a session card is clicked", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    resetSession();
    useSessionStore.setState({
      tabs: [{ id: "t1", title: "alpha", cwd: "/p", model: "m", reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1 }],
      activeSessionId: "t1",
    } as never);
    render(<Dashboard onOpenSession={onOpen} />);
    await user.click(screen.getByRole("button", { name: /alpha/ }));
    expect(onOpen).toHaveBeenCalledWith("t1");
  });

  it("does NOT badge a session whose pendingQuestions is an empty leftover array (R4-09 #242)", () => {
    resetSession();
    useSessionStore.setState({
      tabs: [{ id: "t1", title: "alpha", cwd: "/p", model: "m", reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1 }],
      activeSessionId: "t1",
      pendingQuestions: { t1: [] }, // leftover empty array after the last question was answered
    } as never);
    render(<Dashboard onOpenSession={vi.fn()} />);
    // needs-attention section shows the "nothing to handle" empty state, not a phantom badge
    expect(screen.getByText("无需处理的项")).toBeInTheDocument();
    expect(screen.queryByText("1 待处理")).not.toBeInTheDocument();
  });
});

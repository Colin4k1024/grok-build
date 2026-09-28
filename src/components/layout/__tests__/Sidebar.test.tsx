import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../session/ThreadTree", () => ({
  ThreadTree: () => <div data-testid="thread-tree" />,
}));

import { Sidebar } from "../Sidebar";

function renderSidebar() {
  return render(
    <Sidebar
      collapsed={false}
      creating={false}
      onNewSession={() => {}}
      onNewSessionInDir={() => {}}
      onResumeThread={() => {}}
      onForkSession={() => {}}
      onRenameHistory={() => {}}
      onCloseSession={() => {}}
      onOpenSearch={() => {}}
    />,
  );
}

describe("Sidebar (contextual, conversations-only)", () => {
  it("does not repeat top-level destinations (they live in the rail)", () => {
    renderSidebar();
    // 设置/自动化/插件/仪表盘 must NOT appear as sidebar rows anymore.
    expect(screen.queryByRole("button", { name: /^设置/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^自动化/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^插件/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^仪表盘/ })).not.toBeInTheDocument();
  });

  it("keeps the conversation context: new thread + thread tree + search", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: /新对话/ })).toBeInTheDocument();
    expect(screen.getByTestId("thread-tree")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^搜索/ })).toBeInTheDocument();
  });

  it("renders nothing when collapsed", () => {
    const { container } = render(
      <Sidebar
        collapsed
        creating={false}
        onNewSession={() => {}}
        onNewSessionInDir={() => {}}
        onResumeThread={() => {}}
        onForkSession={() => {}}
        onRenameHistory={() => {}}
        onCloseSession={() => {}}
        onOpenSearch={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActivityBar, type AppDestination } from "../ActivityBar";

function renderBar(destination: AppDestination = "conversations") {
  const onNavigate = vi.fn();
  const onOpenSearch = vi.fn();
  const onToggleSidebar = vi.fn();
  render(
    <ActivityBar
      destination={destination}
      onNavigate={onNavigate}
      onOpenSearch={onOpenSearch}
      onToggleSidebar={onToggleSidebar}
      sidebarVisible
    />,
  );
  return { onNavigate, onOpenSearch, onToggleSidebar };
}

describe("ActivityBar", () => {
  it("renders each top-level destination exactly once", () => {
    renderBar();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["会话", "仪表盘", "自动化", "代理", "设置"]) {
      const items = Array.from(nav.querySelectorAll("button")).filter(
        (b) => b.getAttribute("aria-label")?.startsWith(label),
      );
      expect(items, label).toHaveLength(1);
    }
  });

  it("marks the active destination with aria-current", () => {
    renderBar("dashboard");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const current = nav.querySelector('[aria-current="page"]');
    expect(current).not.toBeNull();
    expect(current?.getAttribute("aria-label")).toMatch(/^仪表盘/);
  });

  it("navigates on click", async () => {
    const { onNavigate } = renderBar("conversations");
    await userEvent.click(screen.getByRole("button", { name: /^自动化/ }));
    expect(onNavigate).toHaveBeenCalledWith("automations");
  });

  it("search is a command, not a destination (no aria-current)", async () => {
    const { onOpenSearch } = renderBar();
    const search = screen.getByRole("button", { name: /^搜索/ });
    expect(search).not.toHaveAttribute("aria-current");
    await userEvent.click(search);
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("sidebar toggle is independent of navigation", async () => {
    const { onNavigate, onToggleSidebar } = renderBar();
    await userEvent.click(screen.getByRole("button", { name: /切换会话侧栏/ }));
    expect(onToggleSidebar).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

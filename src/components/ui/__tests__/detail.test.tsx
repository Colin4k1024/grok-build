// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AsyncState } from "../AsyncState";
import { CollapsibleSection, CopyButton } from "../Detail";

describe("AsyncState", () => {
  it("renders skeleton rows while loading", () => {
    render(
      <AsyncState loading empty={false} emptyTitle="empty">
        <p>data</p>
      </AsyncState>,
    );
    expect(screen.queryByText("data")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).toBeInTheDocument();
  });

  it("renders an error InlineNotice with a retry action", () => {
    const onRetry = vi.fn();
    render(
      <AsyncState loading={false} error="boom" onRetry={onRetry} emptyTitle="x">
        <p>data</p>
      </AsyncState>,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("renders EmptyState when empty", () => {
    render(
      <AsyncState loading={false} empty emptyTitle="没有项目" emptyDescription="去创建一个">
        <p>data</p>
      </AsyncState>,
    );
    expect(screen.getByText("没有项目")).toBeInTheDocument();
    expect(screen.getByText("去创建一个")).toBeInTheDocument();
  });

  it("renders children when data is present", () => {
    render(
      <AsyncState loading={false} empty={false} emptyTitle="x">
        <p>actual data</p>
      </AsyncState>,
    );
    expect(screen.getByText("actual data")).toBeInTheDocument();
  });
});

describe("CollapsibleSection", () => {
  it("toggles content via the heading button (keyboard)", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Files">
        <span>secret content</span>
      </CollapsibleSection>,
    );
    const heading = screen.getByRole("button", { name: /Files/ });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    await user.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    await user.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
  });
});

describe("CopyButton", () => {
  it("copies to clipboard and announces", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyButton value="abc" />);
    const btn = screen.getByRole("button", { name: "复制" });
    await user.click(btn);
    expect(writeText).toHaveBeenCalledWith("abc");
  });
});

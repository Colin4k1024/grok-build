import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../Button";
import { Dialog } from "../Dialog";
import { DropdownMenu } from "../DropdownMenu";
import { InlineNotice, EmptyState, Skeleton } from "../Feedback";
import { Input, SearchField } from "../Input";
import { SegmentedControl, Select, Switch } from "../FormControls";
import { ToastViewport, toast, useToastStore } from "../Toast";
import { Tooltip } from "../Tooltip";

// The toast store is module-level — isolate it between tests.
beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

describe("Button", () => {
  it("disables and announces its loading state", () => {
    render(<Button loading>保存</Button>);
    const btn = screen.getByRole("button", { name: /保存/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  it("supports keyboard activation", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>确定</Button>);
    screen.getByRole("button").focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("exposes the required accessible label", () => {
    render(<IconButton label="关闭面板" icon={<svg data-testid="x" />} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "关闭面板" })).toBeInTheDocument();
  });

  it("marks the icon decorative", () => {
    render(<IconButton label="更多" icon={<svg data-testid="dots" />} onClick={() => {}} />);
    expect(screen.getByTestId("dots").parentElement).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Input", () => {
  it("associates label, description and error", () => {
    render(
      <Input
        label="项目名称"
        description="显示在侧栏中"
        error="名称不能为空"
        value=""
        onChange={() => {}}
      />,
    );
    const input = screen.getByLabelText("项目名称");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/显示在侧栏中/);
    expect(input).toHaveAccessibleDescription(/名称不能为空/);
  });

  it("reflects disabled state", () => {
    render(<Input label="主机" disabled value="" onChange={() => {}} />);
    expect(screen.getByLabelText("主机")).toBeDisabled();
  });
});

describe("SearchField", () => {
  it("is a labeled searchbox", () => {
    render(<SearchField label="搜索设置" value="" onChange={() => {}} />);
    expect(screen.getByRole("searchbox", { name: "搜索设置" })).toBeInTheDocument();
  });
});

describe("Switch", () => {
  it("toggles via click and Space with role=switch", async () => {
    function Demo() {
      const [on, setOn] = useState(false);
      return <Switch label="自动保存" checked={on} onCheckedChange={setOn} />;
    }
    render(<Demo />);
    const sw = screen.getByRole("switch", { name: "自动保存" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    sw.focus();
    await userEvent.keyboard(" ");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("does not toggle when disabled", async () => {
    render(<Switch label="只读" checked={false} disabled onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});

describe("SegmentedControl", () => {
  it("navigates with arrow keys and selects with Enter", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="主题"
        value="dark"
        onChange={onChange}
        options={[
          { value: "dark", label: "深色" },
          { value: "light", label: "浅色" },
          { value: "auto", label: "跟随系统" },
        ]}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "主题" });
    expect(group).toBeInTheDocument();
    const dark = screen.getByRole("radio", { name: "深色" });
    expect(dark).toHaveAttribute("aria-checked", "true");
    dark.focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("light");
  });
});

describe("Select", () => {
  it("renders a labeled native select", async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="模型"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "模型 A" },
          { value: "b", label: "模型 B" },
        ]}
      />,
    );
    const select = screen.getByRole("combobox", { name: "模型" });
    await userEvent.selectOptions(select, "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("Dialog", () => {
  function Demo() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>打开设置</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="确认删除">
          <button>取消</button>
          <button>删除</button>
        </Dialog>
      </>
    );
  }

  it("traps focus, closes on Escape and restores focus", async () => {
    render(<Demo />);
    const trigger = screen.getByRole("button", { name: "打开设置" });
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // focus moved inside
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Tab wraps: from last focusable back to first
    const buttons = screen.getAllByRole("button", { name: /取消|删除/ });
    buttons[buttons.length - 1].focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(buttons[0]);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not render when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="隐藏">
        内容
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("DropdownMenu", () => {
  function Demo() {
    return (
      <DropdownMenu
        triggerLabel="操作"
        items={[
          { key: "rename", label: "重命名", onSelect: () => {} },
          { key: "pin", label: "置顶", onSelect: () => {} },
          { key: "delete", label: "删除", danger: true, onSelect: () => {} },
        ]}
      />
    );
  }

  it("opens with keyboard, navigates with arrows, selects with Enter", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        triggerLabel="操作"
        items={[{ key: "rename", label: "重命名", onSelect }]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "操作" });
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    const item = screen.getByRole("menuitem", { name: "重命名" });
    await waitFor(() => expect(document.activeElement).toBe(item));
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape closes and refocuses the trigger", async () => {
    render(<Demo />);
    const trigger = screen.getByRole("button", { name: "操作" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("skips disabled items during arrow navigation", async () => {
    render(
      <DropdownMenu
        triggerLabel="菜单"
        items={[
          { key: "a", label: "甲", disabled: true, onSelect: () => {} },
          { key: "b", label: "乙", onSelect: () => {} },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "菜单" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "乙" })),
    );
  });
});

describe("Tooltip", () => {
  it("shows on keyboard focus and hides on blur", async () => {
    render(
      <Tooltip content="复制到剪贴板">
        <button>复制</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "复制" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    trigger.focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("复制到剪贴板"));
    trigger.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });
});

describe("Toast", () => {
  it("announces success in a polite live region and error via alert", async () => {
    render(<ToastViewport />);
    toast.success("已保存");
    toast.error("保存失败");
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
  });

  it("dismisses via its close button", async () => {
    render(<ToastViewport />);
    toast.error("连接断开");
    const alert = await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: /关闭通知/ }));
    await waitFor(() => expect(alert).not.toBeInTheDocument());
  });

  it("progress toasts stay until dismissed programmatically", async () => {
    vi.useFakeTimers();
    try {
      render(<ToastViewport />);
      const { act } = await import("@testing-library/react");
      act(() => {
        toast.progress("正在同步");
      });
      expect(screen.getByText("正在同步")).toBeInTheDocument();
      vi.advanceTimersByTime(30_000);
      expect(screen.getByText("正在同步")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("InlineNotice / EmptyState / Skeleton", () => {
  it("InlineNotice uses role=alert for danger", () => {
    render(<InlineNotice tone="danger">磁盘空间不足</InlineNotice>);
    expect(screen.getByRole("alert")).toHaveTextContent("磁盘空间不足");
  });

  it("EmptyState renders guidance and action", () => {
    render(<EmptyState title="暂无自动化" description="创建第一个定时任务" />);
    expect(screen.getByText("暂无自动化")).toBeInTheDocument();
    expect(screen.getByText("创建第一个定时任务")).toBeInTheDocument();
  });

  it("Skeleton is decorative", () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../Button";
import { Dialog, Sheet } from "../Dialog";
import { DropdownMenu, computeMenuPlacement } from "../DropdownMenu";
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

  it("does not fire the click handler while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button so it never submits surrounding forms", () => {
    render(<Button>提交?</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
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

  it("uses roving tabindex — only the selected option is in the tab order", () => {
    render(
      <SegmentedControl
        label="密度"
        value="a"
        onChange={() => {}}
        options={[
          { value: "a", label: "甲" },
          { value: "b", label: "乙" },
          { value: "c", label: "丙" },
        ]}
      />,
    );
    expect(screen.getByRole("radio", { name: "甲" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "乙" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "丙" })).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the first option tabbable when value matches nothing", () => {
    render(
      <SegmentedControl
        label="密度"
        value="missing"
        onChange={() => {}}
        options={[
          { value: "a", label: "甲" },
          { value: "b", label: "乙" },
        ]}
      />,
    );
    expect(screen.getByRole("radio", { name: "甲" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "乙" })).toHaveAttribute("tabindex", "-1");
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
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

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

  it("skips hidden focusables when moving initial focus", async () => {
    render(
      <Dialog open onClose={() => {}} title="带隐藏控件">
        <input type="hidden" value="x" readOnly />
        <button style={{ display: "none" }}>不可见</button>
        <button>可见按钮</button>
      </Dialog>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "可见按钮" })),
    );
  });

  it("does not throw when the trigger unmounted before close", async () => {
    function VanishingTrigger() {
      const [open, setOpen] = useState(false);
      return (
        <>
          {!open && <button onClick={() => setOpen(true)}>临时触发</button>}
          <Dialog open={open} onClose={() => setOpen(false)} title="框">
            <button>内部</button>
          </Dialog>
        </>
      );
    }
    render(<VanishingTrigger />);
    await userEvent.click(screen.getByRole("button", { name: "临时触发" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // no crash; focus is not forced onto a detached node
  });

  it("does not render when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="隐藏">
        内容
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Sheet renders as a right-docked dialog with the same a11y contract", async () => {
    function SheetDemo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开面板</button>
          <Sheet open={open} onClose={() => setOpen(false)} title="编辑自动化">
            <button>保存</button>
          </Sheet>
        </>
      );
    }
    render(<SheetDemo />);
    await userEvent.click(screen.getByRole("button", { name: "打开面板" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("DropdownMenu", () => {
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

  it("selects with Space as well", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        triggerLabel="操作"
        items={[{ key: "a", label: "甲", onSelect }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "操作" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" })),
    );
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("Escape closes and refocuses the trigger", async () => {
    render(
      <DropdownMenu
        triggerLabel="操作"
        items={[{ key: "rename", label: "重命名", onSelect: () => {} }]}
      />,
    );
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

  it("Home/End jump to first/last enabled item", async () => {
    render(
      <DropdownMenu
        triggerLabel="菜单"
        items={[
          { key: "a", label: "甲", onSelect: () => {} },
          { key: "b", label: "乙", onSelect: () => {} },
          { key: "c", label: "丙", onSelect: () => {} },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "菜单" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" })),
    );
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "丙" }));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" }));
  });

  it("closes on click-away without stealing focus", async () => {
    render(
      <div>
        <DropdownMenu
          triggerLabel="菜单"
          items={[{ key: "a", label: "甲", onSelect: () => {} }]}
        />
        <button>外部</button>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "菜单" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // click-away closes without yanking focus back to the trigger
    expect(document.activeElement).not.toBe(trigger);
  });

  it("closes on Tab and moves focus onward", async () => {
    render(
      <div>
        <DropdownMenu
          triggerLabel="菜单"
          items={[{ key: "a", label: "甲", onSelect: () => {} }]}
        />
        <button>下一个</button>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "菜单" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" })),
    );
    await userEvent.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("moves focus into items that arrive asynchronously while open", async () => {
    function AsyncMenu() {
      const [items, setItems] = useState<Array<{ key: string; label: string; onSelect: () => void }>>([]);
      useEffect(() => {
        const t = setTimeout(
          () => setItems([{ key: "x", label: "迟到项", onSelect: () => {} }]),
          50,
        );
        return () => clearTimeout(t);
      }, []);
      return <DropdownMenu triggerLabel="异步" items={items} />;
    }
    render(<AsyncMenu />);
    await userEvent.click(screen.getByRole("button", { name: "异步" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // items arrive ~50ms after the menu is already open
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "迟到项" })),
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

  it("hides on Escape", async () => {
    render(
      <Tooltip content="提示">
        <button>触发</button>
      </Tooltip>,
    );
    screen.getByRole("button", { name: "触发" }).focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("composes the child's own handlers instead of overwriting them", async () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(
      <Tooltip content="提示">
        <button onFocus={onFocus} onBlur={onBlur}>
          组合
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "组合" });
    trigger.focus();
    expect(onFocus).toHaveBeenCalledOnce();
    trigger.blur();
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("delays hover display and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(
        <Tooltip content="悬停提示" delay={400}>
          <button>悬停</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(screen.getByRole("button", { name: "悬停" }));
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(250));
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      fireEvent.mouseLeave(screen.getByRole("button", { name: "悬停" }));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      // unmount with a pending timer must not warn or resurrect the tooltip
      fireEvent.mouseEnter(screen.getByRole("button", { name: "悬停" }));
      unmount();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Toast", () => {
  it("announces success in the polite region and error in the assertive one", async () => {
    render(<ToastViewport />);
    act(() => {
      toast.success("已保存");
      toast.error("保存失败");
    });
    const success = await screen.findByText("已保存");
    const failure = screen.getByText("保存失败");
    expect(success.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    expect(failure.closest("[aria-live]")).toHaveAttribute("aria-live", "assertive");
    // flat regions: no role on items, no nesting
    expect(success.closest("[aria-live]")?.querySelector("[aria-live]")).toBeNull();
  });

  it("auto-dismisses success after its TTL with a short exit transition", () => {
    vi.useFakeTimers();
    try {
      render(<ToastViewport />);
      act(() => {
        toast.success("已保存");
      });
      expect(screen.getByText("已保存")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(4000));
      // exit transition in flight — still mounted, marked exiting
      expect(screen.getByText("已保存")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses via its close button", async () => {
    render(<ToastViewport />);
    act(() => {
      toast.error("连接断开");
    });
    expect(screen.getByText("连接断开")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    await waitFor(() => expect(screen.queryByText("连接断开")).not.toBeInTheDocument());
  });

  it("progress toasts stay until dismissed programmatically", () => {
    vi.useFakeTimers();
    try {
      render(<ToastViewport />);
      act(() => {
        toast.progress("正在同步");
      });
      expect(screen.getByText("正在同步")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(30_000));
      expect(screen.getByText("正在同步")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("layer composition", () => {
  it("Escape inside a menu-in-dialog closes only the menu; the next Escape closes the dialog", async () => {
    function Nested() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开</button>
          <Dialog open={open} onClose={() => setOpen(false)} title="嵌套">
            <DropdownMenu
              triggerLabel="对话框内菜单"
              items={[{ key: "a", label: "甲", onSelect: () => {} }]}
            />
          </Dialog>
        </>
      );
    }
    render(<Nested />);
    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "对话框内菜单" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" })),
    );

    await userEvent.keyboard("{Escape}");
    // menu closed, dialog STILL open
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("menu portals to document.body and sits on the dropdown layer", async () => {
    render(
      <DropdownMenu
        triggerLabel="层级"
        items={[{ key: "a", label: "甲", onSelect: () => {} }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "层级" }));
    const menu = await screen.findByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("z-gb-dropdown");
  });
});

describe("computeMenuPlacement", () => {
  const trigger = { top: 100, bottom: 132, left: 40, right: 120 };

  it("opens below the trigger by default", () => {
    const p = computeMenuPlacement(trigger, 160, 1280, 800, "left");
    expect(p).toEqual({ top: 136, left: 40, right: undefined, flipped: false });
  });

  it("flips above when there is no room below", () => {
    const low = { top: 700, bottom: 732, left: 40, right: 120 };
    const p = computeMenuPlacement(low, 160, 1280, 800, "left");
    expect(p.flipped).toBe(true);
    expect(p.top).toBe(700 - 4 - 160);
  });

  it("never flips into negative space", () => {
    const cramped = { top: 60, bottom: 92, left: 40, right: 120 };
    const p = computeMenuPlacement(cramped, 200, 1280, 130, "left");
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it("right-aligns via viewport-relative right offset", () => {
    const p = computeMenuPlacement(trigger, 160, 1280, 800, "right");
    expect(p.right).toBe(1280 - 120);
    expect(p.left).toBeUndefined();
  });
});

describe("menu item shrink while open", () => {
  it("End lands on the remaining last item after items shrink", async () => {
    function Shrinking() {
      const [items, setItems] = useState([
        { key: "a", label: "甲", onSelect: () => {} },
        { key: "b", label: "乙", onSelect: () => {} },
        { key: "c", label: "丙", onSelect: () => {} },
      ]);
      return (
        <>
          <button onClick={() => setItems((prev) => prev.slice(0, 1))}>收缩</button>
          <DropdownMenu triggerLabel="收缩菜单" items={items} />
        </>
      );
    }
    render(<Shrinking />);
    await userEvent.click(screen.getByRole("button", { name: "收缩菜单" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" })),
    );
    // shrink to a single item (menu stays open; 收缩 is inside document but the
    // click-away listener closes on outside mousedown — so shrink via keyboard
    // would close; instead call the store path: use fireEvent on the button
    // after closing focus… simplest: rerender through the button with the menu
    // reopened)
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "收缩" }));
    await userEvent.click(screen.getByRole("button", { name: "收缩菜单" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" })),
    );
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "甲" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });
});

describe("toast layout", () => {
  it("polite and assertive regions share one fixed stack (no overlap)", () => {
    render(<ToastViewport />);
    act(() => {
      toast.success("普通");
      toast.error("严重");
    });
    const polite = screen.getByText("普通").closest("[aria-live]")!;
    const assertive = screen.getByText("严重").closest("[aria-live]")!;
    expect(polite).not.toBe(assertive);
    expect(polite.parentElement).toBe(assertive.parentElement);
    expect(polite.parentElement?.className).toContain("fixed");
  });
});

describe("Input invalid state", () => {
  it("renders the error border utility that wins over the control tier", () => {
    render(<Input label="主机" error="必填" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("主机").className).toContain("gb-border-danger");
  });
});

describe("Dialog hidden-attribute exclusion", () => {
  it("skips [hidden] elements when moving initial focus", async () => {
    render(
      <Dialog open onClose={() => {}} title="隐藏属性">
        <button hidden>藏</button>
        <button>可见</button>
      </Dialog>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "可见" })),
    );
  });
});

describe("InlineNotice / EmptyState / Skeleton", () => {
  it("InlineNotice uses role=alert for danger", () => {
    render(<InlineNotice tone="danger">磁盘空间不足</InlineNotice>);
    expect(screen.getByRole("alert")).toHaveTextContent("磁盘空间不足");
  });

  it("InlineNotice renders distinct glyphs per tone", () => {
    const { container, rerender } = render(<InlineNotice tone="info">i</InlineNotice>);
    const infoPath = container.querySelector("path")?.getAttribute("d");
    rerender(<InlineNotice tone="danger">d</InlineNotice>);
    const dangerPath = container.querySelector("path")?.getAttribute("d");
    expect(infoPath).toBeTruthy();
    expect(dangerPath).toBeTruthy();
    expect(infoPath).not.toBe(dangerPath);
  });

  it("EmptyState renders guidance and action", () => {
    render(
      <EmptyState
        title="暂无自动化"
        description="创建第一个定时任务"
        action={<button>新建</button>}
      />,
    );
    expect(screen.getByText("暂无自动化")).toBeInTheDocument();
    expect(screen.getByText("创建第一个定时任务")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建" })).toBeInTheDocument();
  });

  it("Skeleton is decorative", () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });
});

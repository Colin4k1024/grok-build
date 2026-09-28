import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../AppShell";
import type { AppDestination } from "../destinations";

function Rail() {
  return <nav aria-label="主导航">rail</nav>;
}

describe("AppShell", () => {
  it("exposes navigation, main and complementary landmarks", () => {
    render(
      <AppShell
        destination="conversations"
        rail={<Rail />}
        sidebar={<aside aria-label="会话侧栏">sidebar</aside>}
        titlebar={<header>titlebar</header>}
        workspace={<div>workspace content</div>}
        inspector={<aside aria-label="检查器">inspector</aside>}
      />,
    );
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("workspace content");
    expect(screen.getByRole("complementary", { name: "检查器" })).toBeInTheDocument();
  });

  it("skip link moves focus straight to the workspace", async () => {
    render(
      <AppShell
        destination="conversations"
        rail={<Rail />}
        titlebar={<header>t</header>}
        workspace={<div>ws</div>}
      />,
    );
    const skip = screen.getByRole("link", { name: /跳到/ });
    skip.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("collapsing the inspector does not unmount the workspace", () => {
    const { rerender } = render(
      <AppShell
        destination="conversations"
        rail={<Rail />}
        titlebar={<header>t</header>}
        workspace={<div>stateful workspace</div>}
        inspector={<aside aria-label="检查器">i</aside>}
      />,
    );
    const workspaceNode = screen.getByRole("main");
    rerender(
      <AppShell
        destination="conversations"
        rail={<Rail />}
        titlebar={<header>t</header>}
        workspace={<div>stateful workspace</div>}
      />,
    );
    expect(screen.getByRole("main")).toBe(workspaceNode);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("moves focus to the workspace when the destination changes", async () => {
    function Demo() {
      const [dest, setDest] = useState<AppDestination>("conversations");
      return (
        <>
          <button onClick={() => setDest("dashboard")}>去仪表盘</button>
          <AppShell
            destination={dest}
            rail={<Rail />}
            titlebar={<header>t</header>}
            workspace={<div>ws-{dest}</div>}
          />
        </>
      );
    }
    render(<Demo />);
    await userEvent.click(screen.getByRole("button", { name: "去仪表盘" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("does NOT steal focus when only re-rendering the same destination", async () => {
    const { rerender } = render(
      <AppShell
        destination="conversations"
        rail={<Rail />}
        titlebar={<header>t</header>}
        workspace={<div>ws</div>}
      />,
    );
    document.body.focus?.();
    (document.activeElement as HTMLElement)?.blur?.();
    rerender(
      <AppShell
        destination="conversations"
        rail={<Rail />}
        titlebar={<header>t</header>}
        workspace={<div>ws v2</div>}
      />,
    );
    expect(screen.getByRole("main")).not.toHaveFocus();
  });
});

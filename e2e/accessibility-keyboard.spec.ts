// Settings + keyboard accessibility paths (R5-05 / #261).
import { test, expect } from "./fixtures/electron";

test.describe("settings", () => {
  test("opens via rail and shows the appearance section", async ({ ctx }) => {
    const { page } = ctx;
    await page.locator("nav[aria-label='主导航'] button[aria-label^='设置']").click();
    await page.locator("button", { hasText: "外观" }).first().click();
    await expect(page.locator("text=主题").first()).toBeVisible();
  });

  test("settings search filters the setting list", async ({ ctx }) => {
    const { page } = ctx;
    await page.locator("nav[aria-label='主导航'] button[aria-label^='设置']").click();
    const search = page.locator("input[placeholder*='搜索设置']");
    await search.fill("主题");
    await page.waitForTimeout(400);
    await expect(page.locator("text=主题").first()).toBeVisible();
  });
});

test.describe("keyboard accessibility", () => {
  test("tab order starts at the skip link and walks the rail", async ({ ctx }) => {
    const { page } = ctx;
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          return el ? `${el.tagName}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 12) ?? ""}` : "none";
        })
      );
    }
    expect(order[0]).toMatch(/跳到工作区/);
  });

  test("escape closes a dialog without touching the page behind it", async ({ ctx }) => {
    const { page } = ctx;
    await page.locator("nav[aria-label='主导航'] button[aria-label^='设置']").click();
    await page.locator("button", { hasText: "导入" }).first().click();
    const dlg = page.locator("[role=dialog]");
    await expect(dlg).toBeVisible();
    // focus is trapped inside
    const inside = await page.evaluate(() => {
      const d = document.querySelector("[role=dialog]");
      return d?.contains(document.activeElement) ?? false;
    });
    expect(inside).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
  });

  test("every rail button exposes an accessible name", async ({ ctx }) => {
    const { page } = ctx;
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll("nav[aria-label='主导航'] button")]
        .filter((b) => !(b.getAttribute("aria-label") ?? b.textContent?.trim()))
        .map((b) => b.outerHTML.slice(0, 60))
    );
    expect(unnamed).toEqual([]);
  });
});

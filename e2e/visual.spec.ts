// Visual baselines (R5-05 / #261): theme, breakpoints, zoom, reduced-motion.
import { test, expect } from "./fixtures/electron";

async function openAppearance(page: import("@playwright/test").Page) {
  await page.locator("nav[aria-label='主导航'] button[aria-label^='设置']").click();
  await page.locator("button", { hasText: "外观" }).first().click();
  await page.waitForSelector("text=主题", { timeout: 5000 });
}

test.describe("visual regression", () => {
  test("dark and light baselines at 1440×900", async ({ ctx }) => {
    const { page, app } = ctx;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    });
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot("home-dark-1440x900.png");

    await openAppearance(page);
    await page.getByRole("radio", { name: "浅色", exact: true }).click();
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot("home-light-1440x900.png");
  });

  test("980px sidebar breakpoint", async ({ ctx }) => {
    const { page, app } = ctx;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(980, 800);
    });
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot("shell-980px.png");
  });

  test("1180px inspector breakpoint", async ({ ctx }) => {
    const { page, app } = ctx;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1180, 900);
    });
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot("shell-1180px.png");
  });

  test("150% zoom stays usable (no horizontal scrollbar)", async ({ ctx }) => {
    const { page } = ctx;
    await openAppearance(page);
    await page.locator("button, [role=radio]").filter({ hasText: /^150%$/ }).first().click();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("appearance-zoom-150.png");
    const noHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2
    );
    expect(noHScroll).toBe(true);
  });

  test("reduced-motion zeroes transition durations", async ({ ctx }) => {
    const { page } = ctx;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(300);
    const durs = await page.evaluate(() =>
      [...document.querySelectorAll("button, nav")].slice(0, 12).map((el) => getComputedStyle(el).transitionDuration)
    );
    for (const d of durs) expect(parseFloat(d)).toBeLessThanOrEqual(0.01);
    await expect(page).toHaveScreenshot("shell-reduced-motion.png");
  });
});

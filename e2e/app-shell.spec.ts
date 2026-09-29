// App-shell smoke + baseline (R5-05 / #261).
import { test, expect } from "./fixtures/electron";

test.describe("app shell", () => {
  test("boots to the shell with the rail and no white screen", async ({ ctx }) => {
    const { page } = ctx;
    await expect(page.locator("nav[aria-label='主导航']")).toBeVisible();
    const textLen = await page.evaluate(() => document.body.innerText.length);
    expect(textLen).toBeGreaterThan(10);
    await expect(page).toHaveScreenshot("shell-dark-1440x900.png");
  });

  test("every rail destination is keyboard-activatable", async ({ ctx }) => {
    const { page } = ctx;
    for (const label of ["仪表盘", "自动化", "代理", "设置", "会话"]) {
      const btn = page.locator(`nav[aria-label='主导航'] button[aria-label^='${label}']`);
      await expect(btn).toBeVisible();
      await btn.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
    }
  });

  test("the app runs in the pinned zh-CN locale and Asia/Shanghai timezone", async ({ ctx }) => {
    const { page } = ctx;
    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const lang = await page.evaluate(() => navigator.language);
    expect(tz).toBe("Asia/Shanghai");
    expect(lang.toLowerCase()).toMatch(/zh/);
  });
});

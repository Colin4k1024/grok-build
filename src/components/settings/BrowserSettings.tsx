import { useState, useEffect } from "react";
import { probeBrowserCaps, type BrowserCapabilities } from "../../lib/browserCapabilities";

export function BrowserSettings() {
  const [caps, setCaps] = useState<BrowserCapabilities>({
    browserAvailable: false,
    computerAvailable: false,
    reason: null,
  });

  useEffect(() => { setCaps(probeBrowserCaps()); }, []);

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">浏览器与桌面控制</h3>
        <p className="mb-3 text-[11px] leading-relaxed text-gb-muted">
          Browser Use 允许 agent 在受控浏览器中执行网页操作。
          Computer Use 允许 agent 截取和分析屏幕内容（Appshots）。
          两项功能都会显示系统权限请求，仅在你批准后执行。
        </p>

        <div className="rounded-lg border border-gb-border bg-gb-surface">
          {/* Browser row */}
          <div className="flex items-center justify-between border-b border-gb-border/30 px-4 py-3">
            <div>
              <p className="text-xs font-medium text-gb-text">🌐 浏览器控制</p>
              <p className="mt-0.5 text-[10px] text-gb-muted">
                通过 Managed Browser（Puppeteer/Playwright）在隔离环境中浏览网页
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                caps.browserAvailable
                  ? "bg-gb-green/15 text-gb-green"
                  : "bg-gb-yellow/15 text-gb-yellow"
              }`}
            >
              {caps.browserAvailable ? "已就绪" : "未配置"}
            </span>
          </div>

          {/* Computer row */}
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-xs font-medium text-gb-text">🖥️ 桌面控制 (Computer Use)</p>
              <p className="mt-0.5 text-[10px] text-gb-muted">
                截取屏幕内容并鼠标/键盘操作（需系统辅助功能权限）
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                caps.computerAvailable
                  ? "bg-gb-green/15 text-gb-green"
                  : "bg-gb-yellow/15 text-gb-yellow"
              }`}
            >
              {caps.computerAvailable ? "已就绪" : "未配置"}
            </span>
          </div>
        </div>

        {caps.reason && (
          <div className="mt-3 rounded-md border border-gb-yellow/30 bg-gb-yellow/5 px-3 py-2 text-[11px] text-gb-yellow">
            ⚠️ {caps.reason}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">配置说明</h3>
        <div className="space-y-2 text-[11px] leading-relaxed text-gb-muted">
          <p>
            <strong>浏览器控制</strong>：配置一个支持浏览器操作的 MCP 服务器，
            如 <code className="rounded bg-gb-surface-solid px-1 font-mono text-[10px]">@anthropic/mcp-server-puppeteer</code>。
            前往设置 → MCP 服务器添加。
          </p>
          <p>
            <strong>桌面控制</strong>：需要在系统偏好设置中授予辅助功能权限，
            并配置 Appshot 支持的 MCP 服务器。
          </p>
          <p>
            开发环境可使用环境变量强制启用：
            <code className="ml-1 rounded bg-gb-surface-solid px-1 font-mono text-[10px]">GROK_BROWSER_ENABLED=1 GROK_COMPUTER_ENABLED=1</code>
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-gb-text">风险提醒</h3>
        <div className="space-y-1 text-[11px] leading-relaxed text-gb-muted">
          <p>• 浏览器控制允许 agent 浏览任意网页、填写表单和提交数据</p>
          <p>• 桌面控制允许 agent 看到你的屏幕内容和操作你的桌面</p>
          <p>• 每次敏感操作都会显示确认提示 — 注意审查后再批准</p>
          <p>• 可随时在设置中关闭这些权限</p>
        </div>
      </section>
    </div>
  );
}
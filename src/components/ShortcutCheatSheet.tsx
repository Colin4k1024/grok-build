import { useState, useEffect } from "react";

const SHORTCUTS = [
  { keys: "⌘T", action: "新建会话标签页" },
  { keys: "⌘W", action: "关闭当前标签页" },
  { keys: "⌘1-9", action: "切换到第 N 个标签页" },
  { keys: "⌘⇧P", action: "命令面板" },
  { keys: "⌘K", action: "命令面板（备用）" },
  { keys: "⌘⇧A", action: "显示/隐藏窗口（全局）" },
  { keys: "?", action: "打开本快捷键面板" },
  { keys: "Esc", action: "关闭浮层 / 取消" },
];

export function ShortcutCheatSheet() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        setShow((v) => !v);
      } else if (e.key === "Escape" && show) {
        setShow(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [show]);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => setShow(false)}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-gb-border bg-gb-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold text-gb-text">键盘快捷键</h2>
        <div className="space-y-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between">
              <span className="text-xs text-gb-muted">{s.action}</span>
              <kbd className="rounded border border-gb-border bg-gb-bg px-2 py-0.5 text-[10px] text-gb-text">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
        <button
          onClick={() => setShow(false)}
          className="mt-4 w-full rounded bg-gb-accent py-1.5 text-xs text-gb-bg"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

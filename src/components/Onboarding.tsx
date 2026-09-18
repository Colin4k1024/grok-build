import { useState, useEffect } from "react";

const ONBOARDING_KEY = "gb-onboarding-completed";

const STEPS = [
  {
    icon: "🤖",
    title: "欢迎使用 Grok Build",
    body: "你的 AI 编程助手，支持多会话、ACP 桥接和内嵌终端。先快速了解一下吧。",
  },
  {
    icon: "📑",
    title: "多会话标签",
    body: "用 Cmd+T 创建多个会话。每个标签页都是独立工作目录中的 Agent 对话，用 Cmd+1-9 切换。",
  },
  {
    icon: "💬",
    title: "对话与工具",
    body: "在输入区发送消息。Agent 可以使用工具——需要时直接在对话中批准。工具结果以卡片形式显示在消息流中。",
  },
  {
    icon: "⚡",
    title: "命令面板",
    body: "按 Cmd+Shift+P（或 Cmd+K）打开命令面板，搜索并执行任意操作——新建会话、打开设置、切换面板等。",
  },
  {
    icon: "🔧",
    title: "设置与插件",
    body: "在「设置」中配置模型、API 密钥、MCP 服务器、插件和主题。通过侧边栏的「仪表盘」总览所有会话和子代理。",
  },
];

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const completed = localStorage.getItem(ONBOARDING_KEY);
    if (!completed) {
      setShow(true);
    }
  }, []);

  function handleNext() {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      handleFinish();
    }
  }

  function handleSkip() {
    handleFinish();
  }

  function handleFinish() {
    localStorage.setItem(ONBOARDING_KEY, "true");
    setShow(false);
    onComplete();
  }

  if (!show) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gb-border bg-gb-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gb-border px-6 py-3">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? "w-6 bg-gb-accent" : i < step ? "w-1.5 bg-gb-accent/50" : "w-1.5 bg-gb-border"
                }`}
              />
            ))}
          </div>
          <button
            onClick={handleSkip}
            className="text-[10px] text-gb-muted hover:text-gb-text"
          >
            跳过
          </button>
        </div>

        {/* Content */}
        <div className="px-8 py-8 text-center">
          <div className="mb-4 text-5xl">{current.icon}</div>
          <h2 className="mb-2 text-lg font-semibold text-gb-text">{current.title}</h2>
          <p className="text-sm text-gb-muted">{current.body}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gb-border px-6 py-3">
          <span className="text-[10px] text-gb-muted">
            Step {step + 1} of {STEPS.length}
          </span>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="rounded border border-gb-border px-4 py-1.5 text-xs text-gb-muted hover:text-gb-text"
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="rounded bg-gb-accent px-4 py-1.5 text-xs text-gb-bg"
            >
              {isLast ? "开始使用" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function isOnboardingCompleted(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === "true";
}

export function resetOnboarding() {
  localStorage.removeItem(ONBOARDING_KEY);
}

import { useState, useEffect } from "react";

const ONBOARDING_KEY = "gb-onboarding-completed";

const STEPS = [
  {
    icon: "🤖",
    title: "Welcome to Grok Build",
    body: "Your AI coding assistant with multi-session support, ACP bridge, and terminal embedding. Let's take a quick tour.",
  },
  {
    icon: "📑",
    title: "Multi-Session Tabs",
    body: "Create multiple sessions with Cmd+T. Each tab is an independent agent conversation in its own working directory. Switch tabs with Cmd+1-9.",
  },
  {
    icon: "💬",
    title: "Chat & Tools",
    body: "Send messages in the input area. The agent can use tools — approve them inline when needed. Tool results appear as cards in the message stream.",
  },
  {
    icon: "⚡",
    title: "Command Palette",
    body: "Press Cmd+Shift+P (or Cmd+K) to open the command palette. Search and execute any action — create sessions, open settings, toggle panels, and more.",
  },
  {
    icon: "🔧",
    title: "Settings & Plugins",
    body: "Configure models, API keys, MCP servers, plugins, and themes in Settings. Use the Dashboard (from the sidebar) to overview all sessions and subagents.",
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
            Skip
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
              className="rounded bg-gb-accent px-4 py-1.5 text-xs text-white"
            >
              {isLast ? "Get Started" : "Next"}
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

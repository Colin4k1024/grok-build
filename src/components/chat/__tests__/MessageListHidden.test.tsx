// @vitest-environment jsdom
/**
 * MessageList hidden-subtree re-pin regression test (R4-04/#237 follow-up):
 * with a stubbed IntersectionObserver and zeroed jsdom geometry, the list
 * must NOT clobber the follow flag while hidden, and MUST re-pin on becoming
 * visible when the user was following.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type ChatMessage, type SessionTab } from "../../../stores/sessionStore";

// jsdom has no IntersectionObserver — stub it and capture the callback.
let ioCallback: IntersectionObserverCallback | null = null;
class FakeIO {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(cb: IntersectionObserverCallback) {
    ioCallback = cb;
  }
}
vi.stubGlobal("IntersectionObserver", FakeIO);

import { MessageList } from "../MessageList";

const tab: SessionTab = {
  id: "s1", acpSessionId: "s1", title: "t", cwd: "/p", model: "m",
  reasoningEffort: "medium", createdAt: 1, lastActiveAt: 1,
};

function seedMessages(n: number) {
  const messages: ChatMessage[] = Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? "assistant" : "user",
    content: `消息 ${i}`,
    timestamp: i,
  })) as unknown as ChatMessage[];
  useSessionStore.setState({
    tabs: [tab],
    activeSessionId: "s1",
    messages: { s1: messages },
    pendingPermissions: {},
    pendingQuestions: {},
    subagents: {},
    todos: {},
    tokenUsage: {},
    compacting: {},
    compactionMarkers: {},
    preCompactSnapshot: {},
    queuedPrompts: {},
    isStreaming: false,
    streaming: {},
  });
}

describe("MessageList hidden-subtree re-pin", () => {
  beforeEach(() => {
    localStorage.clear();
    ioCallback = null;
  });

  it("hidden period does not clobber follow state; becoming visible re-pins", () => {
    seedMessages(5);
    const { container } = render(<MessageList />);
    const scroller = container.querySelector<HTMLDivElement>(".overflow-y-auto")!;
    // Simulate an overflowing list: scrollHeight > clientHeight.
    let hidden = false;
    Object.defineProperty(scroller, "scrollHeight", {
      get: () => (hidden ? 0 : 2000),
      configurable: true,
    });
    Object.defineProperty(scroller, "clientHeight", { get: () => (hidden ? 0 : 500), configurable: true });
    scroller.scrollTop = 2000;

    // hide the subtree → measurements would read 0
    hidden = true;
    scroller.scrollTop = 0;
    act(() => {
      ioCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    // more content streams in while hidden
    act(() => {
      seedMessages(8);
    });

    // visible again — must re-pin to bottom (follow was true before hiding)
    hidden = false;
    act(() => {
      ioCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, beforeAll } from "vitest";

// Zustand persist middleware reads/writes localStorage — isolate every test.
// Guarded because node-environment suites (electron fs tests) have no DOM.
beforeEach(() => {
  globalThis.localStorage?.clear();
});

// jsdom does not implement scrollIntoView; autocomplete popovers call it.
// jsdom also has no ResizeObserver — react-window v2 uses it to measure the
// scroll container (contentRect) and individual rows (borderBoxSize). We stub
// it so the virtualized sidebar is testable: the container reports a realistic
// 800px viewport (every existing ThreadTree fixture has <30 rows, so all render
// and are queryable), and rows report blockSize 0. react-window v2's row
// measurer does `blockSize && setRowHeight(...)` — a falsy blockSize makes it
// keep the `rowHeight` estimate (28/22/24px) instead of collapsing to jsdom's
// 0px layout height (R5-06 #262).
beforeAll(() => {
  if (typeof window !== "undefined") {
    window.HTMLElement.prototype.scrollIntoView = () => {};
    if (typeof window.ResizeObserver === "undefined") {
      class TestResizeObserver implements ResizeObserver {
        private cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
        observe(target: Element) {
          this.cb(
            [
              {
                target,
                contentRect: {
                  x: 0, y: 0, top: 0, left: 0,
                  width: 1000, height: 800, bottom: 800, right: 1000,
                  toJSON: () => ({}),
                },
                borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
                contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
                devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
              } as unknown as ResizeObserverEntry,
            ],
            this
          );
        }
        unobserve() {}
        disconnect() {}
      }
      window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
      globalThis.ResizeObserver = window.ResizeObserver;
    }
  }
});

afterEach(() => {
  cleanup();
});

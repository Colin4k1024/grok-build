import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, beforeAll } from "vitest";

// Zustand persist middleware reads/writes localStorage — isolate every test.
// Guarded because node-environment suites (electron fs tests) have no DOM.
beforeEach(() => {
  globalThis.localStorage?.clear();
});

// jsdom does not implement scrollIntoView; autocomplete popovers call it.
beforeAll(() => {
  if (typeof window !== "undefined") {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
});

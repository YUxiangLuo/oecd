import { afterEach, expect, test } from "bun:test";
import { revealFocusedWhileSettling } from "./content-scroll";

const realResizeObserver = globalThis.ResizeObserver;
afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  document.body.innerHTML = "";
});

/** A course scroller with a focusable heading, and a ResizeObserver whose callback the test fires itself. */
function setup() {
  const callbacks: (() => void)[] = [];
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() { disconnected = true; }
  } as unknown as typeof ResizeObserver;
  const scroller = document.createElement("main");
  scroller.className = "content";
  const page = document.createElement("div");
  const heading = document.createElement("h3");
  heading.tabIndex = -1;
  page.append(heading);
  scroller.append(page);
  document.body.append(scroller);
  const scrolls: ScrollToOptions[] = [];
  scroller.scrollTo = ((options: ScrollToOptions) => { scrolls.push(options); }) as typeof scroller.scrollTo;
  heading.focus();
  return { heading, scrolls, resize: () => callbacks.forEach((callback) => callback()), disconnected: () => disconnected };
}

test("keeps a focused heading in view while the page above it grows", () => {
  const { heading, scrolls, resize, disconnected } = setup();
  const stop = revealFocusedWhileSettling(heading);
  expect(scrolls).toHaveLength(1);
  resize();
  resize();
  expect(scrolls).toHaveLength(3);
  stop();
  expect(disconnected()).toBe(true);
});

test("stops following once the student scrolls or focus moves on", () => {
  const first = setup();
  revealFocusedWhileSettling(first.heading);
  window.dispatchEvent(new Event("wheel"));
  expect(first.disconnected()).toBe(true);

  document.body.innerHTML = "";
  const second = setup();
  revealFocusedWhileSettling(second.heading);
  second.heading.blur();
  second.resize();
  expect(second.scrolls).toHaveLength(1);
  expect(second.disconnected()).toBe(true);
});

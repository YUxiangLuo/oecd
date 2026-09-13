import { describe, expect, test } from "bun:test";
import { resetStepScroller, revealOutlineStep } from "./step-navigation";

describe("current outline item visibility", () => {
  function outline(top: number, bottom: number) {
    const list = document.createElement("div");
    const button = document.createElement("button");
    button.setAttribute("aria-current", "step");
    list.append(button);
    list.scrollTop = 100;
    list.getBoundingClientRect = () => ({ top: 200, bottom: 800 }) as DOMRect;
    button.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    button.focus = () => { throw new Error("outline scrolling must not steal focus"); };
    button.scrollIntoView = () => { throw new Error("must not scroll application ancestors"); };
    return list;
  }
  test("reveals a lower item using only the outline's own scroll offset", () => {
    const list = outline(810, 860);
    revealOutlineStep(list);
    expect(list.scrollTop).toBe(160);
  });
  test("reveals an upper item without resetting the entire outline", () => {
    const list = outline(160, 210);
    revealOutlineStep(list);
    expect(list.scrollTop).toBe(60);
  });
  test("does not move an already visible item", () => {
    const list = outline(250, 300);
    revealOutlineStep(list);
    expect(list.scrollTop).toBe(100);
  });
  test("tolerates no mounted outline or current item", () => {
    expect(() => revealOutlineStep(null)).not.toThrow();
    expect(() => revealOutlineStep(document.createElement("div"))).not.toThrow();
  });
});

describe("step navigation scroll restoration", () => {
  test("resets both axes before rendering the destination step", () => {
    let received: ScrollToOptions | undefined;
    resetStepScroller({ scrollTo: (options) => { received = options; } });

    expect(received).toEqual({ top: 0, left: 0, behavior: "auto" });
  });

  test("accepts a missing scroller during application boot", () => {
    expect(() => resetStepScroller(null)).not.toThrow();
  });
});

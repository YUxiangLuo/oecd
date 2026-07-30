import { describe, expect, test } from "bun:test";
import { resetStepScroller } from "./step-navigation";

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

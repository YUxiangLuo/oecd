import { describe, expect, test } from "bun:test";
import { STEP10_DEFAULT_LENS, STEP10_LENSES } from "./step11";

describe("step 10 network lenses", () => {
  test("opens with the trade network first for a new session", () => {
    expect(STEP10_DEFAULT_LENS).toBe("network");
    expect(STEP10_LENSES.map(({ key }) => key)).toEqual(["network", "heat"]);
  });
});

import { describe, expect, test } from "bun:test";
import { classifyPolicyCoefficients } from "./regteach";
import type { CoefStat } from "./types";

const coef = (name: string): CoefStat => ({
  name, coef: 0, se: 0.1, t: 0, p: 1, stars: "", ci_low: -0.2, ci_high: 0.2,
});

describe("classifyPolicyCoefficients", () => {
  test("separates event main effects, BaseGVC interactions and controls", () => {
    const groups = classifyPolicyCoefficients([
      coef("k=-2"),
      coef("k=0"),
      coef("k=-2×base_gvc"),
      coef("k=0×base_gvc"),
      coef("log_gdp"),
    ], ["log_gdp"]);

    expect(groups.policy.map((item) => item.name)).toEqual([
      "k=-2", "k=0", "k=-2×base_gvc", "k=0×base_gvc",
    ]);
    expect(groups.eventMain.map((item) => item.name)).toEqual(["k=-2", "k=0"]);
    expect(groups.eventInteraction.map((item) => item.name)).toEqual(["k=-2×base_gvc", "k=0×base_gvc"]);
  });
});

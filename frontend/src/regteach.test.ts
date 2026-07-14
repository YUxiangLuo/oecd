import { describe, expect, test } from "bun:test";
import { classifyPolicyCoefficients, interpretResult } from "./regteach";
import type { CoefStat, RegressionResponse } from "./types";

const coef = (name: string): CoefStat => ({ name, coef: 0, se: 0.1, t: 0, p: 1, stars: "" });

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

  test("parallel-trends wording ignores significant pre-period interactions", () => {
    const response = {
      design: { method: "事件研究", controls: [] },
      result: {
        coefs: [
          coef("k=-2"),
          coef("k=0"),
          { ...coef("k=-2×base_gvc"), p: 0.001, stars: "***" },
        ],
      },
    } as unknown as RegressionResponse;

    expect(interpretResult(13, response)[0]).toContain("均不显著");
  });

  test("uses the selected policy intensity instead of calling every shock a tariff", () => {
    const response = {
      design: { method: "双向固定效应", shock_type: "制裁清单", controls: [] },
      result: { coefs: [{ ...coef("sanction_shock"), coef: -0.2 }] },
    } as unknown as RegressionResponse;

    const text = interpretResult(13, response).join("\n");
    expect(text).toContain("制裁清单强度每上升 1 个百分点");
    expect(text).not.toContain("额外关税");
  });
});

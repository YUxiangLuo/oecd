import { describe, expect, test } from "bun:test";
import { isQualifiedRegressionResult, nextRegressionSave } from "./regression-save";

const qualified = {
  design: { method: "twfe_intensity", interaction: false },
  result: { status: "warning", support: { status: "warning", suppress_inference: false } },
};
const insufficient = {
  design: { method: "twfe_intensity", interaction: false },
  result: { status: "insufficient", support: { status: "insufficient", suppress_inference: true } },
};

describe("fixed regression persistence", () => {
  test("qualifies only unsuppressed fixed TWFE results", () => {
    expect(isQualifiedRegressionResult(qualified.result, "twfe_intensity", false)).toBe(true);
    expect(isQualifiedRegressionResult(qualified.result, "did", false)).toBe(false);
    expect(isQualifiedRegressionResult(qualified.result, "twfe_intensity", true)).toBe(false);
    expect(isQualifiedRegressionResult(insufficient.result, "twfe_intensity", false)).toBe(false);
    expect(isQualifiedRegressionResult(
      { status: "ok", support: { status: "warning", suppress_inference: false } },
      "twfe_intensity", false,
    )).toBe(false);
  });

  test("keeps the last qualified result after an unsupported rerun", () => {
    const first = nextRegressionSave(undefined, qualified);
    expect(first).toEqual({ run: qualified, qualified_run: qualified });
    expect(nextRegressionSave(first, insufficient)).toEqual({
      run: insufficient,
      qualified_run: qualified,
    });
    expect(nextRegressionSave(undefined, insufficient)).toEqual({ run: insufficient });
  });
});

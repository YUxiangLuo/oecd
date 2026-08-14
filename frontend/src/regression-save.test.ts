import { describe, expect, test } from "bun:test";
import { isQualifiedRegressionResult, nextRegressionSave } from "./regression-save";

const qualified = {
  settings: { shockType: "tariff" },
  design: { outcome: "trade" },
  result: { status: "warning", support: { status: "warning", suppress_inference: false } },
};

const insufficient = {
  settings: { shockType: "export_control" },
  design: { outcome: "trade" },
  result: { status: "insufficient", support: { status: "insufficient", suppress_inference: true } },
};

describe("regression persistence for the report gate", () => {
  test("treats ok/warning without suppressed inference as qualified", () => {
    expect(isQualifiedRegressionResult(qualified.result)).toBe(true);
    expect(isQualifiedRegressionResult({ status: "ok" })).toBe(true);
    expect(isQualifiedRegressionResult(insufficient.result)).toBe(false);
    expect(isQualifiedRegressionResult({ status: "warning", support: { status: "insufficient" } })).toBe(false);
    expect(isQualifiedRegressionResult({ status: "ok", support: { suppress_inference: true } })).toBe(false);
  });

  test("keeps the last qualified run when a later result cannot be reported", () => {
    const afterQualified = nextRegressionSave(undefined, qualified);
    expect(afterQualified).toEqual({ run: qualified, qualified_run: qualified });

    const afterInsufficient = nextRegressionSave(afterQualified, insufficient);
    expect(afterInsufficient.run).toBe(insufficient);
    expect(afterInsufficient.qualified_run).toBe(qualified);
  });

  test("does not invent a qualified snapshot from an insufficient-only history", () => {
    expect(nextRegressionSave(undefined, insufficient)).toEqual({ run: insufficient });
  });
});

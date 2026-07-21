import { describe, expect, test } from "bun:test";
import type { QcCheck } from "../../types";
import { qcResultLabel } from "./qc-checks-table";

const check = (passed: boolean, severity: QcCheck["severity"]): QcCheck => ({
  name: "test",
  kind: "数值",
  passed,
  detail: "",
  warnings: [],
  severity,
});

describe("QC result labels", () => {
  test("does not render a warning as fatal", () => {
    expect(qcResultLabel(check(false, "warning")).text).toBe("⚠ Warning");
    expect(qcResultLabel(check(false, "fatal")).text).toBe("✗ Fatal");
  });

  test("keeps passed disclosures visible", () => {
    expect(qcResultLabel(check(true, "disclosure")).text).toBe("✓ 通过·需披露");
    expect(qcResultLabel(check(true, "ok")).text).toBe("✓ 通过");
  });
});

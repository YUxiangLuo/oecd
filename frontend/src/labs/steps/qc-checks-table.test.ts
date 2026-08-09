import { describe, expect, test } from "bun:test";
import type { QcCheck } from "../../types";
import { qcResultLabel, studentQcText } from "./qc-checks-table";

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
    expect(qcResultLabel(check(false, "warning")).text).toBe("⚠ 警告");
    expect(qcResultLabel(check(false, "fatal")).text).toBe("✗ 严重错误");
  });

  test("keeps passed disclosures visible", () => {
    expect(qcResultLabel(check(true, "disclosure")).text).toBe("✓ 通过 · 需持续说明");
    expect(qcResultLabel(check(true, "ok")).text).toBe("✓ 通过");
  });

  test("translates machine vocabulary before showing QC text to students", () => {
    expect(studentQcText("treated 标记;控制变量 schema;教学 mock crosswalk"))
      .toBe("处理组标记；控制变量字段结构；教学 拟真教学数据 映射表");
    expect(studentQcText("('ITA', 'C19'): SVA≤0;误差 0.3 Million USD;INVNT 披露"))
      .toBe("ITA · C19：总增加值（SVA）≤0；误差 0.3 百万美元；存货变化（INVNT） 持续说明");
    expect(studentQcText("INVNT(库存变化)")).toBe("存货变化（INVNT）");
  });
});

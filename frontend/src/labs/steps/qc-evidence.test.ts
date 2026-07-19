import { describe, expect, test } from "bun:test";
import type { QcCheck } from "../../types";
import { qcDisclosureItems } from "./qc-evidence";

const check = (name: string, passed: boolean, severity?: QcCheck["severity"]): QcCheck => ({
  name,
  kind: "数值",
  passed,
  detail: "",
  warnings: [],
  severity,
});

describe("QC evidence disclosure contract", () => {
  test("merges year and control checks using the server's stable prefixes", () => {
    expect(qcDisclosureItems(
      [check("失败检查", false, "fatal")],
      [check("控制检查", false, "warning")],
    )).toEqual(["失败检查", "控制变量: 控制检查"]);
  });

  test("includes passed checks that still require disclosure and excludes clean checks", () => {
    expect(qcDisclosureItems(
      [check("带提示", true, "disclosure"), check("干净", true, "ok")],
      [check("控制警告", true, "warning")],
    )).toEqual(["带提示", "控制变量: 控制警告"]);
  });
});

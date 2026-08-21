import { describe, expect, test } from "bun:test";
import type { QcCheck, QcContract } from "../../types";
import {
  inspectQcSection,
  QC_CONTRACT_VERSION,
  QC_EXPECTED_CHECKS,
  QC_FAILURE_SEVERITIES,
  summarizeQcSections,
  type QcScope,
} from "./qc-contract";

const contract = (version = QC_CONTRACT_VERSION): QcContract => ({
  version,
  scopes: {
    icio: QC_EXPECTED_CHECKS.icio.map((name) => ({
      name,
      failure_severity: QC_FAILURE_SEVERITIES.icio[name],
    })),
    controls: QC_EXPECTED_CHECKS.controls.map((name) => ({
      name,
      failure_severity: QC_FAILURE_SEVERITIES.controls[name],
    })),
    shocks: QC_EXPECTED_CHECKS.shocks.map((name) => ({
      name,
      failure_severity: QC_FAILURE_SEVERITIES.shocks[name],
    })),
  },
});

const checks = (scope: QcScope): QcCheck[] => QC_EXPECTED_CHECKS[scope].map((name) => ({
  name,
  kind: "结构",
  passed: true,
  detail: "ok",
  warnings: [],
  severity: "ok",
}));

const summary = (annual: QcCheck[] | null, controls: QcCheck[] | null, qcContract = contract()) => (
  summarizeQcSections([
    { label: "OECD ICIO", state: inspectQcSection(annual, qcContract, "icio"), error: null },
    { label: "国家-年份控制变量", state: inspectQcSection(controls, qcContract, "controls"), error: null },
  ])
);

describe("versioned QC exact-set contract", () => {
  test("never lets five valid controls offset an empty annual QC response", () => {
    const state = summary([], checks("controls"));
    expect(state.blockedReason).not.toBeNull();
    expect(state.text).toContain("无效或不完整");
    expect(state.text).not.toContain("全部通过");
    expect(state.allChecks).toHaveLength(0);
  });

  test("rejects missing, duplicate, and unknown checks", () => {
    const valid = checks("icio");
    expect(inspectQcSection(valid.slice(0, -1), contract(), "icio").status).toBe("invalid");
    expect(inspectQcSection([...valid, valid[0]], contract(), "icio").reason).toContain("重复");
    const unknown = valid.map((row) => ({ ...row }));
    unknown[0].name = "未知检查";
    expect(inspectQcSection(unknown, contract(), "icio").reason).toContain("不完整");
  });

  test("rejects unsupported and modified contract metadata", () => {
    expect(summary(checks("icio"), checks("controls"), contract(1)).blockedReason).not.toBeNull();
    const changed = contract();
    changed.scopes.controls[0].name = "未知检查";
    expect(summary(checks("icio"), checks("controls"), changed).blockedReason).not.toBeNull();
  });

  test("accepts a complete mixed warning/disclosure set without calling it all-pass", () => {
    const annual = checks("icio").map((row) => ({ ...row }));
    annual[0] = { ...annual[0], warnings: ["需披露"], severity: "disclosure" };
    annual[3] = { ...annual[3], passed: false, warnings: ["需关注"], severity: "warning" };
    const state = summary(annual, checks("controls"));
    expect(state.blockedReason).toBeNull();
    expect(state.failures).toBe(1);
    expect(state.text).toContain("1 项异常");
    expect(state.text).not.toContain("全部通过");
  });

  test("rejects downgrading a fatal check to warning", () => {
    const annual = checks("icio").map((row) => ({ ...row }));
    annual[0] = { ...annual[0], passed: false, severity: "warning" };
    expect(inspectQcSection(annual, contract(), "icio").reason).toContain("必须为 fatal");

    const changed = contract();
    changed.scopes.icio[0].failure_severity = "warning";
    expect(summary(checks("icio"), checks("controls"), changed).blockedReason).not.toBeNull();
  });
});

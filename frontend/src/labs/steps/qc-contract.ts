import type { QcCheck, QcContract } from "../../types";

export const QC_CONTRACT_VERSION = 2;
export const QC_EXPECTED_CHECKS = {
  icio: [
    "维度一致性与索引对齐(Z/Y/A/L/x/OUT)",
    "缺失值 / 负值检查",
    "会计恒等式(原始OUT = Z行和 + Y行和)",
    "因子投入与派生指标定义域(VA/TLS)",
    "投入侧恒等式(原始OUT = Z列和 + VA + TLS)",
    "里昂惕夫逆矩阵数值稳定性(残差/谱半径/条件数/非负性)",
    "国家/行业覆盖范围",
  ],
  controls: [
    "控制变量 schema(country/year + 控制列)",
    "控制变量维度对齐(country×year)",
    "控制变量数值有限性",
    "控制变量构造恒等式",
    "控制变量经济范围",
  ],
  shocks: [
    "冲击面板维度对齐(country×sector×year)",
    "冲击强度值域(*_shock ∈ [0,0.5])",
    "冲击事件时间线(宣布日≤生效日)",
    "treated 标记与阈值一致",
    "关税处理组覆盖比例合理性（制裁/出口管制仅描述）",
    "关税出口暴露度来源与口径",
  ],
} as const;

export type QcScope = keyof typeof QC_EXPECTED_CHECKS;

export const QC_FAILURE_SEVERITIES: Record<QcScope, Record<string, "warning" | "fatal">> = {
  icio: Object.fromEntries(QC_EXPECTED_CHECKS.icio.map((name) => [
    name,
    name === "因子投入与派生指标定义域(VA/TLS)" ? "warning" : "fatal",
  ])),
  controls: Object.fromEntries(QC_EXPECTED_CHECKS.controls.map((name) => [name, "fatal"])),
  shocks: Object.fromEntries(QC_EXPECTED_CHECKS.shocks.map((name) => [name, "fatal"])),
};

export interface QcSectionState {
  status: "loading" | "invalid" | "valid";
  reason: string | null;
  rows: QcCheck[];
}

function contractError(contract: QcContract | undefined): string | null {
  if (!contract) return "发布数据缺少 QC contract，不能确认质检状态。";
  if (contract.version !== QC_CONTRACT_VERSION) {
    return `不支持 QC contract 版本 ${contract.version}；当前仅支持版本 ${QC_CONTRACT_VERSION}。`;
  }
  const scopes = contract.scopes;
  if (!scopes || Object.keys(scopes).sort().join(",") !== "controls,icio,shocks") {
    return "QC contract 的检查范围不完整。";
  }
  for (const scope of Object.keys(QC_EXPECTED_CHECKS) as QcScope[]) {
    const actual = scopes[scope];
    const expected = QC_EXPECTED_CHECKS[scope];
    if (!Array.isArray(actual) || actual.length !== expected.length
      || actual.some((check, index) => (
        !check || typeof check !== "object"
        || check.name !== expected[index]
        || check.failure_severity !== QC_FAILURE_SEVERITIES[scope][expected[index]]
      ))) {
      return `QC contract 的 ${scope} 检查集合或失败严重度不受支持。`;
    }
  }
  return null;
}

function rowError(row: unknown, scope: QcScope, index: number): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return `${scope} 第 ${index + 1} 项不是有效对象。`;
  }
  const item = row as Record<string, unknown>;
  if (typeof item.name !== "string" || !item.name
    || typeof item.kind !== "string" || !item.kind
    || typeof item.passed !== "boolean"
    || typeof item.detail !== "string"
    || !Array.isArray(item.warnings) || item.warnings.some((warning) => typeof warning !== "string")
    || typeof item.severity !== "string"
    || !["ok", "disclosure", "warning", "fatal"].includes(item.severity)) {
    return `${scope} 第 ${index + 1} 项字段不完整或类型无效。`;
  }
  const passedSeverity = item.warnings.length > 0 ? "disclosure" : "ok";
  if ((item.passed && item.severity !== passedSeverity)
    || (!item.passed && item.severity !== "warning" && item.severity !== "fatal")) {
    return `${scope} 第 ${index + 1} 项的 passed 与 severity 矛盾。`;
  }
  const allowedFailureSeverity = QC_FAILURE_SEVERITIES[scope][item.name];
  if (!item.passed && allowedFailureSeverity && item.severity !== allowedFailureSeverity) {
    return `${scope} 第 ${index + 1} 项失败严重度必须为 ${allowedFailureSeverity}。`;
  }
  return null;
}

export function inspectQcSection(
  rows: QcCheck[] | null,
  contract: QcContract | undefined,
  scope: QcScope,
): QcSectionState {
  const invalidContract = contractError(contract);
  if (invalidContract) return { status: "invalid", reason: invalidContract, rows: [] };
  if (rows == null) return { status: "loading", reason: null, rows: [] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: "invalid", reason: `${scope} 未返回任何质检结果，不能判定通过。`, rows: [] };
  }
  for (let index = 0; index < rows.length; index += 1) {
    const invalidRow = rowError(rows[index], scope, index);
    if (invalidRow) return { status: "invalid", reason: invalidRow, rows: [] };
  }
  const names = rows.map((row) => row.name);
  if (new Set(names).size !== names.length) {
    return { status: "invalid", reason: `${scope} 质检项存在重复，不能判定通过。`, rows: [] };
  }
  const expected = QC_EXPECTED_CHECKS[scope];
  const missing = expected.filter((name) => !names.includes(name));
  const unknown = names.filter((name) => !(expected as readonly string[]).includes(name));
  if (missing.length > 0 || unknown.length > 0 || names.length !== expected.length) {
    return {
      status: "invalid",
      reason: `${scope} 质检集合不完整（缺少 ${missing.length} 项，未知 ${unknown.length} 项）。`,
      rows: [],
    };
  }
  return { status: "valid", reason: null, rows };
}

export interface QcSummaryState {
  blockedReason: string | null;
  className: "tipbox" | "warnbox";
  text: string;
  allChecks: QcCheck[];
  failures: number;
}

export function summarizeQcSections(
  sections: Array<{ label: string; state: QcSectionState; error: string | null }>,
): QcSummaryState {
  const requestErrors = sections.filter((section) => section.error != null);
  if (requestErrors.length > 0) {
    const reason = `${requestErrors.map((section) => section.label).join("、")}质检未能读取，不能确认发布状态。`;
    return { blockedReason: reason, className: "warnbox", text: reason, allChecks: [], failures: 0 };
  }
  const invalid = sections.filter((section) => section.state.status === "invalid");
  if (invalid.length > 0) {
    const reason = `${invalid.map((section) => section.label).join("、")}质检无效或不完整，不能确认发布状态。`;
    return { blockedReason: reason, className: "warnbox", text: reason, allChecks: [], failures: 0 };
  }
  const loading = sections.filter((section) => section.state.status === "loading");
  if (loading.length > 0) {
    const reason = `正在读取${loading.map((section) => section.label).join("、")}质检；加载完成前不能提交本步。`;
    return { blockedReason: reason, className: "warnbox", text: reason, allChecks: [], failures: 0 };
  }
  const allChecks = sections.flatMap((section) => section.state.rows);
  const failures = allChecks.filter((check) => !check.passed).length;
  return failures > 0
    ? {
        blockedReason: null,
        className: "warnbox",
        text: `${allChecks.length} 项质检中 ${allChecks.length - failures} 项通过、${failures} 项异常；异常项已在各表置顶。`,
        allChecks,
        failures,
      }
    : {
        blockedReason: null,
        className: "tipbox",
        text: `✓ ${allChecks.length} 项质检全部通过；仍可展开每项查看检查动机与口径。`,
        allChecks,
        failures,
      };
}

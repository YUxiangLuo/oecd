import type { QcCheck } from "../../types";

const DISCLOSURE_SEVERITIES = new Set(["disclosure", "warning", "fatal"]);

/** Stable disclosure keys shared with the server-side QC evidence issuer. */
export function qcDisclosureItems(yearChecks: QcCheck[], controlChecks: QcCheck[]): string[] {
  const required = (check: QcCheck) => !check.passed
    || (typeof check.severity === "string" && DISCLOSURE_SEVERITIES.has(check.severity));
  return [...new Set([
    ...yearChecks.filter(required).map((check) => check.name),
    ...controlChecks.filter(required).map((check) => `控制变量: ${check.name}`),
  ])];
}

export interface QcReleaseSummary {
  requiresDisclosure: boolean;
  override: boolean;
  fatal: string[];
  warning: string[];
  disclosure: string[];
}

/**
 * 汇总当前数据产物的「发布状态」:哪些 QC 项需要持续披露。
 *
 * manifest 的 qc 段按 年份 / 控制变量 / 冲击 等作用域嵌套,这里递归摊平,
 * 但只采信机器声明的字段(requires_disclosure / override / fatal / warning /
 * disclosure),不去猜测任何未声明的内容。
 *
 * 这条信息原先常驻在每一步顶部;它讲的是数据口径边界,与第 2 步「数据质检」
 * 同源,因此收敛到那一步随质检结论一起呈现,不再全局占位。
 */
export function summarizeQcRelease(qc: unknown): QcReleaseSummary {
  const out: QcReleaseSummary = { requiresDisclosure: false, override: false, fatal: [], warning: [], disclosure: [] };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item.requires_disclosure === true) out.requiresDisclosure = true;
    if (item.override === true) out.override = true;
    for (const key of ["fatal", "warning", "disclosure"] as const) {
      if (Array.isArray(item[key])) out[key].push(...item[key].filter((name): name is string => typeof name === "string"));
    }
    Object.values(item).forEach((child) => {
      if (child && typeof child === "object" && !Array.isArray(child)) visit(child);
    });
  };
  visit(qc);
  out.requiresDisclosure ||= out.override || out.fatal.length > 0 || out.warning.length > 0 || out.disclosure.length > 0;
  for (const key of ["fatal", "warning", "disclosure"] as const) out[key] = [...new Set(out[key])];
  return out;
}

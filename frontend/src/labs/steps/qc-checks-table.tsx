import { ScrollableRegion } from "../../a11y";
import type { QcCheck } from "../../types";

/**
 * 维护者诊断与步骤 10 的冲击来源/结构结果共用同一张表。
 * 每项都带「为什么检查?」的口径说明;双侧会计恒等式/维度一致性在提供 onNavigateStep 时
 * 额外给出回步骤 1 核对原始切片的入口。
 */
const WHY_CHECK: [string, string][] = [
  ["维度一致性", "Z、Y 与产出向量必须描述同一组国家–行业节点；错一行就会让矩阵乘法错位。"],
  ["缺失值 / 负值", "缺失值会沿矩阵运算扩散；不合口径的负投入会扭曲技术系数与分解结果。"],
  ["会计恒等式", "总产出应等于中间使用与最终使用之和；不闭合通常意味着漏列、错位或单位不一致。"],
  ["因子投入", "VA 与 TLS 必须完整对齐；负 VA 可以真实存在，但会让对应行业的生产份额失去通常的非负份额解释。"],
  ["投入侧恒等式", "从成本侧复核原始 OUT 是否等于中间投入、增加值和产品税净额之和。"],
  ["里昂惕夫逆矩阵", "谱半径、条件数、逆残差与非负性共同判断生产系统是否可行且数值稳定；单个 A 列和超过 1 不能单独下结论。"],
  ["国家/行业覆盖", "确认每年使用同一分析总体，避免把样本增减误当成经济变化。"],
  ["冲击面板维度", "政策变量必须与回归中的国家×行业×年份逐格对齐，重复或漏格都会改变处理组。"],
  ["冲击强度值域", "税率与暴露度都应在合理范围内；越界通常表示百分数与小数混用。"],
  ["冲击事件时间线", "宣布不能晚于生效，否则事件研究的预期效应与处理时点会被颠倒。"],
  ["treated 标记", "二元处理标记必须严格对应预先约定的冲击阈值，避免结果依赖隐含口径。"],
  ["关税处理组覆盖", "只有关税 treated 比例受 (0,25%] 发布政策约束；制裁与出口管制 treated 数量仅作描述，不据此宣称其覆盖合理。"],
  ["控制变量 schema", "固定键列与控制列名称，防止回归静默漏掉变量或把文本列当数值。"],
  ["控制变量维度", "国家级控制变量必须对每个国家–年份唯一，否则合并会复制样本并错误加权。"],
  ["控制变量数值", "NaN 与无穷值会导致估计失败或样本被静默删除。"],
  ["控制变量构造", "用定义恒等式反查派生变量，能发现分母、单位和增长率方向错误。"],
  ["控制变量经济范围", "极端但有限的数值也可能是录入或单位错误，需要在回归前暴露出来。"],
];

const whyCheck = (name: string) => WHY_CHECK.find(([prefix]) => name.startsWith(prefix))?.[1]
  ?? "确认该中间产物满足后续计算与回归所依赖的口径，避免错误在流水线中继续传播。";

export function qcResultLabel(check: QcCheck): { className: string; text: string } {
  if (check.severity === "fatal") return { className: "qc-fail", text: "✗ Fatal" };
  if (check.severity === "warning") return { className: "qc-warning", text: "⚠ Warning" };
  if (check.severity === "disclosure") return { className: "qc-warning", text: "✓ 通过·需披露" };
  return check.passed
    ? { className: "qc-pass", text: "✓ 通过" }
    : { className: "qc-fail", text: "✗ 异常" };
}

export function QcChecksTable({
  rows,
  label,
  emptyMessage,
  emptyState,
  onRetry,
  retryLabel = "重试质检",
  onNavigateStep,
}: {
  rows: QcCheck[] | null;
  label: string;
  emptyMessage?: string;
  emptyState?: "loading" | "invalid";
  onRetry?: () => void;
  retryLabel?: string;
  onNavigateStep?: (step: number) => void;
}) {
  const terminalState = emptyState ?? (rows == null ? "loading" : "invalid");
  const terminalMessage = emptyMessage ?? (
    terminalState === "loading" ? "正在读取质检结果…" : "未返回任何质检结果，不能判定通过。"
  );
  const sortedRows = [...(rows ?? [])].sort((a, b) => Number(a.passed) - Number(b.passed));
  return (
    <ScrollableRegion className="table-wrap" label={label}>
      <table className="data-table qc-table">
        <thead>
          <tr><th>质检项</th><th>类型</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 && (
            <tr>
              <td colSpan={4} className={terminalState === "invalid" ? "qc-fail" : "muted"}>
                <span>{terminalMessage}</span>
                {onRetry && (
                  <button type="button" className="secondary" onClick={onRetry} style={{ marginLeft: 12 }}>
                    {retryLabel}
                  </button>
                )}
              </td>
            </tr>
          )}
          {sortedRows.map((c) => {
            const result = qcResultLabel(c);
            const preview = c.warnings.slice(0, 2);
            const extra = c.warnings.slice(2);
            return (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>{c.kind}</td>
                <td className={result.className}>{result.text}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {c.detail}
                  {preview.map((w) => (
                    <div key={w} className="muted">⚠ {w}</div>
                  ))}
                  {extra.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary
                        aria-label={`${c.name}：还有 ${extra.length} 条明细`}
                        style={{ cursor: "pointer", color: "#4b47e0", fontWeight: 600 }}
                      >
                        还有 {extra.length} 条明细
                      </summary>
                      {extra.map((w) => (
                        <div key={w} className="muted">⚠ {w}</div>
                      ))}
                    </details>
                  )}
                  <details style={{ marginTop: 7 }}>
                    <summary
                      aria-label={`${c.name}：为什么检查？`}
                      style={{ cursor: "pointer", color: "#4b47e0", fontWeight: 600 }}
                    >
                      为什么检查？
                    </summary>
                    <div className="muted" style={{ marginTop: 5 }}>{whyCheck(c.name)}</div>
                    {onNavigateStep && (
                      c.name.startsWith("会计恒等式")
                      || c.name.startsWith("投入侧恒等式")
                      || c.name.startsWith("维度一致性")
                    ) && (
                      <div style={{ marginTop: 5 }}>
                        <button
                          onClick={() => onNavigateStep(1)}
                          style={{ border: 0, background: "transparent", padding: 0, font: "inherit", color: "#4b47e0", cursor: "pointer", textDecoration: "underline" }}
                        >
                          前往步骤1浏览 Z / Y / OUT 原始切片核对 →
                        </button>
                      </div>
                    )}
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollableRegion>
  );
}

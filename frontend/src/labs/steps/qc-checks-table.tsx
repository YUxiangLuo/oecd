import type { QcCheck } from "../../types";

/**
 * 质检结果表:ICIO/控制变量质检(第 2 步)与冲击面板质检(第 11 步)共用同一张表。
 * 每项都带「为什么检查?」的口径说明;会计恒等式/维度一致性两项在提供 onNavigateStep 时
 * 额外给出回步骤 1 核对原始切片的入口。
 */
const WHY_CHECK: [string, string][] = [
  ["维度一致性", "Z、Y 与产出向量必须描述同一组国家–行业节点；错一行就会让矩阵乘法错位。"],
  ["缺失值 / 负值", "缺失值会沿矩阵运算扩散；不合口径的负投入会扭曲技术系数与分解结果。"],
  ["会计恒等式", "总产出应等于中间使用与最终使用之和；不闭合通常意味着漏列、错位或单位不一致。"],
  ["里昂惕夫逆矩阵", "若技术系数列和异常或矩阵近奇异，逆矩阵会放大微小误差，后续所有增加值追踪都不可靠。"],
  ["国家/行业覆盖", "确认每年使用同一分析总体，避免把样本增减误当成经济变化。"],
  ["冲击面板维度", "政策变量必须与回归中的国家×行业×年份逐格对齐，重复或漏格都会改变处理组。"],
  ["冲击强度值域", "税率与暴露度都应在合理范围内；越界通常表示百分数与小数混用。"],
  ["冲击事件时间线", "宣布不能晚于生效，否则事件研究的预期效应与处理时点会被颠倒。"],
  ["treated 标记", "二元处理标记必须严格对应预先约定的冲击阈值，避免结果依赖隐含口径。"],
  ["处理组覆盖", "处理组过少无法识别效应，过多则缺少对照组；覆盖率是回归可行性的第一道检查。"],
  ["控制变量 schema", "固定键列与控制列名称，防止回归静默漏掉变量或把文本列当数值。"],
  ["控制变量维度", "国家级控制变量必须对每个国家–年份唯一，否则合并会复制样本并错误加权。"],
  ["控制变量数值", "NaN 与无穷值会导致估计失败或样本被静默删除。"],
  ["控制变量构造", "用定义恒等式反查派生变量，能发现分母、单位和增长率方向错误。"],
  ["控制变量经济范围", "极端但有限的数值也可能是录入或单位错误，需要在回归前暴露出来。"],
];

export const whyCheck = (name: string) => WHY_CHECK.find(([prefix]) => name.startsWith(prefix))?.[1]
  ?? "确认该中间产物满足后续计算与回归所依赖的口径，避免错误在流水线中继续传播。";

export function QcChecksTable({ rows, onNavigateStep }: {
  rows: QcCheck[] | null;
  onNavigateStep?: (step: number) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr><th>质检项</th><th>类型</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr>
        </thead>
        <tbody>
          {[...(rows ?? [])].sort((a, b) => Number(a.passed) - Number(b.passed)).map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>{c.kind}</td>
              <td className={c.passed ? "qc-pass" : "qc-fail"}>{c.passed ? "✓ 通过" : "✗ 异常"}</td>
              <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                {c.detail}
                {c.warnings.map((w) => (
                  <div key={w} className="muted">⚠ {w}</div>
                ))}
                <details style={{ marginTop: 7 }}>
                  <summary style={{ cursor: "pointer", color: "#4b47e0", fontWeight: 600 }}>为什么检查？</summary>
                  <div className="muted" style={{ marginTop: 5 }}>{whyCheck(c.name)}</div>
                  {onNavigateStep && (c.name.startsWith("会计恒等式") || c.name.startsWith("维度一致性")) && (
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

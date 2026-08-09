import { ScrollableRegion } from "../../a11y";
import type { QcCheck } from "../../types";

/**
 * 质检结果表:ICIO/控制变量质检(第 2 步)与冲击面板质检(第 11 步)共用同一张表。
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
  ["treated 标记", "处理组标记必须严格对应预先约定的冲击阈值，避免结果依赖隐含口径。"],
  ["处理组覆盖", "处理组过少无法识别效应，过多则缺少对照组；覆盖率是回归可行性的第一道检查。"],
  ["控制变量 schema", "固定键列与控制列名称，防止回归漏掉变量或把文本列当数值。"],
  ["控制变量维度", "国家级控制变量必须对每个国家–年份唯一，否则合并会复制样本并错误加权。"],
  ["控制变量数值", "NaN 与无穷值会导致估计失败或样本被静默删除。"],
  ["控制变量构造", "用定义恒等式反查派生变量，能发现分母、单位和增长率方向错误。"],
  ["控制变量经济范围", "极端但有限的数值也可能是录入或单位错误，需要在回归前暴露出来。"],
];

const whyCheck = (name: string) => WHY_CHECK.find(([prefix]) => name.startsWith(prefix))?.[1]
  ?? "确认该中间结果满足后续计算与回归所依赖的口径，避免错误继续传播。";

/** 机器字段留在接口中，学生界面只展示对应的课堂用语。 */
export function studentQcText(value: string): string {
  const inventoryLabel = "存货变化（INVNT）";
  const inventoryToken = "__inventory_category_label__";
  return value
    .replace(/\('([A-Z0-9_]+)', '([A-Z0-9_]+)'\)/g, "$1 · $2")
    .replaceAll("country×sector×year", "经济体×行业×年份")
    .replaceAll("country×year", "经济体×年份")
    .replaceAll("country/year", "经济体/年份")
    .replaceAll("*_shock", "冲击强度")
    .replaceAll("Million USD", "百万美元")
    .replaceAll("SVA≤0", "总增加值（SVA）≤0")
    .replaceAll("INVNT(库存变化)", inventoryToken)
    .replaceAll("INVNT（库存变化）", inventoryToken)
    .replaceAll("INVNT", inventoryLabel)
    .replaceAll(inventoryToken, inventoryLabel)
    .replaceAll("披露", "持续说明")
    .replaceAll("国家/地区", "经济体/地区账户")
    .replaceAll("国家–行业", "经济体×行业")
    .replaceAll("国家×行业", "经济体×行业")
    .replaceAll("国家–年份", "经济体–年份")
    .replaceAll("国家/行业", "经济体/行业")
    .replaceAll("国家级", "经济体层")
    .replaceAll("每个国家", "每个经济体")
    .replaceAll("treated 标记", "处理组标记")
    .replaceAll("控制变量 schema", "控制变量字段结构")
    .replaceAll("treated", "处理组")
    .replaceAll("schema", "字段结构")
    .replaceAll("crosswalk", "映射表")
    .replaceAll("mock", "拟真教学数据")
    .replaceAll(";", "；")
    .replaceAll(": ", "：")
    .replaceAll("(", "（")
    .replaceAll(")", "）")
    .replace(/,(?=\S)/g, "，");
}

export function QcSeverityGuide() {
  return (
    <div className="tipbox qc-severity-guide">
      <b>异常等级：</b>“严重错误（Fatal）”会阻止进入下游分析；“警告（Warning）”表示结果可展示但需要谨慎解释；{
        "“需持续说明（Disclosure）”表示检查已通过，但相关数据边界必须在后续分析和报告中保留。"
      }
    </div>
  );
}

export function qcResultLabel(check: QcCheck): { className: string; text: string } {
  if (check.severity === "fatal") return { className: "qc-fail", text: "✗ 严重错误" };
  if (check.severity === "warning") return { className: "qc-warning", text: "⚠ 警告" };
  if (check.severity === "disclosure") return { className: "qc-warning", text: "✓ 通过 · 需持续说明" };
  return check.passed
    ? { className: "qc-pass", text: "✓ 通过" }
    : { className: "qc-fail", text: "✗ 异常" };
}

export function QcChecksTable({ rows, onNavigateStep }: {
  rows: QcCheck[] | null;
  onNavigateStep?: (step: number) => void;
}) {
  return (
    <ScrollableRegion className="table-wrap" label="数据质检结果表，可横向滚动">
      <table className="data-table">
        <thead>
          <tr><th>质检项</th><th>类型</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr>
        </thead>
        <tbody>
          {[...(rows ?? [])].sort((a, b) => Number(a.passed) - Number(b.passed)).map((c) => {
            const result = qcResultLabel(c);
            return (
              <tr key={c.name}>
                <td>{studentQcText(c.name)}</td>
                <td>{studentQcText(c.kind)}</td>
                <td className={result.className}>{result.text}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {studentQcText(c.detail)}
                  {c.warnings.map((w) => (
                    <div key={w} className="muted">⚠ {studentQcText(w)}</div>
                  ))}
                  <details style={{ marginTop: 7 }}>
                    <summary style={{ cursor: "pointer", color: "#4b47e0", fontWeight: 600 }}>为什么检查？</summary>
                    <div className="muted" style={{ marginTop: 5 }}>{studentQcText(whyCheck(c.name))}</div>
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

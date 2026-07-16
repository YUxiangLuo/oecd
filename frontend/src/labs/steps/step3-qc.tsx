import { useState } from "react";
import { api } from "../../api";
import { EvidencePanel, JudgmentBox } from "../../step-evidence";
import type { EvidenceRules, Meta, QcCheck, StepEvidenceApi } from "../../types";
import { useAsync, YearPicker } from "../shared";

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

const whyCheck = (name: string) => WHY_CHECK.find(([prefix]) => name.startsWith(prefix))?.[1]
  ?? "确认该中间产物满足后续计算与回归所依赖的口径，避免错误在流水线中继续传播。";

/** 第 3 步的学习证据:对质检警告作出处置决定,并写下理由。 */
interface QcEvidence extends Record<string, unknown> {
  disposition?: QcDisposition;
  judgment?: string;
}

type QcDisposition = "stop" | "fix" | "disclose";

const QC_DISPOSITIONS: { key: QcDisposition; label: string; hint: string }[] = [
  { key: "stop", label: "停止分析", hint: "问题足以让后续结论失效,不应继续。" },
  { key: "fix", label: "修正数值", hint: "问题可定位且能修正,修正后再继续。" },
  { key: "disclose", label: "披露后继续", hint: "问题不影响本课结论,但必须写进报告的局限。" },
];

export function QcLab({ meta, evidence, rules, onNavigateStep }: {
  meta: Meta;
  evidence: StepEvidenceApi<QcEvidence>;
  rules: EvidenceRules;
  onNavigateStep: (step: number) => void;
}) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const { data, error } = useAsync<QcCheck[]>(() => api.qc(year), [year]);
  const { data: shockChecks, error: shockError } = useAsync<QcCheck[]>(() => api.qcShocks(), []);
  const { data: controlChecks, error: controlError } = useAsync<QcCheck[]>(() => api.qcControls(), []);
  if (error) return <div className="error-box">{error}</div>;
  // 总数从三组响应实际推导,不硬编码;加载中与读取失败分开表述,失败不会伪装成“加载中”。
  const sections = [
    { rows: data, error: null as string | null },
    { rows: shockChecks, error: shockError },
    { rows: controlChecks, error: controlError },
  ];
  const loading = sections.some((section) => section.rows == null && section.error == null);
  const failedSections = sections.filter((section) => section.error != null).length;
  const allChecks = sections.flatMap((section) => section.rows ?? []);
  const failures = allChecks.filter((check) => !check.passed).length;
  const table = (rows: QcCheck[] | null) => (
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
                  {(c.name.startsWith("会计恒等式") || c.name.startsWith("维度一致性")) && (
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
  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
      <div className={failures || failedSections ? "warnbox" : "tipbox"} style={{ marginBottom: 16, fontWeight: 700 }}>
        {loading
          ? `正在汇总质检结果… 已读取 ${allChecks.length} 项`
          : failedSections
            ? `有 ${failedSections} 组质检未能读取（详见下方错误）；已读取 ${allChecks.length} 项中 ${failures} 项异常。`
            : failures
              ? `${allChecks.length} 项质检中 ${allChecks.length - failures} 项通过、${failures} 项异常；异常项已在各表置顶。`
              : `✓ ${allChecks.length} 项质检全部通过；仍可展开每项查看检查动机与口径。`}
      </div>
      <div className="section-head">
        <span className="section-head-icon">🧾</span>OECD ICIO 数据质检
        <span className="section-head-line" />
      </div>
      {table(data)}

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>政策冲击面板质检
        <span className="section-head-line" />
      </div>
      {shockError ? <div className="error-box">{shockError}</div> : table(shockChecks)}

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>国家-年份控制变量质检
        <span className="section-head-line" />
      </div>
      {controlError ? <div className="error-box">{controlError}</div> : table(controlChecks)}

      <section className="qc-decision">
        <h3>你的处置决定</h3>
        <p className="muted">
          真实研究里,面对质检警告只有三条路。看完上面的结论后选一条并写下理由——
          这一步的产出是<b>判断</b>,不是“看过报告”。
        </p>
        <div className="pill-row" role="group" aria-label="质检处置决定">
          {QC_DISPOSITIONS.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`pill${evidence.data?.disposition === item.key ? " on" : ""}`}
              aria-pressed={evidence.data?.disposition === item.key}
              title={item.hint}
              onClick={() => evidence.save({ disposition: item.key })}
            >
              {item.label}
            </button>
          ))}
        </div>
        <JudgmentBox
          prompt="为什么这样处置?"
          hint="点名是哪一项质检、它会怎样影响后面的指标或回归。"
          minChars={rules.min_judgment_chars}
          value={evidence.data?.judgment ?? ""}
          onChange={(judgment) => evidence.save({ judgment })}
        />
        <EvidencePanel evidence={evidence} />
      </section>
    </div>
  );
}

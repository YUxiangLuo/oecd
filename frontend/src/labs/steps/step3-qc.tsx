import { useState } from "react";
import { api } from "../../api";
import { EvidencePanel, JudgmentBox } from "../../step-evidence";
import type { EvidenceRules, Meta, QcCheck, StepEvidenceApi } from "../../types";
import { useAsync, YearPicker } from "../shared";
import { QcChecksTable } from "./qc-checks-table";

/** 第 2 步的学习证据:对质检警告作出处置决定,并写下理由。 */
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
  const { data: controlChecks, error: controlError } = useAsync<QcCheck[]>(() => api.qcControls(), []);
  if (error) return <div className="error-box">{error}</div>;
  // 政策冲击面板的专项质检已随冲击接入移到第 11 步;这里只做 ICIO 与派生控制变量。
  // 总数从各组响应实际推导,不硬编码;加载中与读取失败分开表述,失败不会伪装成“加载中”。
  const sections = [
    { rows: data, error: null as string | null },
    { rows: controlChecks, error: controlError },
  ];
  const loading = sections.some((section) => section.rows == null && section.error == null);
  const failedSections = sections.filter((section) => section.error != null).length;
  const allChecks = sections.flatMap((section) => section.rows ?? []);
  const failures = allChecks.filter((check) => !check.passed).length;
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
      <QcChecksTable rows={data} onNavigateStep={onNavigateStep} />

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>国家-年份控制变量质检
        <span className="section-head-line" />
      </div>
      {controlError ? <div className="error-box">{controlError}</div> : <QcChecksTable rows={controlChecks} onNavigateStep={onNavigateStep} />}

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

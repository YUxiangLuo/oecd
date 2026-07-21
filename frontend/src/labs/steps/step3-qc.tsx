import { useState } from "react";
import { api } from "../../api";
import { EvidencePanel } from "../../step-evidence";
import type { Meta, QcCheck, QuizStepEvidence, StepEvidenceApi } from "../../types";
import { useAsync, YearPicker } from "../shared";
import { QcChecksTable } from "./qc-checks-table";
import { qcDisclosureItems } from "./qc-evidence";
import { summarizeQcRelease } from "./qc-release";

/** 第 2 步的操作证据：对质检警告作出处置决定并完成必要后续。 */
interface QcEvidence extends QuizStepEvidence, Record<string, unknown> {
  disposition?: QcDisposition;
  remediation?: string;
  disclosures?: string[];
  retest_passed?: boolean;
  failed_checks?: string[];
  evidence_id?: string;
}

type QcDisposition = "stop" | "fix" | "disclose";

const QC_DISPOSITIONS: { key: QcDisposition; label: string; hint: string }[] = [
  { key: "stop", label: "停止分析", hint: "问题足以让后续结论失效,不应继续。" },
  { key: "fix", label: "修正数值", hint: "问题可定位且能修正,修正后再继续。" },
  { key: "disclose", label: "披露后继续", hint: "问题不影响本课结论,但必须写进报告的局限。" },
];

export function QcLab({ meta, evidence, onNavigateStep }: {
  meta: Meta;
  evidence: StepEvidenceApi<QcEvidence>;
  onNavigateStep: (step: number) => void;
}) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
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
  // 与服务端签发器使用同一组稳定键：不仅收失败项，也收“通过但仍需披露”的
  // warning；年度 ICIO 检查保留原名，控制变量检查加前缀避免重名碰撞。
  const disclosureItems = qcDisclosureItems(data ?? [], controlChecks ?? []);
  // 数据产物自带的发布状态:哪些 QC 项在这一版数据里必须持续披露。
  // 它讲的是本步的数据口径边界,因此放在质检结论旁边,而不是常驻在每一步顶部。
  const qcRelease = summarizeQcRelease(meta.artifact_provenance?.qc);
  const disposition = evidence.data?.disposition;
  const canIssue = Boolean(
    !loading
    && failedSections === 0
    && disposition
    && (disposition !== "fix" || (evidence.data?.remediation?.trim().length ?? 0) >= 12)
    && (disposition !== "disclose" || (
      disclosureItems.length > 0
      && disclosureItems.every((name) => evidence.data?.disclosures?.includes(name))
    )),
  );
  const change = (patch: Partial<QcEvidence>) => evidence.save({ ...patch, evidence_id: "" });
  const issue = async () => {
    if (!disposition || !canIssue || issuing) return;
    setIssuing(true);
    setIssueError(null);
    try {
      const payload: Record<string, unknown> = {
        year,
        disposition,
        remediation: disposition === "fix" ? evidence.data?.remediation ?? "" : "",
        // 只提交当前两组检查实际要求披露的项，避免切换年份后把旧选择混入签名。
        disclosures: disposition === "disclose" ? disclosureItems : [],
      };
      const result = await api.classroom.issueEvidence({ step: 2, kind: "qc_resolution", payload });
      evidence.save({ ...(result.evidence ?? payload), evidence_id: result.evidence_id });
    } catch (cause) {
      setIssueError(String((cause as Error).message ?? cause));
    } finally {
      setIssuing(false);
    }
  };
  return (
    <div>
      <YearPicker
        years={meta.years}
        year={year}
        onChange={(nextYear) => {
          setYear(nextYear);
          evidence.save({ evidence_id: "", disclosures: [] });
        }}
      />
      <div className={failures || failedSections ? "warnbox" : "tipbox"} style={{ marginBottom: 16, fontWeight: 700 }}>
        {loading
          ? `正在汇总质检结果… 已读取 ${allChecks.length} 项`
          : failedSections
            ? `有 ${failedSections} 组质检未能读取（详见下方错误）；已读取 ${allChecks.length} 项中 ${failures} 项异常。`
            : failures
              ? `${allChecks.length} 项质检中 ${allChecks.length - failures} 项通过、${failures} 项异常；异常项已在各表置顶。`
              : `✓ ${allChecks.length} 项质检全部通过；仍可展开每项查看检查动机与口径。`}
      </div>

      {qcRelease.requiresDisclosure && (
        <details className="warnbox qc-release-status">
          <summary>
            数据发布状态：当前产物含需持续披露的 QC 项
            {qcRelease.override ? "（包含显式 override）" : ""}
          </summary>
          {qcRelease.fatal.length > 0 && <p><b>Fatal：</b>{qcRelease.fatal.join("、")}</p>}
          {qcRelease.warning.length > 0 && <p><b>Warning：</b>{qcRelease.warning.join("、")}</p>}
          {qcRelease.disclosure.length > 0 && <p><b>Disclosure：</b>{qcRelease.disclosure.join("、")}</p>}
          <p>
            这些是<b>数据这一版本自带</b>的边界,与下面逐项质检结论一并构成本步口径;
            它们适用于后续所有描述、回归与报告。折叠只收起明细,不改变披露义务。
          </p>
        </details>
      )}

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
          真实研究里,面对质检警告只有三条路。看完上面的结论后选择实际处置；
          下方理解检查会确认你是否掌握不同处置的适用边界。
        </p>
        <div className="pill-row" role="group" aria-label="质检处置决定">
          {QC_DISPOSITIONS.map((item) => {
            const discloseUnavailable = item.key === "disclose"
              && (!loading && failedSections === 0 && disclosureItems.length === 0);
            return (
            <button
              type="button"
              key={item.key}
              className={`pill${evidence.data?.disposition === item.key ? " on" : ""}`}
              aria-pressed={evidence.data?.disposition === item.key}
              disabled={discloseUnavailable}
              title={discloseUnavailable ? "当前两组质检没有失败或需持续披露项，无需走披露后继续。" : item.hint}
              onClick={() => change({ disposition: item.key, remediation: "", disclosures: [] })}
            >
              {item.label}
            </button>
            );
          })}
        </div>
        {!loading && failedSections === 0 && disclosureItems.length === 0 && (
          <p className="muted">当前年度 ICIO 与控制变量质检均无失败或需持续披露项，“披露后继续”不适用；请选择停止分析，或在完成真实修正与复检后选择修正数值。</p>
        )}
        {failedSections > 0 && (
          <div className="error-box">质检结果尚未完整读取，暂不能提交处置。请先重试或联系教师，避免遗漏必须披露的检查。</div>
        )}
        {disposition === "fix" && (
          <label className="qc-followup-field">
            <b>实际修正规则</b>
            <span>不能只写“准备修正”；说明改了哪一行/列、依据与重算方式。服务器只会在当前 manifest 已复检通过时签发。</span>
            <textarea rows={3} value={evidence.data?.remediation ?? ""} onChange={(event) => change({ remediation: event.target.value })} />
          </label>
        )}
        {disposition === "disclose" && (
          <div className="qc-followup-field">
            <b>逐项确认要进入下游页面与报告的异常</b>
            {disclosureItems.length ? disclosureItems.map((name) => (
              <label key={name} className="qc-disclosure-row">
                <input
                  type="checkbox"
                  checked={evidence.data?.disclosures?.includes(name) ?? false}
                  onChange={(event) => {
                    const current = evidence.data?.disclosures ?? [];
                    change({ disclosures: event.target.checked ? [...current, name] : current.filter((item) => item !== name) });
                  }}
                />
                {name}
              </label>
            )) : <span className="muted">当前年度 ICIO 与控制变量均没有失败或需持续披露项，无需走“披露后继续”。</span>}
          </div>
        )}
        {disposition === "stop" && (
          <div className="warnbox">确认后，本次作业会停在质检步骤；后续实验与报告将保持锁定，直到返回修改处置或教师发布通过质检的新数据版本。</div>
        )}
        <div className="evidence-submit-row" style={{ marginTop: 12 }}>
          <button type="button" className="primary" disabled={!canIssue || issuing} onClick={issue}>
            {issuing ? "正在复核…" : evidence.data?.evidence_id ? "重新提交质检处置" : "提交质检处置并复核"}
          </button>
          <span className={evidence.data?.evidence_id ? "evidence-signed" : "muted"}>
            {evidence.data?.evidence_id ? `✓ 服务端已复核${evidence.data.retest_passed ? "，复检通过" : "并绑定当前数据版本"}` : "服务端会核对真实失败项、manifest 与复检状态"}
          </span>
        </div>
        {issueError && <div className="error-box">{issueError}</div>}
        <EvidencePanel evidence={evidence} />
      </section>
    </div>
  );
}

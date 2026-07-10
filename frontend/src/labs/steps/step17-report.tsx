import { useRef, useState } from "react";
import { api } from "../../api";
import { ReportMarkdown } from "../../report-renderer";
import type { Meta, MySubmission, RegressionOptions, ReportRequest, ReportResponse } from "../../types";
import { useAsync } from "../shared";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

/** 提交报告给老师 + 评阅结果展示。教学库停机不影响报告生成与打印。 */
function SubmitCard({ request, data }: { request: ReportRequest; data: ReportResponse }) {
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { data: mine, error } = useAsync<MySubmission>(() => api.classroom.myReport(), [refresh]);

  if (error) {
    return (
      <div className="card accent submit-card" role="status">
        <div className="kicker">提交与评阅</div>
        <p>教学数据库暂不可用，当前仍可查看和打印报告，但暂不能提交评阅。</p>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!mine) {
    return (
      <div className="card accent submit-card" role="status">
        <div className="kicker">提交与评阅</div>
        <p className="muted">正在读取提交状态…</p>
      </div>
    );
  }

  const submit = () => {
    setSubmitting(true);
    api.classroom
      .submitReport({
        year: request.year,
        title: `步骤17实验报告 · ${request.year} · ${request.method}`,
        design: { ...request },
        markdown: data.markdown,
      })
      .then(
        () => { setSubmitting(false); setSubmitError(null); setRefresh((n) => n + 1); },
        (e) => { setSubmitting(false); setSubmitError(String(e.message ?? e)); },
      );
  };

  return (
    <div className="card accent submit-card">
      <div className="kicker">提交与评阅</div>
      {mine.state === "graded" ? (
        <div className="review-result">
          <div className="review-score">{mine.score}<span>分</span></div>
          <div>
            <p><b>{mine.title}</b>(提交于 {fmtTime(mine.submitted_at)})</p>
            <p>教师评语:{mine.feedback || "(无评语)"}</p>
            <p className="muted">评阅人 {mine.graded_by} · {fmtTime(mine.graded_at)};重新提交将覆盖本报告并等待重新评阅。</p>
          </div>
        </div>
      ) : mine.state === "pending" ? (
        <p>已提交「{mine.title}」({fmtTime(mine.submitted_at)}),等待教师评阅;重新提交会覆盖上一份。</p>
      ) : (
        <p>报告生成后可提交给老师评阅;当前设定与报告全文会一并快照留档。</p>
      )}
      <div className="controls">
        <button className="primary" disabled={submitting} onClick={submit}>
          {submitting ? "提交中…" : mine.state === "none" ? "提交报告给老师" : "重新提交当前报告"}
        </button>
      </div>
      {submitError && <div className="error-box">{submitError}</div>}
    </div>
  );
}

/** 步骤17:实验报告 */
export function ReportLab({ meta }: { meta: Meta }) {
  const defaultRequest: ReportRequest = {
    year: meta.years.at(-1)!,
    granularity: "国家–行业级",
    shock_type: "关税冲击",
    method: "双重差分 (DID)",
    control_mode: "不加控制变量",
    interaction: false,
    price_mode: "名义值",
    exclude_row: true,
  };
  const [draft, setDraft] = useState<ReportRequest>(defaultRequest);
  const [request, setRequest] = useState<ReportRequest | null>(null);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const { data: opts } = useAsync<RegressionOptions>(() => api.regressionOptions(), []);
  const setField = <K extends keyof ReportRequest>(key: K, value: ReportRequest[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const generate = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    const submitted = { ...draft };
    setGenerating(true);
    setData(null);
    setRequest(null);
    setError(null);
    try {
      const response = await api.report(submitted);
      setRequest(submitted);
      setData(response);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  };
  return (
    <div className="report-lab">
      <div className="controls report-controls">
        <label>年份</label>
        <select value={draft.year} onChange={(e) => setField("year", Number(e.target.value))}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <label>粒度</label>
        <select value={draft.granularity} onChange={(e) => setField("granularity", e.target.value)}>
          {(opts?.granularities ?? ["国家–行业级", "国家级"]).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <label>冲击</label>
        <select value={draft.shock_type} onChange={(e) => setField("shock_type", e.target.value)}>
          {(opts?.shock_types ?? ["关税冲击", "制裁清单", "出口管制"]).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <label>方法</label>
        <select value={draft.method} onChange={(e) => setField("method", e.target.value)}>
          {(opts?.methods ?? ["双重差分 (DID)", "双向固定效应", "事件研究"]).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="controls report-controls">
        <label>控制变量</label>
        <select value={draft.control_mode} onChange={(e) => setField("control_mode", e.target.value)}>
          {(opts?.control_modes ?? ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"]).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <label>价格口径</label>
        <select value={draft.price_mode} onChange={(e) => setField("price_mode", e.target.value)}>
          {(opts?.price_modes ?? ["名义值", "实际值(2016=1)"]).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.interaction}
            onChange={(e) => setField("interaction", e.target.checked)}
          />
          冲击×基期GVC
        </label>
        <button className="primary" onClick={generate} disabled={generating}>
          {generating ? "生成中…" : "生成报告"}
        </button>
        <button
          className="secondary"
          disabled={!data || !request || generating}
          onClick={() => window.print()}
        >
          导出 PDF
        </button>
      </div>
      <p className="muted">
        正式报告固定使用基准 <code>clean</code> 场景；步骤13–16中的 noisy/confounded 仅用于课堂识别练习，不写入正式报告。
      </p>
      {error ? (
        <div className="error-box">{error}</div>
      ) : data && request ? (
        <>
          <p className="muted report-meta">
            建议文件名：{data.suggested_filename} ·
            当前设定:{request.granularity} · {request.shock_type} · {request.method} ·
            {request.control_mode} · {request.price_mode} · 排除 ROW{request.interaction ? " · 交互项" : ""}
          </p>
          <SubmitCard request={request} data={data} />
          <ReportMarkdown markdown={data.markdown} />
        </>
      ) : generating ? (
        <p className="muted" role="status">正在生成报告，请稍候…</p>
      ) : (
        <p className="muted">选择设定后点击“生成报告”；系统不会在进入本页时自动运行四组回归。</p>
      )}
    </div>
  );
}

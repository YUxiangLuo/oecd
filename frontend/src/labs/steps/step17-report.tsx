import { useState } from "react";
import { api } from "../../api";
import type { Meta, RegressionOptions, ReportRequest, ReportResponse } from "../../types";
import { useAsync } from "../shared";

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
  const [request, setRequest] = useState<ReportRequest>(defaultRequest);
  const { data: opts } = useAsync<RegressionOptions>(() => api.regressionOptions(), []);
  const { data, error } = useAsync<ReportResponse>(() => api.report(request), [JSON.stringify(request)]);
  const setField = <K extends keyof ReportRequest>(key: K, value: ReportRequest[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
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
        <button className="primary" onClick={() => setRequest({ ...draft })}>生成报告</button>
        <button
          className="secondary"
          disabled={!data || Boolean(error)}
          onClick={() => window.print()}
        >
          导出 PDF
        </button>
      </div>
      {error ? (
        <div className="error-box">{error}</div>
      ) : data ? (
        <>
          <p className="muted report-meta">
            已写入 {data.path}(Markdown 源文件,可用 pandoc 转 PDF) ·
            当前设定:{request.granularity} · {request.shock_type} · {request.method} ·
            {request.control_mode} · {request.price_mode} · 排除 ROW{request.interaction ? " · 交互项" : ""}
          </p>
          <div className="report-md">{data.markdown}</div>
        </>
      ) : (
        <p className="muted">正在生成报告…</p>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { IndicatorSchema, IndustryPage, Meta, Step, StepEvidenceApi } from "../../types";
import { DecompositionDemo, NetworkCentralityDemo } from "../../demos";
import { EvidencePanel } from "../../step-evidence";
import { countryLabel, sectorLabel } from "../../viz";
import { fieldLabel, fmtField, Pager, useAsync } from "../shared";

const STEP_GROUP: Record<number, string> = {
  4: "trade",
  5: "production",
  6: "length",
  7: "network",
};
const BASE_DESC: Record<string, string> = {
  country: "OECD 经济体代码",
  industry: "ICIO 行业代码与中文名",
  year: "指标年份",
};

/** 步骤4-7:行业级指标数据表(分页 + 国家/年份筛选) */
/** 第 4–7 步的学习证据:在同一组指标上看过至少两个实体。 */
interface IndicatorEvidence extends Record<string, unknown> {
  compared?: string[];
}

export function IndicatorLab({ meta, step, evidence }: {
  meta: Meta;
  step: Step;
  evidence: StepEvidenceApi<IndicatorEvidence>;
}) {
  const defaultCountry = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState(defaultCountry);
  const [page, setPage] = useState(1);
  const groupKey = STEP_GROUP[step.n] ?? "trade";
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);
  const { data, error } = useAsync<IndustryPage>(
    () => api.industryIndicators(year, country, page),
    [year, country, page],
  );

  // 证据:该实体的指标真的被取回过。累加国家,凑够两个才算做过对比——
  // 只看一个国家的分解不构成任何比较,而这一步的目标正是比较。
  useEffect(() => {
    if (!data || !country) return;
    const compared = evidence.data?.compared ?? [];
    if (!compared.includes(country)) evidence.save({ compared: [...compared, country] });
    // evidence 每次渲染都是新对象,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, country]);

  if (error) return <div className="error-box">{error}</div>;
  const group = schema?.groups.find((g) => g.key === groupKey);
  const baseCols = ["country", "industry", "year"];
  const rowKeys = data?.rows[0] ? new Set(Object.keys(data.rows[0])) : new Set<string>();
  const cols = data?.rows[0]
    ? [...baseCols, ...(group?.fields ?? []).filter((c) => rowKeys.has(c))]
    : [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div>
      <EvidencePanel
        evidence={evidence}
        title="本步要留下的证据:在下方数据表里切换国家,看过至少两个实体"
      />
      {/* 步骤4-6:真实数据拆解演示;步骤7:网络中心性演示 */}
      {[4, 5, 6].includes(step.n) && <DecompositionDemo
        step={step.n}
        meta={meta}
        onExampleChange={(exampleYear, exampleCountry) => {
          setYear(exampleYear);
          setCountry(exampleCountry);
          setPage(1);
        }}
      />}
      {step.n === 7 && <NetworkCentralityDemo />}

      <div className="section-head">
        <span className="section-head-icon">📄</span>完整分解数据表
        <span className="section-head-line" />
      </div>
      <div className="controls">
        <label>国家</label>
        <select value={country} onChange={(e) => { setCountry(e.target.value); setPage(1); }}>
          <option value="">全部</option>
          {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
        </select>
        <label>年份</label>
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setPage(1); }}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="muted">{data ? `共 ${data.total} 条` : "加载中…"}</span>
      </div>
      {group && (
        <div className="tipbox">
          {group.label}:按 {country || "全部经济体"} · {year} 年展示国家–行业级完整分解字段。
        </div>
      )}
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>{cols.map((c, index) => (
            <th key={c} title={schema?.fields[c]?.desc ?? BASE_DESC[c]}
              style={index === 0 ? { position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" } : undefined}>
              {fieldLabel(c, schema)}{schema?.fields[c]?.desc ? " ⓘ" : ""}
            </th>
          ))}</tr></thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={i}>{cols.map((c, index) => (
                <td key={c} style={index === 0 ? { position: "sticky", left: 0, zIndex: 2, background: "#fff" } : undefined}>{
                  c === "industry" ? (r.industry != null ? sectorLabel(String(r.industry)) : "—")
                    : ["year", "country"].includes(c) ? String(r[c] ?? "—")
                    : fmtField(r[c], c, schema)
                }</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} total={data?.total} onChange={setPage} />
    </div>
  );
}

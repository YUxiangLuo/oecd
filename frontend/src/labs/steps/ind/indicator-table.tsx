/**
 * 指标计算阶段(步骤 3–6)的分解数据表:国家/年份筛选 + 分页 + 学习证据。
 *
 * 受控组件:year/country/page 由外层持有,这样「动手拆解」演示的“查看 ICIO 示例”
 * 才能驱动这张表跳到指定实体。证据(看过 ≥2 个国家)在本组件内累加。
 */
import { useEffect, useState } from "react";
import { api } from "../../../api";
import type { IndicatorSchema, IndustryPage, Meta, QuizStepEvidence, StepEvidenceApi } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { Pager, fieldLabel, fmtField, useAsync } from "../../shared";

const BASE_DESC: Record<string, string> = {
  country: "OECD 经济体代码",
  industry: "ICIO 行业代码与中文名",
  year: "指标年份",
};

export interface IndicatorEvidence extends QuizStepEvidence, Record<string, unknown> {
  compared?: string[];
  last_view?: { year: number; country: string };
  metric?: string;
  observations?: { entity: string; value: number; year: number; country: string; industry: string }[];
}

const CORE_METRIC: Record<string, string> = {
  trade: "FVA_share",
  production: "3b_VA_GVC_C_share",
  length: "GVCPs",
  network: "betweenesscentrality",
};

export function IndicatorTable({ meta, groupKey, schema, evidence, year, country, page, onYear, onCountry, onPage }: {
  meta: Meta;
  groupKey: string;
  schema: IndicatorSchema | null | undefined;
  evidence: StepEvidenceApi<IndicatorEvidence>;
  year: number;
  country: string;
  page: number;
  onYear: (year: number) => void;
  onCountry: (country: string) => void;
  onPage: (page: number) => void;
}) {
  const [countryTouched, setCountryTouched] = useState(false);
  const [showAllFields, setShowAllFields] = useState(false);
  const { data, error } = useAsync<IndustryPage>(() => api.industryIndicators(year, country, page), [year, country, page]);

  // 证据:该实体的指标真的被取回过;累加国家,凑够两个才算做过对比——
  // 只看一个国家的分解不构成任何比较,而这一步的目标正是比较。
  useEffect(() => {
    if (!data || !country || !countryTouched) return;
    const compared = evidence.data?.compared ?? [];
    const metric = CORE_METRIC[groupKey];
    const existing = evidence.data?.observations ?? [];
    const targetIndustry = existing[0]?.industry;
    const observedRow = data.rows.find((row) => (
      (!targetIndustry || String(row.industry ?? "") === targetIndustry)
      && typeof row[metric] === "number" && Number.isFinite(row[metric])
    )) ?? data.rows.find((row) => typeof row[metric] === "number" && Number.isFinite(row[metric]));
    const observations = observedRow ? [
      ...existing.filter((item) => item.country !== country),
      {
        entity: `${country}·${String(observedRow.industry ?? "")}`,
        value: observedRow[metric] as number,
        year,
        country,
        industry: String(observedRow.industry ?? ""),
      },
    ].slice(-2) : existing;
    evidence.save({
      compared: compared.includes(country) ? compared : [...compared, country],
      last_view: { year, country },
      metric,
      observations,
      evidence_id: "",
    });
    // evidence 每次渲染都是新对象,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, country, year, countryTouched, groupKey]);

  if (error) return <div className="error-box">{error}</div>;
  const group = schema?.groups.find((g) => g.key === groupKey);
  const baseCols = ["country", "industry", "year"];
  const rowKeys = data?.rows[0] ? new Set(Object.keys(data.rows[0])) : new Set<string>();
  const metricCols = data?.rows[0] ? (group?.fields ?? []).filter((c) => rowKeys.has(c)) : [];
  const visibleMetrics = showAllFields ? metricCols : metricCols.slice(0, 5);
  const cols = data?.rows[0] ? [...baseCols, ...visibleMetrics] : [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      <div className="controls">
        <label>国家</label>
        <select value={country} onChange={(e) => { setCountryTouched(true); onCountry(e.target.value); onPage(1); }}>
          <option value="">全部</option>
          {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
        </select>
        <label>年份</label>
        <select value={year} onChange={(e) => { onYear(Number(e.target.value)); onPage(1); }}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="muted">{data ? `共 ${data.total} 条` : "加载中…"}</span>
      </div>
      {(evidence.data?.observations?.length ?? 0) > 0 && (
        <div className="observation-strip" aria-label="已捕获的对比数值">
          <b>已捕获 {evidence.data?.metric}</b>
          {evidence.data?.observations?.map((item) => (
            <span key={`${item.year}-${item.entity}`}>{item.year} · {item.entity} = {fmtField(item.value, evidence.data?.metric ?? "", schema)}</span>
          ))}
        </div>
      )}
      {metricCols.length > 5 && (
        <div className="table-priority-tools">
          <span className="muted">默认显示 5 个核心指标，减少横向扫表负担。</span>
          <button type="button" className="secondary" onClick={() => setShowAllFields((value) => !value)}>
            {showAllFields ? "收起扩展指标" : `展开 ${metricCols.length - 5} 个扩展指标`}
          </button>
        </div>
      )}
      <div className="table-wrap bounded-data-table">
        <table className="data-table">
          <thead>
            <tr>
              {cols.map((c, index) => (
                <th key={c} title={schema?.fields[c]?.desc ?? BASE_DESC[c]}
                  style={index === 0 ? { position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" } : undefined}>
                  {fieldLabel(c, schema)}{schema?.fields[c]?.desc ? " ⓘ" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={i}>
                {cols.map((c, index) => (
                  <td key={c} style={index === 0 ? { position: "sticky", left: 0, zIndex: 2, background: "#fff" } : undefined}>
                    {c === "industry"
                      ? r.industry != null ? sectorLabel(String(r.industry)) : "—"
                      : ["year", "country"].includes(c) ? String(r[c] ?? "—")
                        : fmtField(r[c], c, schema)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} total={data?.total} onChange={onPage} />
    </>
  );
}

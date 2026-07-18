/**
 * 指标计算阶段(步骤 4–7)的分解数据表:国家/年份筛选 + 分页 + 学习证据。
 *
 * 受控组件:year/country/page 由外层持有,这样「动手拆解」演示的“查看 ICIO 示例”
 * 才能驱动这张表跳到指定实体。证据(看过 ≥2 个国家)在本组件内累加。
 */
import { useEffect } from "react";
import { api } from "../../../api";
import type { IndicatorSchema, IndustryPage, Meta, StepEvidenceApi } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { Pager, fieldLabel, fmtField, useAsync } from "../../shared";

const BASE_DESC: Record<string, string> = {
  country: "OECD 经济体代码",
  industry: "ICIO 行业代码与中文名",
  year: "指标年份",
};

export interface IndicatorEvidence extends Record<string, unknown> {
  compared?: string[];
}

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
  const { data, error } = useAsync<IndustryPage>(() => api.industryIndicators(year, country, page), [year, country, page]);

  // 证据:该实体的指标真的被取回过;累加国家,凑够两个才算做过对比——
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
  const cols = data?.rows[0] ? [...baseCols, ...(group?.fields ?? []).filter((c) => rowKeys.has(c))] : [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      <div className="controls">
        <label>国家</label>
        <select value={country} onChange={(e) => { onCountry(e.target.value); onPage(1); }}>
          <option value="">全部</option>
          {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
        </select>
        <label>年份</label>
        <select value={year} onChange={(e) => { onYear(Number(e.target.value)); onPage(1); }}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="muted">{data ? `共 ${data.total} 条` : "加载中…"}</span>
      </div>
      <div className="table-wrap">
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

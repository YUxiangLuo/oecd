/**
 * 指标计算阶段（步骤 3–6）的分解数据表：国家/年份筛选、分页与实验快照。
 *
 * 受控组件:year/country/page 由外层持有,这样「动手拆解」演示的“查看 ICIO 示例”
 * 才能驱动这张表跳到指定实体。主动查看过的国家在本组件内累加保存。
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { IndicatorSchema, IndustryPage, Meta, QuizCompletionState, StepStateApi } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { Pager, fieldLabel, fmtField, useAsync } from "../../shared";

const BASE_DESC: Record<string, string> = {
  country: "OECD 经济体代码",
  industry: "ICIO 行业代码与中文名",
  year: "指标年份",
};

export interface IndicatorStepState extends QuizCompletionState, Record<string, unknown> {
  year?: number;
  country?: string;
  compared?: string[];
  metric?: string;
  observations?: { entity: string; value: number; year: number; country: string; industry: string }[];
}

const CORE_METRIC: Record<string, string> = {
  trade: "FVA_share",
  production: "3b_VA_GVC_C_share",
  length: "GVCPs",
  network: "betweenesscentrality",
};

export function restoreIndicatorSelection(meta: Meta, saved?: IndicatorStepState) {
  const fallbackCountry = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const savedCountry = typeof saved?.country === "string"
    ? saved.country
    : [...(saved?.compared ?? [])].reverse().find((item) => meta.countries.includes(item));
  return {
    year: typeof saved?.year === "number" && meta.years.includes(saved.year)
      ? saved.year
      : meta.years.at(-1)!,
    country: savedCountry === "" || (savedCountry != null && meta.countries.includes(savedCountry))
      ? savedCountry
      : fallbackCountry,
  };
}

/** 指标表与分解演示共享一套选择，并只把学生真实交互后的变化写回会话。 */
export function useIndicatorControls(meta: Meta, state: StepStateApi<IndicatorStepState>) {
  const initial = restoreIndicatorSelection(meta, state.data);
  const [year, setYearValue] = useState(initial.year);
  const [country, setCountryValue] = useState(initial.country);
  const [page, setPageValue] = useState(1);
  const [interacted, setInteracted] = useState(false);
  const restored = useRef(state.data !== undefined);

  useEffect(() => {
    if (restored.current || interacted || state.data === undefined) return;
    const next = restoreIndicatorSelection(meta, state.data);
    setYearValue(next.year);
    setCountryValue(next.country);
    setPageValue(1);
    restored.current = true;
  }, [interacted, meta, state.data]);

  const setYear = (next: number) => {
    setInteracted(true);
    setYearValue(next);
    setPageValue(1);
  };
  const setCountry = (next: string) => {
    setInteracted(true);
    setCountryValue(next);
    setPageValue(1);
  };
  const setPage = (next: number) => {
    setInteracted(true);
    setPageValue(next);
  };
  const setPrimary = (nextYear: number, nextCountry: string) => {
    setInteracted(true);
    setYearValue(nextYear);
    setCountryValue(nextCountry);
    setPageValue(1);
  };

  return { year, country, page, interacted, setYear, setCountry, setPage, setPrimary };
}

export function IndicatorTable({ meta, groupKey, schema, state, year, country, page, interacted, onYear, onCountry, onPage }: {
  meta: Meta;
  groupKey: string;
  schema: IndicatorSchema | null | undefined;
  state: StepStateApi<IndicatorStepState>;
  year: number;
  country: string;
  page: number;
  interacted: boolean;
  onYear: (year: number) => void;
  onCountry: (country: string) => void;
  onPage: (page: number) => void;
}) {
  const [showAllFields, setShowAllFields] = useState(false);
  const queryKey = JSON.stringify([year, country, page]);
  const { data: result, error } = useAsync<{ queryKey: string; page: IndustryPage }>(async () => ({
    queryKey,
    page: await api.industryIndicators(year, country, page),
  }), [queryKey]);
  // useAsync 在依赖变化后的 effect 才清旧结果；显式核对请求键，避免新筛选在
  // 同一帧误把上一次响应中的数值标成新国家/新年份后保存。
  const data = result?.queryKey === queryKey ? result.page : null;

  // 该实体的指标取回后保存快照；累加主动查看过的国家，供刷新恢复和报告摘要。
  useEffect(() => {
    if (!data || !interacted) return;
    const metric = CORE_METRIC[groupKey];
    if (!country) {
      state.save({ year, country, metric });
      return;
    }
    const compared = state.data?.compared ?? [];
    const existing = state.data?.observations ?? [];
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
    state.save({
      year,
      country,
      compared: [...compared.filter((item) => item !== country), country],
      metric,
      observations,
    });
    // state 每次渲染都是新对象,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, country, year, interacted, groupKey]);

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
        <LabeledControl label="经济体">
          {(id) => (
            <select id={id} value={country} onChange={(e) => onCountry(e.target.value)}>
              <option value="">全部</option>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="年份">
          {(id) => (
            <select id={id} value={year} onChange={(e) => onYear(Number(e.target.value))}>
              {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
        </LabeledControl>
        <span className="muted">{data ? `共 ${data.total} 条` : "加载中…"}</span>
      </div>
      {(state.data?.observations?.length ?? 0) > 0 && (
        <div className="observation-strip" role="group" aria-label="已记录的对比数值">
          <b>已记录：{fieldLabel(state.data?.metric ?? "", schema)}</b>
          {state.data?.observations?.map((item) => (
            <span key={`${item.year}-${item.entity}`}>
              {item.year} · {countryLabel(item.country)} · {sectorLabel(item.industry)} = {fmtField(item.value, state.data?.metric ?? "", schema)}
            </span>
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
      <ScrollableRegion
        className="table-wrap bounded-data-table"
        label={`${group?.label ?? "指标"}数据表，可横向滚动`}
      >
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
                      : c === "country"
                        ? r.country != null ? countryLabel(String(r.country)) : "—"
                        : c === "year" ? String(r.year ?? "—") : fmtField(r[c], c, schema)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableRegion>
      <Pager page={page} pages={pages} total={data?.total} onChange={onPage} />
    </>
  );
}

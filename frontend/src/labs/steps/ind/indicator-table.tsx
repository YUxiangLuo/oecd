/**
 * 指标计算阶段（步骤 3–6）的分解数据表：国家/年份筛选、分页与实验快照。
 *
 * 受控组件:year/country/page 由外层持有,这样「动手拆解」演示的“查看 ICIO 示例”
 * 才能驱动这张表跳到指定实体。主动查看过的国家在本组件内累加保存。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import { FullscreenPanel } from "../../../fullscreen-panel";
import type { IndicatorSchema, IndustryPage, Meta, QuizCompletionState, StepStateApi } from "../../../types";
import { userFacingRequestError } from "../../../user-facing-error";
import { countryLabel, sectorLabel } from "../../../viz";
import { AsyncStateMessage, Pager, fieldLabel, fmtField, useAsync } from "../../shared";

const BASE_DESC: Record<string, string> = {
  country: "OECD 经济体代码",
  industry: "ICIO 行业代码与中文名",
  year: "指标年份",
};

export type IndicatorGroupKey = "trade" | "production" | "length" | "network";
export type NetworkTableSortMetric = "weighted degree" | "betweenesscentrality";

/**
 * Teaching-first table contracts. These are deliberately independent from schema order:
 * changing backend field order must not silently change the columns used by each task.
 */
export const INDICATOR_TABLE_DISPLAY = {
  trade: [
    "gross_exports", "DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub", "DVAex_share", "FVA_share",
  ],
  production: [
    "SVA", "1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C", "3b_VA_GVC_C_share",
  ],
  length: ["PLv", "PLv_D", "PLv_RT", "PLv_GVC", "PLy", "PLy_GVC", "GVCPs"],
  network: [
    "weighted degree", "betweenesscentrality", "degree", "indegree", "outdegree", "closnesscentrality",
  ],
} as const satisfies Readonly<Record<IndicatorGroupKey, readonly string[]>>;

export const INDICATOR_IDENTIFIER_COLUMNS = ["country", "industry", "year"] as const;

export const NETWORK_TABLE_SORT_OPTIONS: ReadonlyArray<{ value: NetworkTableSortMetric; label: string }> = [
  { value: "betweenesscentrality", label: "全正边二值介数（降序）" },
  { value: "weighted degree", label: "加权总度（入+出；自环双计）" },
];

export function indicatorRequestKey(year: number, country: string, page: number): string {
  return JSON.stringify([year, country, page]);
}

export function indicatorMetricColumns(
  groupKey: IndicatorGroupKey,
  groupFields: readonly string[],
  row: Record<string, unknown> | null | undefined,
  expanded = false,
): string[] {
  if (!row) return [];
  const rowKeys = new Set(Object.keys(row));
  const available = groupFields.filter((field) => rowKeys.has(field));
  if (expanded) return available;
  const availableSet = new Set(available);
  return INDICATOR_TABLE_DISPLAY[groupKey].filter((field) => availableSet.has(field));
}

export function indicatorTableColumns(
  groupKey: IndicatorGroupKey,
  groupFields: readonly string[],
  row: Record<string, unknown> | null | undefined,
  expanded = false,
): string[] {
  return row
    ? [...INDICATOR_IDENTIFIER_COLUMNS, ...indicatorMetricColumns(groupKey, groupFields, row, expanded)]
    : [];
}

/** Sort only a complete single-country response. Original response order is the stable tie-break. */
export function sortNetworkRows(
  rows: readonly Record<string, string | number | null>[],
  metric: NetworkTableSortMetric,
): Record<string, string | number | null>[] {
  const sortableValue = (row: Record<string, string | number | null>) => {
    const value = row[metric];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const av = sortableValue(a.row);
    const bv = sortableValue(b.row);
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    if (av != null && bv != null && av !== bv) return bv - av;
    return a.index - b.index;
  }).map(({ row }) => row);
}

export function IndicatorRequestBoundary({
  status,
  error,
  loadingLabel,
  empty,
  onRetry,
  children,
}: {
  status: "idle" | "loading" | "success" | "error";
  error: string | null;
  loadingLabel: string;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (status === "loading" || status === "idle") {
    return <AsyncStateMessage status={status} error={null} loadingLabel={loadingLabel} onRetry={onRetry} />;
  }
  if (status === "error") {
    return (
      <AsyncStateMessage
        status="error"
        error={userFacingRequestError(error, "指标表加载失败")}
        onRetry={onRetry}
      />
    );
  }
  if (empty) {
    return (
      <p className="muted async-empty" role="status">
        当前国家、年份与页码下没有行业指标数据。请保留或调整筛选条件后继续。
      </p>
    );
  }
  return <>{children}</>;
}

export interface IndicatorStepState extends QuizCompletionState, Record<string, unknown> {
  year?: number;
  country?: string;
  compared?: string[];
  metric?: string;
  observations?: { entity: string; value: number; year: number; country: string; industry: string }[];
}

const CORE_METRIC: Record<IndicatorGroupKey, string> = {
  trade: "FVA_share",
  production: "3b_VA_GVC_C_share",
  length: "GVCPs",
  network: "betweenesscentrality",
};

/** 换国家对比时用国家级指标；国家完全图的介数恒为 0，网络步改用加权度。 */
export const COUNTRY_METRIC: Record<IndicatorGroupKey, string> = {
  trade: "FVA_share",
  production: "3b_VA_GVC_C_share",
  length: "GVCPs",
  network: "weighted degree",
};

export function countryRowsForYear(
  payload: { year: number; rows: Array<Record<string, unknown>> } | null | undefined,
  year: number,
) {
  return payload?.year === year ? payload.rows : null;
}

export function countryObservation(
  rows: Array<Record<string, unknown>>,
  country: string,
  year: number,
  metric: string,
) {
  const matches = rows.filter((item) => item.country === country);
  const row = matches.find((item) => item.industry == null || item.industry === "") ?? matches[0];
  const value = row?.[metric];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return {
    entity: country,
    value,
    year,
    country,
    industry: "",
  };
}

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

export function indicatorRowHeaderLabel(row: Record<string, string | number | null>): string {
  const country = row.country == null ? "未定义国家" : countryLabel(String(row.country));
  const industry = row.industry == null ? "未定义行业" : sectorLabel(String(row.industry));
  return `国家 ${country}；行业 ${industry}`;
}

export function IndicatorDataTable({
  groupLabel,
  schema,
  columns,
  rows,
  year,
  country,
  page,
}: {
  groupLabel: string;
  schema: IndicatorSchema | null | undefined;
  columns: readonly string[];
  rows: readonly Record<string, string | number | null>[];
  year: number;
  country: string;
  page: number;
}) {
  const captionLabel = groupLabel === "指标" ? "指标数据" : `${groupLabel}指标数据`;
  return (
    <table className="data-table">
      <caption className="sr-only">{captionLabel} · {year} 年 · {country ? countryLabel(country) : "全部国家"} · 第 {page} 页</caption>
      <thead>
        <tr>
          {columns.map((column, index) => (
            <th
              key={column}
              scope="col"
              title={schema?.fields[column]?.desc ?? BASE_DESC[column]}
              style={index === 0 ? { position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" } : undefined}
            >
              {fieldLabel(column, schema)}{schema?.fields[column]?.desc ? " ⓘ" : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`${String(row.country ?? "")}-${String(row.industry ?? "")}-${rowIndex}`}>
            {columns.map((column, index) => {
              const content = column === "industry"
                ? row.industry != null ? sectorLabel(String(row.industry)) : "—"
                : ["year", "country"].includes(column) ? String(row[column] ?? "—")
                  : fmtField(row[column], column, schema);
              const stickyStyle = index === 0
                ? { position: "sticky" as const, left: 0, zIndex: 2, background: "#fff" }
                : undefined;
              return index === 0 ? (
                <th key={column} className="indicator-row-header" scope="row" aria-label={indicatorRowHeaderLabel(row)} style={stickyStyle}>
                  {content}
                </th>
              ) : (
                <td key={column} style={stickyStyle}>{content}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IndicatorTable({ meta, groupKey, schema, state, year, country, page, interacted, onYear, onCountry, onPage }: {
  meta: Meta;
  groupKey: IndicatorGroupKey;
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
  const [autoExpandSignal, setAutoExpandSignal] = useState(0);
  const [networkSort, setNetworkSort] = useState<NetworkTableSortMetric>("betweenesscentrality");
  const requestKey = indicatorRequestKey(year, country, page);
  const mainQuery = useAsync<IndustryPage>(
    () => api.industryIndicators(year, country, page, groupKey === "network" && country ? 200 : undefined),
    [requestKey, groupKey],
    { requestKey },
  );
  const countryRequestKey = JSON.stringify(["country-observations", year]);
  const countryQuery = useAsync<{ year: number; rows: Array<Record<string, unknown>> }>(
    async () => ({
      year,
      rows: await api.countryIndicators(year) as Array<Record<string, unknown>>,
    }),
    [countryRequestKey],
    { requestKey: countryRequestKey },
  );
  const data = mainQuery.status === "success" ? mainQuery.data : null;
  const countryRows = countryQuery.status === "success"
    ? countryRowsForYear(countryQuery.data, year)
    : null;

  // 换国家对比保存国家级指标，避免误把第一行业当成国家结构。
  useEffect(() => {
    if (!interacted) return;
    const metric = COUNTRY_METRIC[groupKey] ?? CORE_METRIC[groupKey];
    if (!country) {
      state.save({ year, country, metric });
      return;
    }
    if (!countryRows) return;
    const observed = countryObservation(countryRows, country, year, metric);
    const compared = state.data?.compared ?? [];
    const existing = state.data?.observations ?? [];
    const observations = observed
      ? [...existing.filter((item) => item.country !== country), observed].slice(-2)
      : existing;
    state.save({
      year,
      country,
      compared: [...compared.filter((item) => item !== country), country],
      metric,
      observations,
    });
    // state 每次渲染都是新对象,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryRows, country, year, interacted, groupKey]);

  const group = schema?.groups.find((candidate) => candidate.key === groupKey);
  const cols = indicatorTableColumns(groupKey, group?.fields ?? [], data?.rows[0], showAllFields);
  const displayRows = groupKey === "network" && country && data
    ? sortNetworkRows(data.rows, networkSort)
    : (data?.rows ?? []);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const defaultMetricCount = indicatorMetricColumns(groupKey, group?.fields ?? [], data?.rows[0]).length;
  const allMetricCount = indicatorMetricColumns(groupKey, group?.fields ?? [], data?.rows[0], true).length;
  const toggleAllFields = () => {
    if (!showAllFields) setAutoExpandSignal((signal) => signal + 1);
    setShowAllFields((value) => !value);
  };
  const countLabel = mainQuery.status === "success" && data
    ? `共 ${data.total} 条`
    : mainQuery.status === "error" ? "本次请求失败" : "加载中…";

  return (
    <FullscreenPanel
      title={`${group?.label ?? "指标"}数据表`}
      variant="table"
      buttonLabel="全屏查看"
      autoExpandSignal={autoExpandSignal}
    >
      <div className="controls">
        <LabeledControl label="国家">
          {(id) => (
            <select id={id} value={country} onChange={(event) => onCountry(event.target.value)}>
              <option value="">全部</option>
              {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="年份">
          {(id) => (
            <select id={id} value={year} onChange={(event) => onYear(Number(event.target.value))}>
              {meta.years.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          )}
        </LabeledControl>
        <span className="muted">{countLabel}</span>
      </div>

      {groupKey === "network" && (
        <div className="table-priority-tools network-table-sort">
          <LabeledControl label={country ? "单国行业排序" : "行业排序（仅单国完整结果）"}>
            {(id) => (
              <select
                id={id}
                value={networkSort}
                disabled={!country}
                onChange={(event) => setNetworkSort(event.target.value as NetworkTableSortMetric)}
              >
                {NETWORK_TABLE_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            )}
          </LabeledControl>
          <span className="muted" role="note">
            {country
              ? "当前国家的完整行业结果在浏览器内排序；排序只改变显示顺序，不改变指标证据或请求页。"
              : "全球范围按服务端分页顺序显示；请先选择国家，再对该国完整行业结果排序。"}
          </span>
        </div>
      )}

      {countryQuery.status === "error" && (
        <AsyncStateMessage
          status="error"
          error={userFacingRequestError(countryQuery.error, `${year} 年国家级对比加载失败`)}
          onRetry={countryQuery.retry}
        />
      )}

      {(state.data?.observations?.length ?? 0) > 0 && (
        <div className="observation-strip" role="group" aria-label="已捕获的对比数值">
          <b>已捕获国家级 {fieldLabel(state.data?.metric ?? "", schema)}</b>
          {state.data?.observations?.map((item) => (
            <span key={`${item.year}-${item.entity}`}>
              {item.year} · {item.industry ? item.entity : countryLabel(item.country)} = {fmtField(item.value, state.data?.metric ?? "", schema)}
            </span>
          ))}
        </div>
      )}

      <IndicatorRequestBoundary
        status={mainQuery.status}
        error={mainQuery.error}
        loadingLabel={`加载 ${year} 年${country ? ` ${countryLabel(country)}` : "全球"}行业指标中…`}
        empty={!data || data.rows.length === 0}
        onRetry={mainQuery.retry}
      >
          {allMetricCount > defaultMetricCount && (
            <div className="table-priority-tools">
              <span className="muted">默认显示本任务要求的 {defaultMetricCount} 个核心指标。</span>
              <button type="button" className="secondary" onClick={toggleAllFields}>
                {showAllFields ? "收起扩展指标" : `展开 ${allMetricCount - defaultMetricCount} 个扩展指标`}
              </button>
            </div>
          )}
          <ScrollableRegion
            className="table-wrap bounded-data-table"
            label={`${group?.label ?? "指标"}数据表，可横向滚动`}
          >
            <IndicatorDataTable
              groupLabel={group?.label ?? "指标"}
              schema={schema}
              columns={cols}
              rows={displayRows}
              year={year}
              country={country}
              page={page}
            />
          </ScrollableRegion>
          <Pager page={page} pages={pages} total={data?.total} onChange={onPage} />
      </IndicatorRequestBoundary>
    </FullscreenPanel>
  );
}

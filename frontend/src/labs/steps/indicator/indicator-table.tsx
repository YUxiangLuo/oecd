/**
 * 指标数据表（步骤 5 中心性表）：国家/年份筛选、分页与排序。
 *
 * 受控组件:year/country/page 由外层持有,并与实验快照恢复保持同步。
 * 报告材料（所选国家的国家整体读数）由 auto-comparison 自动记录，本表不提供保存按钮。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import { FullscreenPanel, FullscreenTriggerSlot } from "../../../fullscreen-panel";
import { ColumnInfo, useMeasuredWidth } from "../../../table-aids";
import type { IndicatorSchema, IndustryPage, Meta, QuizCompletionState, StepStateApi } from "../../../types";
import { userFacingRequestError } from "../../../user-facing-error";
import { countryLabel, sectorLabel } from "../../../viz";
import { PATH_UNDEFINED_LABEL, PATH_UNDEFINED_NOTE, pathMetricUndefined } from "../../../viz/views/network-heat";
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
/** Identifier columns read as text: left-aligned, unlike the numeric indicator columns. */
const TEXT_COLUMNS = new Set<string>(INDICATOR_IDENTIFIER_COLUMNS);

export const NETWORK_TABLE_SORT_OPTIONS: ReadonlyArray<{ value: NetworkTableSortMetric; label: string }> = [
  { value: "weighted degree", label: "按加权总度从高到低" },
  { value: "betweenesscentrality", label: "按介数从高到低" },
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
  const availableSet = new Set(available);
  const core: string[] = INDICATOR_TABLE_DISPLAY[groupKey].filter((field) => availableSet.has(field));
  // Expanding appends the extra indicators after the core ones, so the core columns keep their places.
  return expanded ? [...core, ...available.filter((field) => !core.includes(field))] : core;
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
        当前国家、年份与页码下没有行业指标数据。请换一个国家或年份。
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
  observations?: IndicatorObservation[];
  /** The student recorded this material explicitly after submitting the report (automatic saves clear it). */
  material_chosen?: boolean;
}

export interface IndicatorObservation {
  entity: string;
  value: number;
  year: number;
  country: string;
  industry: string;
  metric: string;
  unit: string;
  release: string;
  scope: "country";
  /** Steps 2–5 record automatically; the explicit source only appears in records saved by an earlier version. */
  source: "explicit-indicator-table-comparison" | "auto-indicator-comparison";
}

const CORE_METRIC: Record<IndicatorGroupKey, string> = {
  trade: "FVA_share",
  production: "3b_VA_GVC_C_share",
  length: "GVCPs",
  network: "betweenesscentrality",
};

/** 报告材料记录的国家级指标；国家完全图的介数恒为 0，网络步改用加权度。 */
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
  unit: string,
  release: string,
  source: IndicatorObservation["source"] = "explicit-indicator-table-comparison",
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
    metric,
    unit,
    release,
    scope: "country" as const,
    source,
  };
}

/** Steps 2–5 report material: the selected country's country-level reading for one year, recorded automatically. */
export function indicatorMaterialPatch(
  rows: Array<Record<string, unknown>>,
  country: string,
  year: number,
  metric: string,
  unit: string,
  release: string,
): Pick<IndicatorStepState, "year" | "country" | "compared" | "metric" | "observations"> | null {
  if (!country || !release) return null;
  const observation = countryObservation(rows, country, year, metric, unit, release, "auto-indicator-comparison");
  if (!observation) return null;
  return { year, country, compared: [country], metric, observations: [observation] };
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
/** The step an opening country was carried from, when the step shows that very country (see `carriedFrom`). */
function carriedSource(meta: Meta, state: StepStateApi<IndicatorStepState>): number | undefined {
  if (state.carriedFrom == null) return undefined;
  const shown = restoreIndicatorSelection(meta, state.data).country;
  return shown !== "" && shown === state.data?.compared?.[0] ? state.carriedFrom : undefined;
}

/** "沿用你在步骤 2 选的国家，可以更换。", shown beside the country select of a step that opened on a carried country. */
export function carriedCountryNote(from: number | undefined): string | null {
  return from == null ? null : `沿用你在步骤 ${from} 选的国家，可以更换。`;
}

/** 指标表与分解演示共享一套选择，并只把学生真实交互后的变化写回会话。 */
export function useIndicatorControls(meta: Meta, state: StepStateApi<IndicatorStepState>) {
  const initial = restoreIndicatorSelection(meta, state.data);
  const [year, setYearValue] = useState(initial.year);
  const [country, setCountryValue] = useState(initial.country);
  const [page, setPageValue] = useState(1);
  const [interacted, setInteracted] = useState(false);
  const restored = useRef(state.data !== undefined);
  // Where the opening country came from. The workspace offers it only until the step records its own country
  // (right after it opens), so it is kept from the first render; it goes once the student picks a country here.
  const [carriedFrom, setCarriedFrom] = useState(() => carriedSource(meta, state));
  const [countryChosen, setCountryChosen] = useState(false);

  useEffect(() => {
    if (restored.current || interacted || state.data === undefined) return;
    const next = restoreIndicatorSelection(meta, state.data);
    setYearValue(next.year);
    setCountryValue(next.country);
    setPageValue(1);
    setCarriedFrom(carriedSource(meta, state));
    restored.current = true;
    // state is a new object each render; state.data carries every change that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interacted, meta, state.data]);

  const chooseCountry = (next: string) => {
    if (next !== country) setCountryChosen(true);
    setCountryValue(next);
  };
  const setYear = (next: number) => {
    setInteracted(true);
    setYearValue(next);
    setPageValue(1);
  };
  const setCountry = (next: string) => {
    setInteracted(true);
    chooseCountry(next);
    setPageValue(1);
  };
  const setPage = (next: number) => {
    setInteracted(true);
    setPageValue(next);
  };
  const setPrimary = (nextYear: number, nextCountry: string) => {
    setInteracted(true);
    setYearValue(nextYear);
    chooseCountry(nextCountry);
    setPageValue(1);
  };

  const carriedNote = countryChosen ? null : carriedCountryNote(carriedFrom);
  return { year, country, page, interacted, carriedNote, setYear, setCountry, setPage, setPrimary };
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
  totalPages = 1,
}: {
  groupLabel: string;
  schema: IndicatorSchema | null | undefined;
  columns: readonly string[];
  rows: readonly Record<string, string | number | null>[];
  year: number;
  country: string;
  page: number;
  /** Only a multi-page table names its page. */
  totalPages?: number;
}) {
  // A group label may already end in “指标” (e.g. “生产网络指标”); do not say it twice.
  const captionLabel = groupLabel.endsWith("指标") ? `${groupLabel}数据` : `${groupLabel}指标数据`;
  // 国家 and 行业 both stay in view while the extended indicators scroll by; 行业 sits right after the measured
  // 国家 column (country names differ in length).
  const [measureFirst, firstWidth] = useMeasuredWidth<HTMLTableCellElement>();
  const stickyIndustry = columns[0] === "country" && columns[1] === "industry";
  const stickyLeft = (index: number) => index === 0 ? 0 : stickyIndustry && index === 1 ? firstWidth : null;
  return (
    <table className="data-table">
      <caption className="sr-only">{captionLabel} · {year} 年 · {country ? countryLabel(country) : "全部国家"}{totalPages > 1 ? ` · 第 ${page} 页` : ""}</caption>
      <thead>
        <tr>
          {columns.map((column, index) => {
            const desc = schema?.fields[column]?.desc;
            const left = stickyLeft(index);
            return (
              <th
                key={column}
                ref={index === 0 ? measureFirst : undefined}
                scope="col"
                // An indicator's definition is a focusable ⓘ; the identifier columns keep a hover hint.
                title={desc ? undefined : BASE_DESC[column]}
                className={TEXT_COLUMNS.has(column) ? "text-col" : undefined}
                style={left != null ? { position: "sticky", left, zIndex: index === 0 ? 5 : 4, background: "#fafbfd" } : undefined}
              >
                {fieldLabel(column, schema)}
                {desc && <ColumnInfo label={fieldLabel(column, schema)} text={desc} />}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`${String(row.country ?? "")}-${String(row.industry ?? "")}-${rowIndex}`}>
            {columns.map((column, index) => {
              const content = column === "industry"
                ? row.industry != null ? sectorLabel(String(row.industry)) : "—"
                : column === "country" ? row.country != null ? countryLabel(String(row.country)) : "—"
                : column === "year" ? String(row.year ?? "—")
                  // A node that reaches no other node has no distance: the pipeline stores 0, but the value is
                  // undefined, as step 9 says ("无连接，无法定义"), not a closeness of 0.
                  : pathMetricUndefined(column, row[column])
                    ? <span data-metric-undefined="true" title={`${fieldLabel(column, schema)}：${PATH_UNDEFINED_NOTE}`}>{PATH_UNDEFINED_LABEL}</span>
                    : fmtField(row[column], column, schema);
              const left = stickyLeft(index);
              const stickyStyle = left != null
                ? {
                  position: "sticky" as const, left, zIndex: 2, background: "#fff",
                  // The last sticky column casts an edge so scrolled values visibly pass under it.
                  ...(index === (stickyIndustry ? 1 : 0) ? { boxShadow: "inset -1px 0 #e8eaf0" } : {}),
                }
                : undefined;
              return index === 0 ? (
                <th key={column} className="indicator-row-header" scope="row" aria-label={indicatorRowHeaderLabel(row)} style={stickyStyle}>
                  {content}
                </th>
              ) : (
                <td key={column} className={TEXT_COLUMNS.has(column) ? "text-col" : undefined} style={stickyStyle}>{content}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IndicatorTable({ meta, groupKey, schema, state, year, country, page, interacted, countryNote, onYear, onCountry, onPage }: {
  meta: Meta;
  groupKey: IndicatorGroupKey;
  schema: IndicatorSchema | null | undefined;
  state: StepStateApi<IndicatorStepState>;
  year: number;
  country: string;
  page: number;
  interacted: boolean;
  /** A short muted line beside the country select (where an opening country came from). */
  countryNote?: string | null;
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
  const data = mainQuery.status === "success" ? mainQuery.data : null;

  // 筛选只保存当前浏览位置，不能暗中充当报告证据。
  useEffect(() => {
    if (!interacted) return;
    const metric = COUNTRY_METRIC[groupKey] ?? CORE_METRIC[groupKey];
    state.save({ year, country, metric });
    // state 每次渲染都是新对象,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, year, interacted, groupKey]);

  const group = schema?.groups.find((candidate) => candidate.key === groupKey);
  const cols = indicatorTableColumns(groupKey, group?.fields ?? [], data?.rows[0], showAllFields);
  const displayRows = groupKey === "network" && country && data
    ? sortNetworkRows(data.rows, networkSort)
    : (data?.rows ?? []);
  const knownPages = useRef(1);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : knownPages.current;
  knownPages.current = pages;
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
      triggerInContent
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
        {countryNote && <span className="muted indicator-carried-note" role="note">{countryNote}</span>}
        {!country && <span className="muted">“全部”也包括世界其他地区（ROW，是一个汇总项，不能单独选）。</span>}
        <FullscreenTriggerSlot />
      </div>

      {groupKey === "network" && (
        <div className="table-priority-tools network-table-sort">
          <LabeledControl label={country ? "单国行业排序" : "行业排序（先选一个国家）"}>
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
              ? "排序只改变显示顺序，不改变指标数值。"
              : "选择“全部”时按默认顺序分页显示；选择一个国家后可对它的全部行业排序。"}
          </span>
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
              <span className="muted">{showAllFields
                ? `已展开全部 ${allMetricCount} 个指标（前 ${defaultMetricCount} 个为常用指标）。`
                : `默认显示 ${defaultMetricCount} 个常用指标。`}</span>
              <button type="button" className="secondary" aria-expanded={showAllFields} onClick={toggleAllFields}>
                {showAllFields ? "收起扩展指标" : `展开 ${allMetricCount - defaultMetricCount} 个扩展指标（全屏查看）`}
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
              totalPages={pages}
            />
          </ScrollableRegion>
          {displayRows.some((row) => cols.some((column) => pathMetricUndefined(column, row[column]))) && (
            <p className="muted">“{PATH_UNDEFINED_LABEL}”：该行业{PATH_UNDEFINED_NOTE}，接近中心性、离心率与调和中心性没有定义（不是 0，与步骤 9 相同）。</p>
          )}
      </IndicatorRequestBoundary>
      {/* Outside the loading boundary: the pager stays mounted (and keeps focus) while the next page loads. */}
      {(data || knownPages.current > 1) && <Pager page={page} pages={pages} total={data?.total} onChange={onPage} />}
    </FullscreenPanel>
  );
}

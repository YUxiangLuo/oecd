/**
 * Steps 2–5 record their report material automatically: the country the student is looking at plus a
 * comparison country the student can see and change (default USA, or CHN when the first country is USA),
 * same year, the step's country-level headline indicator. A one-line status shows what was recorded.
 */
import { useEffect } from "react";
import { api } from "../../../api";
import { sameJsonValue } from "../../../session-store";
import { MATERIAL_LOCKED_ACTION, MATERIAL_LOCKED_NOTE, STEP_MATERIAL_ACTION_ID } from "../../../step-task-card";
import type { IndicatorSchema, Meta, StepStateApi } from "../../../types";
import { countryLabel } from "../../../viz";
import { fieldLabel, fmtField, useAsync } from "../../shared";
import { keepFocusNear } from "../../../a11y";
import { userFacingRequestError } from "../../../user-facing-error";
import {
  COUNTRY_METRIC,
  type IndicatorGroupKey,
  type IndicatorStepState,
  indicatorComparisonPatch,
} from "./indicator-table";

/** The country being viewed plus the comparison country; an invalid or identical choice falls back to USA (CHN for USA). */
export function autoComparisonCountries(meta: Meta, selected: string, partner = ""): [string, string] {
  const first = selected || (meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  if (partner && partner !== first && meta.countries.includes(partner)) return [first, partner];
  const preferred = first === "USA" ? "CHN" : "USA";
  const fallback = preferred !== first && meta.countries.includes(preferred)
    ? preferred
    : meta.countries.find((code) => code !== first && code !== "ROW") ?? "";
  return [first, fallback];
}

/** Whether the saved material already records this comparison. Saved state comes back from the server
 * with its object keys reordered, so compare by value rather than by serialised string. */
export function materialMatches(
  patch: Pick<IndicatorStepState, "compared" | "observations"> | null,
  saved: IndicatorStepState | undefined,
): boolean {
  return patch != null && sameJsonValue([patch.compared, patch.observations], [saved?.compared, saved?.observations]);
}

function comparisonUnit(metric: string, schema: IndicatorSchema | null | undefined): string {
  const format = schema?.fields[metric]?.format;
  if (format === "pct") return "%";
  if (format === "amount" || metric.startsWith("weighted ")) return "百万美元";
  return "无量纲";
}

export function useAutoComparison({ topic, meta, state, country, partner, year, schema, browseCountry }: {
  topic: IndicatorGroupKey;
  meta: Meta;
  state: StepStateApi<IndicatorStepState>;
  country: string;
  partner: string;
  year: number;
  schema: { status: string; data: IndicatorSchema | null | undefined };
  /** The table's own country when it differs from the recorded one (step 5 “全部” is ""): saved as the view. */
  browseCountry?: string;
}) {
  const pair = autoComparisonCountries(meta, country, partner);
  const metric = COUNTRY_METRIC[topic];
  const release = meta.dataset?.release_id ?? "";
  const requestKey = JSON.stringify(["auto-comparison", year]);
  const countryQuery = useAsync(
    async () => ({ year, rows: await api.countryIndicators(year) as Array<Record<string, unknown>> }),
    [requestKey],
    { requestKey },
  );
  const rows = countryQuery.status === "success" && countryQuery.data?.year === year ? countryQuery.data.rows : null;
  const patch = rows && schema.status === "success"
    ? indicatorComparisonPatch(rows, pair, year, metric, comparisonUnit(metric, schema.data), release, "auto-indicator-comparison")
    : null;
  const patchKey = patch ? JSON.stringify([patch.compared, patch.observations]) : "";
  const current = materialMatches(patch, state.data);

  // Report material follows what the student is looking at: no extra button or table to open.
  // Once the report is submitted, browsing leaves the material alone (see `record`).
  useEffect(() => {
    if (!patch || current || state.materialLocked) return;
    state.save({ ...patch, country: browseCountry ?? patch.country, material_chosen: undefined });
    // state is a new object each render; the key and match flag capture every meaningful change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey, current]);

  // Marked as the student's choice, so the report does not call it an automatic record.
  const record = patch && !current ? () => state.save({ ...patch, material_chosen: true }) : undefined;
  return {
    first: pair[0], second: pair[1], current, record,
    loadFailed: countryQuery.status === "error",
    loadError: countryQuery.error,
    onRetryLoad: countryQuery.retry,
  };
}

export function AutoMaterialStatus({ meta, state, schema, first, second, current, record, onSecond, loadFailed, loadError = null, onRetryLoad, where, note }: {
  meta: Meta;
  state: StepStateApi<IndicatorStepState>;
  schema: IndicatorSchema | null | undefined;
  first: string;
  second: string;
  /** Whether the saved observations match the current selection. */
  current: boolean;
  /** Records the current selection explicitly (offered once the material is locked). */
  record?: () => void;
  onSecond: (country: string) => void;
  loadFailed: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  /** Where the first country is chosen, e.g. “上方所选国家”. */
  where: string;
  /** Extra reading caveat for this step's indicator. */
  note?: string;
}) {
  // Locked material is shown as saved even when the student browses something else.
  const recorded = current || state.materialLocked ? state.data?.observations ?? [] : [];
  return (
    <div id={STEP_MATERIAL_ACTION_ID} tabIndex={-1} className={`auto-material${loadFailed && recorded.length !== 2 ? " auto-material--failed" : ""}`}>
      <b>报告材料 · {state.materialLocked ? "已记录" : "自动记录"}</b>
      {recorded.length === 2
        ? <span role="status">{recorded[0].year} 年 · {recorded.map((item) => `${countryLabel(item.country)} ${fmtField(item.value, item.metric, schema)}`).join("；")} · {fieldLabel(recorded[0].metric, schema)}</span>
        : <span role="status">
          {loadFailed ? userFacingRequestError(loadError, "国家级数据加载失败") : "正在记录当前选择…"}
          {loadFailed && onRetryLoad && <button type="button" className="secondary" onClick={(event) => { const button = event.currentTarget; onRetryLoad(); keepFocusNear(button); }}>重试</button>}
        </span>}
      <label className="auto-material-partner">对比国家
        <select value={second} onChange={(event) => onSecond(event.target.value)}>
          {meta.countries.filter((code) => code !== first).map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
        </select>
      </label>
      {state.materialLocked
        ? <small>{MATERIAL_LOCKED_NOTE}{record && <button type="button" className="secondary" onClick={record}>{MATERIAL_LOCKED_ACTION.replace("图表", "选择")}</button>}</small>
        : <small>记录{where}和对比国家在同一年的本步代表指标（国家级），换国家或年份后自动更新，无需另外保存。{note ? ` ${note}` : ""}</small>}
    </div>
  );
}

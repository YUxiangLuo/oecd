/**
 * Steps 2–5 record their report material automatically: the country the student is looking at, its
 * country-level headline indicator for the selected year. A one-line status shows what was recorded.
 * There is no comparison country here; comparing countries belongs to steps 6–9.
 */
import { useEffect, useState } from "react";
import { api } from "../../../api";
import { sameJsonValue } from "../../../session-store";
import { MATERIAL_LOCKED_ACTION } from "../../../step-task-card";
import { AUTO_RECORD_HOW, MaterialCard } from "../../../material-card";
import type { IndicatorSchema, Meta, StepStateApi } from "../../../types";
import { cjkSpace, formatMetric } from "../../../format";
import { countryLabel } from "../../../viz";
import { AsyncStateMessage, fieldLabel, useAsync } from "../../shared";
import { userFacingRequestError } from "../../../user-facing-error";
import {
  COUNTRY_METRIC,
  type IndicatorGroupKey,
  type IndicatorStepState,
  indicatorMaterialPatch, type IndicatorObservation } from "./indicator-table";

/** The country whose reading is recorded: the one being viewed, else CHN (the decomposition's default). */
export function autoMaterialCountry(meta: Meta, selected: string): string {
  return selected || (meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
}

/** Whether the saved material already records this reading. Saved state comes back from the server
 * with its object keys reordered, so compare by value rather than by serialised string. */
export function materialMatches(
  patch: Pick<IndicatorStepState, "compared" | "observations"> | null,
  saved: IndicatorStepState | undefined,
): boolean {
  return patch != null && sameJsonValue([patch.compared, patch.observations], [saved?.compared, saved?.observations]);
}

function materialUnit(metric: string, schema: IndicatorSchema | null | undefined): string {
  const format = schema?.fields[metric]?.format;
  if (format === "pct") return "%";
  if (format === "amount" || metric.startsWith("weighted ")) return "百万美元";
  return "无量纲";
}

export function useAutoMaterial({ topic, meta, state, country, year, schema, browseCountry }: {
  topic: IndicatorGroupKey;
  meta: Meta;
  state: StepStateApi<IndicatorStepState>;
  country: string;
  year: number;
  schema: { status: string; data: IndicatorSchema | null | undefined; error?: string | null; retry?: () => void };
  /** The table's own country when it differs from the recorded one (step 5 “全部” is ""): saved as the view. */
  browseCountry?: string;
}) {
  const recorded = autoMaterialCountry(meta, country);
  const metric = COUNTRY_METRIC[topic];
  const release = meta.dataset?.release_id ?? "";
  const requestKey = JSON.stringify(["auto-material", year]);
  const countryQuery = useAsync(
    async () => ({ year, rows: await api.countryIndicators(year) as Array<Record<string, unknown>> }),
    [requestKey],
    { requestKey },
  );
  const rows = countryQuery.status === "success" && countryQuery.data?.year === year ? countryQuery.data.rows : null;
  const patch = rows && schema.status === "success"
    ? indicatorMaterialPatch(rows, recorded, year, metric, materialUnit(metric, schema.data), release)
    : null;
  const patchKey = patch ? JSON.stringify([patch.compared, patch.observations]) : "";
  const current = materialMatches(patch, state.data);

  // Report material follows what the student is looking at: no extra button or table to open.
  // Once the report is submitted, browsing leaves the material alone (see `record`).
  useEffect(() => {
    if (!patch || current || state.materialLocked) return;
    state.save({ ...patch, country: browseCountry ?? patch.country, material_chosen: undefined, material_label: indicatorMaterialLabel(patch.observations ?? [], schema.status === "success" ? schema.data : null) });
    // state is a new object each render; the key and match flag capture every meaningful change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey, current]);

  // Marked as the student's choice, so the report does not call it an automatic record.
  const record = patch && !current ? () => state.save({ ...patch, material_chosen: true, material_label: indicatorMaterialLabel(patch.observations ?? [], schema.status === "success" ? schema.data : null) }) : undefined;
  const loadErrors = [
    schema.status === "error" ? userFacingRequestError(schema.error, "指标说明加载失败") : null,
    countryQuery.status === "error" ? userFacingRequestError(countryQuery.error, "国家整体数据加载失败") : null,
  ].filter((error): error is string => error !== null);
  return {
    country: recorded, metric, current, record,
    loadFailed: loadErrors.length > 0,
    loadPending: [schema.status, countryQuery.status].some((status) => status === "loading" || status === "idle"),
    loadError: loadErrors.join(" ") || null,
    onRetryLoad: () => {
      if (schema.status === "error") schema.retry?.();
      if (countryQuery.status === "error") countryQuery.retry();
    },
  };
}

/** "GVC 位置指数（前向 GVC 段／后向 GVC 段，国家整体）": one bracket pair, never two back to back. */
export function countryScope(label: string): string {
  return label.endsWith("）") ? `${label.slice(0, -1)}，国家整体）` : `${label}（国家整体）`;
}

/** The sentence a reading is recorded as: "2020 年 外国增加值项占比：CHN 中国 11.730%". */
export function indicatorMaterialLabel(observations: readonly IndicatorObservation[], schema: IndicatorSchema | null | undefined): string {
  if (!observations.length) return "";
  return `${cjkSpace(`${observations[0].year} 年`, fieldLabel(observations[0].metric, schema))}：${observations.map((item) => {
    // Saved readings remain interpretable when indicator metadata is temporarily unavailable.
    const format = schema?.fields[item.metric]?.format ?? (item.unit === "%" ? "pct" : item.unit === "百万美元" ? "amount" : undefined);
    return `${countryLabel(item.country)} ${formatMetric(item.value, format)}${item.unit === "百万美元" ? " 百万美元" : ""}`;
  }).join("；")}`;
}

export function AutoMaterialStatus({ state, schema, metric, current, record: _record, loadFailed, loadPending = false, loadError = null, onRetryLoad, where, lead, note }: {
  state: StepStateApi<IndicatorStepState>;
  schema: IndicatorSchema | null | undefined;
  /** The step's country-level indicator, named in the explanation line. */
  metric?: string;
  /** Whether the saved observations match the current selection. */
  current: boolean;
  /** Records the current selection explicitly (offered once the material is locked). */
  record?: () => void;
  loadFailed: boolean;
  loadPending?: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  /** Where the country is chosen, e.g. “上方所选国家”. */
  where: string;
  /** Replaces "记录{where}" when the view and the record differ, e.g. step 5 with 国家 = 全部:
   * "表格显示全部国家；报告材料记录最近选的国家 DEU 德国。" */
  lead?: string;
  /** Extra reading caveat for this step's indicator. */
  note?: string;
}) {
  // Keep the last saved material visible while the current selection loads or fails. It must not be
  // mistaken for the new selection, and a submitted report must not be rewritten by recovery.
  const recorded = current || state.materialLocked || loadFailed || loadPending ? state.data?.observations ?? [] : [];
  const [rechosen, setRechosen] = useState(false);
  const scope = cjkSpace(lead ? "记录的是同一年的" : "同一年的", countryScope(metric ? fieldLabel(metric, schema) : "本步指标"));
  const savedLabel = typeof state.data?.material_label === "string" ? state.data.material_label : null;
  return <>
    {loadFailed && <AsyncStateMessage status="error"
      error={loadError ?? userFacingRequestError(null, "报告材料数据加载失败")}
      onRetry={onRetryLoad ?? (() => {})} />}
    <MaterialCard
      state={recorded.length ? "recorded" : loadFailed ? "blocked" : "missing"}
      summary={recorded.length
        ? !schema && savedLabel ? savedLabel : indicatorMaterialLabel(recorded, schema)
        : loadFailed
          ? "当前选择尚未记录，请重试数据加载。"
          : loadPending ? "正在加载当前选择的报告材料…" : "正在记录当前选择…"}
      extra={recorded.length && (loadFailed || loadPending)
        ? `${loadFailed ? "当前选择的数据加载失败" : "正在加载当前选择的数据"}；此处保留已记录材料。${state.materialLocked ? "" : "加载恢复后将自动更新为当前选择。"}`
        : undefined}
      how={`${lead ?? `记录${where}`}${scope}，${AUTO_RECORD_HOW}${note ? ` ${note}` : ""}`}
      locked={state.materialLocked}
      rechosen={rechosen && current}
      action={state.materialLocked && _record ? { label: MATERIAL_LOCKED_ACTION.replace("当前图表", "当前选择"), onClick: () => { setRechosen(true); _record(); } } : null}
      syncing={state.syncing}
      syncError={state.materialSyncError ?? null}
        syncConflict={state.syncConflict}
      onRetrySync={state.syncNow}
    />
  </>;
}

/**
 * Steps 2–5 record their report material automatically: the country the student is looking at plus a
 * fixed partner (USA, or CHN when the student picks USA), same year, the step's country-level headline
 * indicator. No button, no extra table; a one-line status shows what was recorded.
 */
import { useEffect } from "react";
import { api } from "../../../api";
import { STEP_MATERIAL_ACTION_ID } from "../../../step-task-card";
import type { IndicatorSchema, Meta, StepStateApi } from "../../../types";
import { countryLabel } from "../../../viz";
import { fieldLabel, fmtField, useAsync } from "../../shared";
import {
  COUNTRY_METRIC,
  type IndicatorGroupKey,
  type IndicatorStepState,
  indicatorComparisonPatch,
} from "./indicator-table";

/** The country being viewed plus a fixed partner (USA, or CHN when the student picks USA). */
export function autoComparisonCountries(meta: Meta, selected: string): [string, string] {
  const first = selected || (meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const preferred = first === "USA" ? "CHN" : "USA";
  const partner = preferred !== first && meta.countries.includes(preferred)
    ? preferred
    : meta.countries.find((code) => code !== first && code !== "ROW") ?? "";
  return [first, partner];
}

function comparisonUnit(metric: string, schema: IndicatorSchema | null | undefined): string {
  const format = schema?.fields[metric]?.format;
  if (format === "pct") return "%";
  if (format === "amount" || metric.startsWith("weighted ")) return "百万美元";
  return "无量纲";
}

export function useAutoComparison({ topic, meta, state, country, year, schema }: {
  topic: IndicatorGroupKey;
  meta: Meta;
  state: StepStateApi<IndicatorStepState>;
  country: string;
  year: number;
  schema: { status: string; data: IndicatorSchema | null | undefined };
}) {
  const pair = autoComparisonCountries(meta, country);
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
  const savedKey = JSON.stringify([state.data?.compared, state.data?.observations]);

  // Report material follows what the student is looking at: no extra button or table to open.
  useEffect(() => {
    if (!patch || patchKey === savedKey) return;
    state.save(patch);
    // state is a new object each render; the keys capture every meaningful change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey, savedKey]);

  return { first: pair[0], loadFailed: countryQuery.status === "error" };
}

export function AutoMaterialStatus({ state, schema, loadFailed, where }: {
  state: StepStateApi<IndicatorStepState>;
  schema: IndicatorSchema | null | undefined;
  loadFailed: boolean;
  /** Where the country is chosen, e.g. “上方所选国家”. */
  where: string;
}) {
  const recorded = state.data?.observations ?? [];
  return (
    <p id={STEP_MATERIAL_ACTION_ID} tabIndex={-1} className="auto-material" role="status">
      <b>报告材料 · 自动记录</b>
      {recorded.length === 2
        ? <span>{recorded[0].year} 年 · {recorded.map((item) => `${countryLabel(item.country)} ${fmtField(item.value, item.metric, schema)}`).join("；")} · {fieldLabel(recorded[0].metric, schema)}</span>
        : <span>{loadFailed ? "国家级数据加载失败，请刷新后重试。" : `正在根据${where}自动记录…`}</span>}
      <small>按{where}与美国（选美国时改为中国）在同一年的本步代表指标自动记录，无需另外保存。</small>
    </p>
  );
}

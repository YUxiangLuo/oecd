import { useEffect, useRef, useState } from "react";
import { MATERIAL_LOCKED_ACTION, MATERIAL_LOCKED_NOTE } from "../../../step-task-card";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { IndicatorSchema, Meta } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { HEAT_EVIDENCE_METRIC } from "../../../viz/views/network-heat";
import { AsyncStateMessage, fmtDb, useAsync } from "../../shared";
import { currentReleaseId, type Row, type VizObservation } from "./scaffold";
import { IndicatorTrendChart } from "./indicator-charts";
import { defaultComparison, type YearDistribution } from "./indicator-model";
import { NetworkRanking, networkRanking } from "./network-ranking";

const COMMON_METRICS = ["weighted degree", "weighted indegree", "weighted outdegree", HEAT_EVIDENCE_METRIC];

export interface NetworkTrendPoint { country: string; year: number; value: number | null }

/** Missing observations remain gaps; neither zero-fill nor connect across them. */
export function networkTrendPoints(rows: Row[], years: number[], countries: string[], industry: string, metric: string = HEAT_EVIDENCE_METRIC): NetworkTrendPoint[] {
  return countries.flatMap((country) => [...years].sort((a, b) => a - b).map((year) => {
    const value = rows.find((row) => row.country === country && row.year === year && row.industry === industry)?.[metric];
    return { country, year, value: typeof value === "number" && Number.isFinite(value) ? value : null };
  }));
}

export function NetworkTrend({ meta, schema, initialCountry, initialCountries = [], observations = [], syncing = false, syncError = null, onRetrySync, onRecord, locked = false }: {
  meta: Meta;
  schema?: IndicatorSchema | null;
  initialCountry: string;
  /** The saved (or carried-over) comparison pair, used when no readings are recorded yet. */
  initialCountries?: string[];
  observations?: VizObservation[];
  syncing?: boolean;
  syncError?: string | null;
  onRetrySync?: () => void;
  onRecord: (countries: string[], observations: VizObservation[]) => void;
  /** The report is submitted: record only when the student asks (see StepStateApi.materialLocked). */
  locked?: boolean;
}) {
  const countries = meta.countries.filter((country) => country !== "ROW");
  const years = [...meta.years].sort((a, b) => a - b);
  const restored = observations.filter((item) => (item.source === "explicit-network-trend" || item.source === "explicit-network-ranking") && item.release === currentReleaseId(meta));
  const restoredCountries = [...new Set(restored.map((item) => item.country))].filter((country) => countries.includes(country));
  const [defaultFirst, defaultSecond] = defaultComparison(countries, restoredCountries.length ? restoredCountries : initialCountries.length >= 2 ? initialCountries : [initialCountry]);
  const [first, setFirst] = useState(defaultFirst);
  const [second, setSecond] = useState(defaultSecond);
  const [industry, setIndustry] = useState(meta.sectors.includes(restored[0]?.industry ?? "") ? restored[0].industry! : meta.sectors.includes("C26") ? "C26" : meta.sectors[0] ?? "");
  const [metric, setMetric] = useState(restored[0]?.metric ?? "weighted degree");
  const [view, setView] = useState<"trend" | "ranking">(restored[0]?.source === "explicit-network-ranking" ? "ranking" : "trend");
  // Picking an industry in the ranking unmounts the clicked button; move focus to the new scope line.
  const scopeRef = useRef<HTMLParagraphElement>(null);
  const [focusScope, setFocusScope] = useState(false);
  useEffect(() => {
    if (!focusScope) return;
    scopeRef.current?.focus();
    setFocusScope(false);
  }, [focusScope]);
  const [year, setYear] = useState(restored[0]?.source === "explicit-network-ranking" && years.includes(restored[0].year) ? restored[0].year : years.at(-1)!);
  const [limit, setLimit] = useState(new Set(restored.map((item) => item.industry)).size > 10 ? 200 : 10);
  const metrics = schema?.groups.find((group) => group.key === "network")?.fields ?? COMMON_METRICS;
  const label = schema?.fields[metric]?.label ?? (metric === "weighted degree" ? "加权总度（入+出；自环双计）" : metric);
  const unit = metric.startsWith("weighted ") ? "百万美元" : metric === HEAT_EVIDENCE_METRIC ? "未归一化介数" : ["degree", "indegree", "outdegree"].includes(metric) ? "连接数" : metric === "Eccentricity" ? "路径长度" : "无量纲";
  const selected = second && second !== first ? [first, second] : [first];
  const release = currentReleaseId(meta);
  const requestKey = `${release}:network-trend:${selected.join(",")}:${years.join(",")}`;
  const query = useAsync<Row[]>(async () => {
    const pages = await Promise.all(selected.flatMap((country) => years.map(async (year) => {
      const page = await api.industryIndicatorsAll(year, country);
      return page.rows.map((row) => ({ ...row, year }));
    })));
    return pages.flat();
  }, [requestKey], { requestKey, enabled: Boolean(first && release) });
  // Global reference: the same industry in every economy (computed on the server from the full data).
  const trendReferenceKey = `${release}:network-reference:${metric}:${industry}:${selected.join(",")}`;
  const trendReference = useAsync(
    async () => (await api.industryDistribution(metric, { years, industry, countries: selected })).rows,
    [trendReferenceKey],
    { requestKey: trendReferenceKey, enabled: Boolean(release && view === "trend" && industry && first) },
  );
  const distribution: YearDistribution[] = trendReference.status === "success"
    ? (trendReference.data ?? []).map(({ year, n, p25, median, p75, ranks, ties }) => ({ year, n, p25, median, p75, ranks, ties }))
    : [];
  const rankingReferenceKey = `${release}:network-ranking-reference:${metric}:${year}:${first}`;
  const rankingReference = useAsync(
    async () => (await api.industryDistribution(metric, { years: [year], countries: [first] })).rows,
    [rankingReferenceKey],
    { requestKey: rankingReferenceKey, enabled: Boolean(release && view === "ranking" && first) },
  );
  const industryReference = new Map(
    rankingReference.status === "success"
      ? (rankingReference.data ?? []).map((row) => [row.industry, { median: row.median, n: row.n, rank: row.ranks[first], tie: row.ties?.[first] }] as const)
      : [],
  );
  const points = networkTrendPoints(query.data ?? [], years, selected, industry, metric);
  const ranked = networkRanking(query.data ?? [], year, selected, metric, limit);
  const finite = points.filter((point) => point.value !== null);
  const commonYears = years.filter((candidate) =>
    selected.every((country) =>
      points.some((point) => point.country === country && point.year === candidate && point.value !== null),
    ),
  );
  const canRecord = query.status === "success" && selected.length === 2
    && (view === "trend" ? commonYears.length >= 2
      : ranked.some((row) => row.values.every((value) => value !== null)));
  const readings = view === "trend" ? finite.filter((point) => commonYears.includes(point.year)).map((point) => ({ ...point, industry }))
    : ranked.filter((row) => row.values.every((value) => value !== null))
      .flatMap((row) => row.values.map((value, index) => ({ country: selected[index], industry: row.industry, year, value: value! })));
  const pendingObservations: VizObservation[] = readings.map((point) => ({
      entity: `${point.country}·${point.industry}`, country: point.country, industry: point.industry,
      year: point.year, value: point.value!, metric, unit,
      release: release ?? undefined, scope: "country-industry", generation: query.generation,
      request_key: requestKey, source: view === "trend" ? "explicit-network-trend" : "explicit-network-ranking",
  }));
  const materialKey = (rows: VizObservation[]) => JSON.stringify(rows.map(({ country, industry, year, metric, value, unit, source, release }) => [country, industry, year, metric, value, unit, source, release]));
  const matchesSaved = canRecord && materialKey(pendingObservations) === materialKey(observations);
  const savedYears = [...new Set(observations.map((item) => item.year))].sort((a, b) => a - b);
  const savedCountries = [...new Set(observations.map((item) => item.country))];
  const savedIndustries = [...new Set(observations.map((item) => item.industry).filter(Boolean))];
  const pendingKey = canRecord && release ? `${selected.join(",")}|${materialKey(pendingObservations)}` : "";
  // Report material follows the chart the student is looking at; incomplete charts never overwrite it.
  useEffect(() => {
    if (!pendingKey || matchesSaved || syncing || locked) return;
    onRecord(selected, pendingObservations);
    // pendingKey captures every meaningful change of the pending comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, matchesSaved, syncing]);
  return <section className="reg-section-card" aria-label="行业网络指标趋势">
    <h3>行业的网络位置怎样变化？在全部经济体的同一行业中处于什么位置？</h3>
    <div className="controls" aria-label="行业图表视角">
      <button className={view === "trend" ? "primary" : "secondary"} aria-pressed={view === "trend"} onClick={() => setView("trend")}>历年变化</button>
      <button className={view === "ranking" ? "primary" : "secondary"} aria-pressed={view === "ranking"} onClick={() => setView("ranking")}>定位行业</button>
    </div>
    <div className="controls">
      <LabeledControl label="网络指标">{(id) => <select id={id} name="network-metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
        <optgroup label="常用指标">{COMMON_METRICS.filter((key) => metrics.includes(key)).map((key) => <option key={key} value={key}>{schema?.fields[key]?.label ?? key}</option>)}</optgroup>
        <optgroup label="更多指标">{metrics.filter((key) => !COMMON_METRICS.includes(key)).map((key) => <option key={key} value={key}>{schema?.fields[key]?.label ?? key}</option>)}</optgroup>
      </select>}</LabeledControl>
      <LabeledControl label="国家 A">{(id) => <select id={id} name="network-country-a" value={first} onChange={(event) => {
        setFirst(event.target.value);
        // Choosing B's country as A swaps the pair rather than dropping the comparison.
        if (event.target.value === second) setSecond(first !== event.target.value ? first : "");
      }}>{countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}</select>}</LabeledControl>
      <LabeledControl label="对比国家 B">{(id) => <select id={id} name="network-country-b" value={second} onChange={(event) => setSecond(event.target.value)}>
        <option value="">暂不选择（报告材料需要对比国家）</option>
        {countries.filter((country) => country !== first).map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}
      </select>}</LabeledControl>
      {view === "trend" ? <LabeledControl label="行业">{(id) => <select id={id} value={industry} onChange={(event) => setIndustry(event.target.value)}>
        {meta.sectors.map((sector) => <option key={sector} value={sector}>{sectorLabel(sector)}</option>)}
      </select>}</LabeledControl> : <>
        <LabeledControl label="排名年份">{(id) => <select id={id} value={year} onChange={(event) => setYear(Number(event.target.value))}>{years.map((value) => <option key={value} value={value}>{value}</option>)}</select>}</LabeledControl>
        <LabeledControl label="显示行业">{(id) => <select id={id} value={limit} onChange={(event) => setLimit(Number(event.target.value))}><option value={10}>Top 10</option><option value={200}>全部行业</option></select>}</LabeledControl>
      </>}
    </div>
    <p ref={scopeRef} tabIndex={-1} aria-label="当前比较口径"><strong>
      {selected.map(countryLabel).join("与")} · {view === "trend" ? sectorLabel(industry) : "行业排名"} · {view === "trend" ? `${years[0]}–${years.at(-1)}` : year} · {label}
    </strong></p>
    {query.status !== "success" ? <AsyncStateMessage status={query.status} error={query.error} loadingLabel="正在加载历年行业指标…" onRetry={query.retry} /> : <>
      {view === "ranking" ? ranked.length ? <NetworkRanking rows={ranked} countries={selected} unit={unit} reference={industryReference} onIndustry={(next) => { setIndustry(next); setView("trend"); setFocusScope(true); }} /> : <p role="status">该年份没有可用的行业排名，请更换指标或国家。</p> : <>
      {finite.length ? <IndicatorTrendChart
        rows={(query.data ?? []).filter((row) => row.industry === industry)}
        countries={selected}
        years={years}
        metric={metric}
        label={label}
        unit={unit}
        distribution={distribution}
        mode="context"
        sameIndustry
      /> : <p role="status">该行业没有可用的指标观测，请更换行业、指标或国家。</p>}
      <details className="technical-details"><summary>查看趋势图逐年读数</summary>
        <ScrollableRegion className="table-wrap" label="行业趋势逐年读数"><table className="data-table">
          <thead><tr><th>年份</th>{selected.map((country) => <th key={country}>{countryLabel(country)}</th>)}</tr></thead>
          <tbody>{years.map((year) => <tr key={year}><td>{year}</td>{selected.map((country) => <td key={country}>{fmtDb(points.find((point) => point.year === year && point.country === country)?.value ?? null)}</td>)}</tr>)}</tbody>
        </table></ScrollableRegion>
      </details>
      </>}
    </>}
    {schema?.fields[metric]?.desc && <p className="muted viz-metric-desc">{label}：{schema.fields[metric].desc}</p>}
    <section className="qualified-run-card" aria-label="步骤9报告材料">
      <h3>报告材料 · {observations.length ? `已${locked ? "" : "自动"}记录（${observations.length} 条读数）` : "尚未记录"}</h3>
      <p role="status">{!canRecord
        ? `当前图表暂不能记录：${selected.length < 2 ? "报告材料需要一个对比国家；现在只看全球参照，不会记录。" : view === "trend" ? "两国至少需要两个共同有效年份。" : "至少一个展示行业需要两国都有有效读数。"}${observations.length ? "已记录的材料保持不变。" : ""}`
        : locked
          ? `${MATERIAL_LOCKED_NOTE}${matchesSaved ? "当前图表就是已记录的材料。" : ""}`
        : matchesSaved
          ? `当前图表已自动记录：${selected.map(countryLabel).join(" 与 ")} · ${view === "trend" ? `${sectorLabel(industry)} · ${years[0]}–${years.at(-1)} 年趋势` : `${year} 年行业排名`} · ${label}。换视角、国家或指标后会自动更新。`
          : "正在记录当前图表…"}</p>
      {locked && canRecord && !matchesSaved && (
        <button type="button" className="secondary" onClick={() => onRecord(selected, pendingObservations)}>{MATERIAL_LOCKED_ACTION}</button>
      )}
      {observations.length ? <details>
        <summary>核对已记录读数 · {observations.length} 条</summary>
        <p>{savedCountries.map(countryLabel).join(" 与 ")} · {schema?.fields[observations[0].metric ?? ""]?.label ?? observations[0].metric} · {observations[0].unit}</p>
        <p>{savedYears[0]}{savedYears.length > 1 ? `–${savedYears.at(-1)}` : ""} 年 · {savedIndustries.length === 1 ? sectorLabel(savedIndustries[0]!) : `${savedIndustries.length} 个行业`} · {observations.length} 条读数。</p>
        <ScrollableRegion className="table-wrap bounded-data-table" label="已记录报告材料读数"><table className="data-table">
          <thead><tr><th>国家与行业</th><th>年份</th><th>数值</th></tr></thead>
          <tbody>{observations.map((item, index) => <tr key={index}><td>{countryLabel(item.country)} · {sectorLabel(item.industry ?? "")}</td><td>{item.year}</td><td>{fmtDb(item.value)}</td></tr>)}</tbody>
        </table></ScrollableRegion>
      </details> : null}
      {syncError ? <div role="alert">材料尚未成功同步，请重试。{onRetrySync && <button className="secondary" onClick={onRetrySync}>重试同步</button>}</div> : syncing && <p className="muted" role="status">正在同步实验记录…</p>}
    </section>
  </section>;
}

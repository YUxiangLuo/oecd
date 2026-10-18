import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { NO_READINGS_NOTE, NOT_RECORDED_HINT, RECORD_CHART_ACTION, RECORDED_CHART_LABEL, REPLACE_MATERIAL_ACTION } from "../../../step-task-card";
import { MaterialCard } from "../../../material-card";
import { networkMaterialLabel } from "../../../material-label";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import { userFacingRequestError } from "../../../user-facing-error";
import type { IndicatorSchema, Meta } from "../../../types";
import { countryLabel, joinCountries, sectorLabel } from "../../../viz";
import { HEAT_EVIDENCE_METRIC, PATH_UNDEFINED_LABEL, pathMetricUndefined } from "../../../viz/views/network-heat";
import { AsyncStateMessage, useAsync } from "../../shared";
import { currentReleaseId, LensNav, Year2020Note, type NetworkBrowse, type Row, type VizObservation } from "./scaffold";
import { IndicatorTrendChart, indicatorNumber } from "./indicator-charts";
import { AddCountryControl, MaxCountriesNote } from "./add-country";
import { Butterfly } from "./theme-charts";
import { COMPARISON_LETTERS, DEFAULT_MARK, defaultComparison, defaultEntities, defaultMarkFor, MAX_ENTITIES, pickFirst, type YearDistribution } from "./indicator-model";
import { ScopeCard } from "./scope-card";
import { NetworkRanking, networkRanking, networkValue } from "./network-ranking";
import { unitText } from "../../../format";

const COMMON_METRICS = ["weighted degree", "weighted indegree", "weighted outdegree", HEAT_EVIDENCE_METRIC];

/** `undefined`: the value is not missing but undefined (a path metric of an industry with no outgoing links). */
export interface NetworkTrendPoint { country: string; year: number; value: number | null; undefined?: true }

/** Missing observations remain gaps; neither zero-fill nor connect across them. Undefined path metrics are gaps too. */
export function networkTrendPoints(rows: Row[], years: number[], countries: string[], industry: string, metric: string = HEAT_EVIDENCE_METRIC): NetworkTrendPoint[] {
  return countries.flatMap((country) => [...years].sort((a, b) => a - b).map((year) => {
    const value = rows.find((row) => row.country === country && row.year === year && row.industry === industry)?.[metric];
    return { country, year, value: networkValue(value, metric), ...(pathMetricUndefined(metric, value) ? { undefined: true as const } : {}) };
  }));
}

export function NetworkTrend({ meta, schema, initialCountry, initialCountries = [], initialBrowse, onBrowse, carriedNote = null, observations = [], savedLabel, pending = false, syncing = false, syncError = null, syncConflict = false, onRetrySync, onRecord, locked = false, extraLenses = [], renderExtra, renderTable }: {
  meta: Meta;
  schema?: IndicatorSchema | null;
  initialCountry: string;
  /** The saved (or carried-over) comparison pair, used when no readings are recorded yet. */
  initialCountries?: string[];
  /** The countries, view, industry, indicator and year last on screen (recorded or not); they win over the rest. */
  initialBrowse?: NetworkBrowse;
  /** Called with the browsing state whenever the student changes it, so leaving the step keeps it. */
  onBrowse?: (browse: NetworkBrowse) => void;
  /** "沿用步骤 n 的国家，可以更换。" while the opening countries are the carried ones. */
  carriedNote?: string | null;
  observations?: VizObservation[];
  pending?: boolean;
  syncing?: boolean;
  syncError?: string | null;
  syncConflict?: boolean;
  onRetrySync?: () => void;
  /** Records the chart on screen as the step's material (the student asked: `material_chosen`). */
  onRecord: (countries: string[], observations: VizObservation[], label: string) => void;
  /** The sentence the recorded chart was saved as (`material_label`); the card repeats it. */
  savedLabel?: string;
  /** The report is submitted: record only when the student asks (see StepStateApi.materialLocked). */
  locked?: boolean;
  /** Step-specific views that live beside the two recording views (they never record material). */
  extraLenses?: { key: string; label: string }[];
  /** Exploration views share this component's year, so every view and the scope line agree. */
  renderExtra?: (key: string, countries: string[], year: number, onYear: (year: number) => void) => ReactNode;
  /** The full-indicator table, folded into the 行业排名 view. */
  renderTable?: (year: number, onYear: (year: number) => void) => ReactNode;
}) {
  const countries = meta.countries.filter((country) => country !== "ROW");
  const years = [...meta.years].sort((a, b) => a - b);
  const restored = observations.filter((item) => (item.source === "explicit-network-trend" || item.source === "explicit-network-ranking") && item.release === currentReleaseId(meta));
  const restoredCountries = [...new Set(restored.map((item) => item.country))].filter((country) => countries.includes(country));
  // Saved readings or the carried-over list give the entities; a lone drill country still opens as a pair.
  const browse = initialBrowse && Array.isArray(initialBrowse.countries) && countries.includes(initialBrowse.countries[0])
    ? initialBrowse
    : undefined;
  const browseCountries = browse ? browse.countries.filter((country) => countries.includes(country)) : [];
  const [defaultFirst, ...defaultOthers] = defaultEntities(
    countries,
    browseCountries.length ? browseCountries
      : restoredCountries.length ? restoredCountries : initialCountries.length >= 2 ? initialCountries : defaultComparison(countries, [initialCountry]),
  );
  const [first, setFirst] = useState(defaultFirst);
  const [others, setOthers] = useState<string[]>(defaultOthers);
  // The trend's industry comes from trend material only: a recorded ranking lists many industries, and its first
  // one (the top-ranked industry) must not replace the industry the trend was read in.
  const trendIndustry = restored.find((item) => item.source === "explicit-network-trend")?.industry;
  const [industry, setIndustry] = useState([browse?.industry, trendIndustry, "C26", meta.sectors[0]]
    .find((sector) => sector && meta.sectors.includes(sector)) ?? "");
  const [pickedMetric, setMetric] = useState(browse?.metric || (restored[0]?.metric ?? "weighted degree"));
  // Start with a recordable trend; preserve an explicitly browsed or recorded view.
  const lenses = [
    ...extraLenses.filter((lens) => lens.key === "global-network"),
    { key: "trend", label: "历年变化" },
    { key: "ranking", label: "行业排名" },
    { key: "flows", label: "买入与卖出" },
    ...extraLenses.filter((lens) => lens.key !== "global-network"),
  ];
  const [pickedView, setView] = useState<string>(browse?.view || (restored.length
    ? restored[0].source === "explicit-network-ranking" ? "ranking" : "trend"
    : "trend"));
  const view = lenses.some((lens) => lens.key === pickedView) ? pickedView : "trend";
  const [countriesChosen, setCountriesChosen] = useState(false);
  // Recorded on request after submission: the confirmation then says to update the report on step 15.
  const [rechosen, setRechosen] = useState(false);
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const shownCarriedNote = carriedNote && !countriesChosen
    && [defaultFirst, ...defaultOthers].join(",") === initialCountries.join(",") ? carriedNote : null;
  const changeOthers = (next: string[]) => { setCountriesChosen(true); setSwapNote(null); setOthers(next); };
  // Only the two comparison views record material; the extra views are exploration.
  const recordable = view === "trend" || view === "ranking";
  // Picking an industry in the ranking unmounts the clicked button; move focus to the new scope line.
  const scopeRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);
  const addRef = useRef<HTMLSelectElement>(null);
  const [focusScope, setFocusScope] = useState(false);
  useEffect(() => {
    if (!focusScope) return;
    scopeRef.current?.focus();
    setFocusScope(false);
  }, [focusScope]);
  const [year, setYear] = useState(browse && years.includes(browse.year) ? browse.year
    : restored[0]?.source === "explicit-network-ranking" && years.includes(restored[0].year) ? restored[0].year : years.at(-1)!);
  const [limit, setLimit] = useState(new Set(restored.map((item) => item.industry)).size > 10 ? 200 : 10);
  // 买入与卖出 has its own length (前 15 个), separate from the ranking's 前 10 个.
  const [flowsLimit, setFlowsLimit] = useState(15);
  const metrics = schema?.groups.find((group) => group.key === "network")?.fields ?? COMMON_METRICS;
  // A blank or unknown metric (an empty saved value, or a pick the list does not offer) would show the list's first
  // option while reading nothing: no 指标 in the scope line and "该行业没有数据". It falls back to 加权总度; a saved
  // metric is checked only against the loaded schema, so it is kept while the schema loads.
  const metric = pickedMetric && (!schema || metrics.includes(pickedMetric)) ? pickedMetric : "weighted degree";
  const label = schema?.fields[metric]?.label ?? (metric === "weighted degree" ? "加权总度" : metric);
  const unit = metric.startsWith("weighted ") ? "百万美元" : metric === HEAT_EVIDENCE_METRIC ? "未归一化介数" : ["degree", "indegree", "outdegree"].includes(metric) ? "连接数" : metric === "Eccentricity" ? "路径长度" : "无量纲";
  const selected = [first, ...others.filter((country, index, all) => country !== first && all.indexOf(country) === index)].slice(0, MAX_ENTITIES);
  // Every change of what is on screen is kept as browsing state, recorded or not (see `onBrowse`).
  const browseNow: NetworkBrowse = { countries: selected, view, industry, metric: pickedMetric, year };
  const browseKey = JSON.stringify(browseNow);
  const browseSaved = useRef(browseKey);
  useEffect(() => {
    if (browseSaved.current === browseKey) return;
    browseSaved.current = browseKey;
    onBrowse?.(browseNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey]);
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
    ? (trendReference.data ?? []).map(({ year, n, p25, median, p75, ranks, ties, no_output }) => ({ year, n, p25, median, p75, ranks, ties, noOutput: no_output }))
    : [];
  const rankingReferenceKey = `${release}:network-ranking-reference:${metric}:${year}:${selected.join(",")}`;
  const rankingReference = useAsync(
    async () => (await api.industryDistribution(metric, { years: [year], countries: selected })).rows,
    [rankingReferenceKey],
    { requestKey: rankingReferenceKey, enabled: Boolean(release && view === "ranking" && first) },
  );
  const activeReference = view === "trend" ? trendReference : rankingReference;
  // Exploration views: one economy's industries at the ranking year.
  const industriesOf = (country: string) => (query.data ?? []).filter((row) => row.country === country && row.year === year && row.industry != null);
  const flowRows = selected.map((country) => industriesOf(country)
    .filter((row) => typeof row["weighted degree"] === "number")
    .sort((a, b) => (b["weighted degree"] as number) - (a["weighted degree"] as number))
    .slice(0, flowsLimit));
  const flowScaleMax = Math.max(1, ...flowRows.flatMap((rows) => rows.flatMap((row) =>
    [row["weighted indegree"], row["weighted outdegree"]].filter((value): value is number => typeof value === "number" && Number.isFinite(value)).map(Math.abs))));
  const industryReference = new Map(
    rankingReference.status === "success"
      ? (rankingReference.data ?? []).map((row) => [row.industry, { median: row.median, n: row.n, ranks: row.ranks, ties: row.ties, noOutput: row.no_output }] as const)
      : [],
  );
  const points = networkTrendPoints(query.data ?? [], years, selected, industry, metric);
  const chartKey = [view, industry, metric, year, limit, flowsLimit, selected.join(",")].join("|");
  const ranked = networkRanking(query.data ?? [], year, selected, metric, limit);
  const finite = points.filter((point) => point.value !== null);
  const commonYears = years.filter((candidate) =>
    selected.every((country) =>
      points.some((point) => point.country === country && point.year === candidate && point.value !== null),
    ),
  );
  const readings = view === "trend" ? finite.filter((point) => commonYears.includes(point.year)).map((point) => ({ ...point, industry }))
    : ranked.filter((row) => row.values.every((value) => value !== null))
      .flatMap((row) => row.values.map((value, index) => ({ country: selected[index], industry: row.industry, year, value: value! })));
  // A trend where every reading is the same (an industry with no output: all 0) shows no difference to write
  // about; it must not replace useful material. A ranking is refused only when it is all 0 (whole-number
  // metrics such as 离心率 can tie across the top industries and still be worth reading against the ranks).
  const allSame = readings.length > 0 && readings.every((point) => point.value === readings[0].value);
  const flatValue = allSame && (view === "trend" ? commonYears.length >= 2 : readings[0].value === 0) ? readings[0].value : null;
  // One economy alone is a chart here too: the reference is the same industry in every economy.
  const canRecord = recordable && query.status === "success" && selected.length >= 1
    && (view === "trend" ? commonYears.length >= 2
      : ranked.some((row) => row.values.every((value) => value !== null)))
    && flatValue === null;
  const undefinedPoints = view === "trend" ? points.filter((point) => point.undefined) : [];
  // Economies whose industry has no outgoing links in every year: their metric is undefined throughout, so the
  // blocked note names them instead of saying "有的年份".
  const undefinedThroughout = [...new Set(undefinedPoints.map((point) => point.country))]
    .filter((country) => undefinedPoints.filter((point) => point.country === country).length === years.length);
  const pendingObservations: VizObservation[] = readings.map((point) => ({
      entity: `${point.country}·${point.industry}`, country: point.country, industry: point.industry,
      year: point.year, value: point.value!, metric, unit,
      release: release ?? undefined, scope: "country-industry", generation: query.generation,
      request_key: requestKey, source: view === "trend" ? "explicit-network-trend" : "explicit-network-ranking",
  }));
  const blockedReason = flatValue !== null && query.status === "success"
    ? `图上${view === "trend" ? `所选国家历年的${label}` : `显示的行业的${label}`}全部${flatValue === 0 ? "为 0（真实的 0，例如没有生产或连接，不是缺少数据）" : `相同（都是 ${indicatorNumber(flatValue, unit)}）`}，没有可比较的差别，不记录为报告材料。`
    : view === "trend"
      ? (undefinedThroughout.length ? `${joinCountries(undefinedThroughout)}在所选年份都没有${label}读数（该行业无连接）；请换一个行业、指标或国家。`
        : undefinedPoints.length ? `有的年份该行业无连接，${label}无法定义；所选国家至少需要两个共同有效年份，请换一个行业、指标或国家。` : "所选国家至少需要两个共同有效年份。")
      : "显示的行业里，至少要有一个行业所有所选国家都有数据。";
  const pendingLabel = networkMaterialLabel({ view: view === "trend" ? "trend" : "ranking", metric: label, countries: selected, industry, years: view === "trend" ? commonYears : [year], readings: pendingObservations.length });
  const materialKey = (rows: VizObservation[]) => JSON.stringify(rows.map(({ country, industry, year, metric, value, unit, source, release }) => [country, industry, year, metric, value, unit, source, release]));
  const matchesSaved = canRecord && materialKey(pendingObservations) === materialKey(observations);
  const savedYears = [...new Set(observations.map((item) => item.year))].sort((a, b) => a - b);
  const savedCountries = [...new Set(observations.map((item) => item.country))];
  const savedIndustries = [...new Set(observations.map((item) => item.industry).filter(Boolean))];
  return <section className="reg-section-card" aria-label="行业网络指标趋势">
    <h3>行业的网络位置怎样变化？在全部经济体的同一行业中处于什么位置？</h3>
    {/* The note says the country can be changed: only where the country selects are (not the global network). */}
    {shownCarriedNote && view !== "global-network" && <p className="muted indicator-carried-note" role="note">{shownCarriedNote}</p>}
    {view !== "global-network" && <div className="controls" role="group" aria-label="所选国家">
      <LabeledControl label="国家 A">{(id) => <select id={id} ref={firstRef} name="network-country-a" value={first} onChange={(event) => {
        const next = event.target.value;
        // Choosing a comparison country as A swaps it with the old A rather than dropping it.
        const picked = pickFirst(first, others, next);
        changeOthers(picked.others);
        setSwapNote(picked.note);
        setFirst(next);
      }}>{countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}</select>}</LabeledControl>
      {others.map((country, index) => (
        <LabeledControl key={index} label={`对比国家 ${COMPARISON_LETTERS[index]}`}>{(id) => (
          <span className="add-country">
            <select id={id} name={index ? undefined : "network-country-b"} value={country} onChange={(event) => changeOthers(others.map((item, at) => (at === index ? event.target.value : item)))}>
              {countries.filter((candidate) => candidate === country || !selected.includes(candidate)).map((candidate) => <option key={candidate} value={candidate}>{countryLabel(candidate)}{index === 0 && candidate === defaultMarkFor(countries, first) ? DEFAULT_MARK : ""}</option>)}
            </select>
            {/* A separate button: as the select's first option, arrow keys could remove a country unnoticed. */}
            <button type="button" className="secondary" aria-label={`移除对比国家 ${COMPARISON_LETTERS[index]}：${countryLabel(country)}`} onClick={() => {
              changeOthers(others.filter((_, at) => at !== index));
              window.requestAnimationFrame(() => (addRef.current ?? firstRef.current)?.focus());
            }}>移除</button>
          </span>
        )}</LabeledControl>
      ))}
      {selected.length < MAX_ENTITIES && (
        <AddCountryControl
          ref={addRef}
          label={others.length ? "再加一个对比国家" : "加一个对比国家（可选）"}
          emptyLabel="选择国家…"
          name={others.length ? undefined : "network-country-b"}
          candidates={countries.filter((candidate) => !selected.includes(candidate))}
          onAdd={(country) => changeOthers([...others, country])}
          focusAfterAdd={() => (addRef.current ?? firstRef.current)?.focus()}
        />
      )}
      {selected.length >= MAX_ENTITIES && <MaxCountriesNote />}
      {swapNote && <span className="muted" role="status">{swapNote}</span>}
    </div>}
    {/* Start with the global overview, followed by comparisons and other exploration views. */}
    <LensNav
      lenses={lenses}
      active={view}
      onPick={setView}
    />
    {view === "flows" && <p className="muted lens-hint">买入与卖出：每行一个行业，左边是加权入度（买入），右边是加权出度（卖出），按加权总度排序；左边条长的行业主要是买方，右边条长的主要是卖方。这张图没有可记录的读数条目。</p>}
    {view === "flows" && <div className="controls">
      <LabeledControl label="年份">{(id) => <select id={id} value={year} onChange={(event) => setYear(Number(event.target.value))}>{years.map((value) => <option key={value} value={value}>{value}</option>)}</select>}</LabeledControl>
      {view === "flows" && <LabeledControl label="显示行业">{(id) => <select id={id} value={flowsLimit} onChange={(event) => setFlowsLimit(Number(event.target.value))}><option value={15}>前 15 个</option><option value={200}>全部行业</option></select>}</LabeledControl>}
    </div>}
    {recordable && <div className="controls">
      <LabeledControl label="网络指标">{(id) => <select id={id} name="network-metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
        <optgroup label="常用指标">{COMMON_METRICS.filter((key) => metrics.includes(key)).map((key) => <option key={key} value={key}>{schema?.fields[key]?.label ?? key}</option>)}</optgroup>
        <optgroup label="更多指标">{metrics.filter((key) => !COMMON_METRICS.includes(key)).map((key) => <option key={key} value={key}>{schema?.fields[key]?.label ?? key}</option>)}</optgroup>
      </select>}</LabeledControl>
      {view === "trend" ? <LabeledControl label="行业">{(id) => <select id={id} value={industry} onChange={(event) => setIndustry(event.target.value)}>
        {meta.sectors.map((sector) => <option key={sector} value={sector}>{sectorLabel(sector)}</option>)}
      </select>}</LabeledControl> : <>
        <LabeledControl label="年份">{(id) => <select id={id} value={year} onChange={(event) => setYear(Number(event.target.value))}>{years.map((value) => <option key={value} value={value}>{value}</option>)}</select>}</LabeledControl>
        <LabeledControl label="显示行业">{(id) => <select id={id} value={limit} onChange={(event) => setLimit(Number(event.target.value))}><option value={10}>前 10 个</option><option value={200}>全部行业</option></select>}</LabeledControl>
      </>}
        </div>}
    <ScopeCard
      ref={scopeRef}
      items={recordable ? [
        { label: "所选国家", value: joinCountries(selected) },
        { label: "范围", value: view === "trend" ? sectorLabel(industry) : "所选国家各行业" },
        { label: "年份", value: view === "trend" ? `${years[0]}–${years.at(-1)}` : String(year) },
        { label: "指标", value: label },
      ] : [
        { label: "所选国家", value: view === "global-network" ? "全球经济体" : joinCountries(selected) },
        { label: "年份", value: String(year) },
        { label: "视角", value: lenses.find((lens) => lens.key === view)?.label ?? view },
        { label: "材料", value: "这张图没有可记录的读数条目" },
      ]}
    />
    {recordable && query.status === "success" && activeReference.status !== "success" && <div role="region" aria-label="全球参照加载状态">
      <AsyncStateMessage
        status={activeReference.status}
        error={activeReference.error ? userFacingRequestError(activeReference.error, "全球参照加载失败") : null}
        loadingLabel="正在加载全球参照…"
        onRetry={activeReference.retry}
      />
      <p className="muted">全球中位数{view === "trend" ? "、区间" : ""}和排名暂未显示；当前国家的有效读数仍可查看{canRecord ? "和记录" : ""}。</p>
    </div>}
    {!recordable && view !== "flows" ? renderExtra?.(view, selected, year, setYear) : query.status !== "success" ? <AsyncStateMessage status={query.status} error={query.error} loadingLabel="正在加载历年行业指标…" onRetry={query.retry} /> : view === "flows" ? (
      <Fragment key={chartKey}>
      {selected.length > 1 && <p className="muted">所选国家共用金额刻度，相同条长表示相同的买入或卖出金额。</p>}
      {/* The butterfly needs about 440px for readable bars: two panels share a row only when each gets that. */}
      <div className={`comparison-facets ${selected.length > 2 ? "comparison-facets--stacked" : "comparison-facets--roomy"}`}>
        {selected.map((country, index) => {
          const rows = flowRows[index];
          return (
            <section key={country} className="comparison-facet">
              <h4>{countryLabel(country)} · {year} · 买入与卖出</h4>
              <Butterfly
                title={`${countryLabel(country)} 行业买入与卖出`}
                unit="百万美元"
                scaleMax={flowScaleMax}
                leftLabel="加权入度（买入）"
                rightLabel="加权出度（卖出）"
                rows={rows.map((row) => ({
                  key: String(row.industry),
                  label: sectorLabel(String(row.industry)),
                  left: typeof row["weighted indegree"] === "number" ? (row["weighted indegree"] as number) : null,
                  right: typeof row["weighted outdegree"] === "number" ? (row["weighted outdegree"] as number) : null,
                }))}
                onPick={(next) => { setIndustry(next); setView("trend"); setFocusScope(true); }}
              />
            </section>
          );
        })}
      </div>
      </Fragment>
    ) : <>
      {view === "ranking" ? ranked.length ? <>
        <NetworkRanking rows={ranked} countries={selected} unit={unit} reference={industryReference} onIndustry={(next) => { setIndustry(next); setView("trend"); setFocusScope(true); }} />
        {renderTable && <details className="technical-details" style={{ marginTop: 12 }}>
          <summary>全部指标表（一个国家各行业的多项网络指标，可排序，只供查阅）</summary>
          {renderTable(year, setYear)}
        </details>}
      </> : <p role="status">该年份没有可用的行业排名，请更换指标或国家。</p> : <Fragment key={chartKey}>
      {finite.length ? <IndicatorTrendChart
        rows={(query.data ?? []).filter((row) => row.industry === industry).map((row) => ({ ...row, [metric]: networkValue(row[metric], metric) }))}
        emptyReading={(country, at) => (points.some((point) => point.country === country && point.year === at && point.undefined) ? PATH_UNDEFINED_LABEL : null)}
        reasonFor={(country, at) => (points.some((point) => point.country === country && point.year === at && point.undefined) ? `该行业无连接，${label}无法定义` : null)}
        countries={selected}
        years={years}
        metric={metric}
        label={label}
        unit={unit}
        distribution={distribution}
        mode="context"
        sameIndustry
        industry={industry}
      /> : <p role="status">{undefinedPoints.length ? `所选国家的该行业无连接，${label}无法定义；请更换行业、指标或国家。` : "该行业没有数据，请更换行业、指标或国家。"}</p>}
      {flatValue === 0 && <p className="muted">所选国家历年的 {sectorLabel(industry)} {label}都是 0：这是真实的 0（该行业没有这类买卖或连接），不是缺少数据。</p>}
      <details className="technical-details"><summary>查看趋势图逐年读数</summary>
        <ScrollableRegion className="table-wrap" label="行业趋势逐年读数"><table className="data-table">
          <thead><tr><th>年份</th>{selected.map((country) => <th key={country}>{countryLabel(country)}</th>)}</tr></thead>
          <tbody>{years.map((year) => <tr key={year}><td>{year}</td>{selected.map((country) => {
            const point = points.find((item) => item.year === year && item.country === country);
            return <td key={country}>{point?.undefined ? PATH_UNDEFINED_LABEL : indicatorNumber(point?.value ?? null, unit)}</td>;
          })}</tr>)}</tbody>
        </table></ScrollableRegion>
      </details>
      </Fragment>}
    </>}
    {(view === "trend" || view === "partners" ? years.includes(2020) : year === 2020) && <Year2020Note />}
    {recordable && schema?.fields[metric]?.desc && <p className="muted viz-metric-desc">{label}：{schema.fields[metric].desc}</p>}
    {/* 本步报告材料: the one card, with the one button, under the chart as on every step. */}
    <MaterialCard
      state={observations.length ? "recorded" : !canRecord ? "blocked" : "missing"}
      summary={observations.length
        ? (savedLabel ?? `${joinCountries(savedCountries)} · ${schema?.fields[observations[0].metric ?? ""]?.label ?? (observations[0].metric === "weighted degree" ? "加权总度" : observations[0].metric)} · ${savedYears[0]}${savedYears.length > 1 ? `–${savedYears.at(-1)}` : ""} 年 · ${savedIndustries.length === 1 ? sectorLabel(savedIndustries[0]!) : `${savedIndustries.length} 个行业`}（${observations.length} 条读数）`)
        : !canRecord
          ? (!recordable ? NO_READINGS_NOTE : `当前图表暂不能记录：${blockedReason}`)
          : NOT_RECORDED_HINT}
      how={observations.length
        ? (matchesSaved ? "当前图表就是已记录的材料；换视角、国家或指标不会改动它。" : canRecord ? "已记录的是另一张图；要换成当前图表，点下面的按钮。" : recordable ? `已记录的是另一张图；当前图表暂不能记录：${blockedReason}` : "已记录的是另一张图；当前图表没有可记录的读数。")
        : canRecord ? "每步记一张图：看好了就点下面的按钮；再点另一张即替换。" : undefined}
      locked={locked}
      rechosen={rechosen}
      action={!canRecord ? null
        : matchesSaved ? { label: RECORDED_CHART_LABEL, disabled: true }
        : { label: locked && observations.length ? REPLACE_MATERIAL_ACTION : RECORD_CHART_ACTION, onClick: () => { setRechosen(locked); onRecord(selected, pendingObservations, pendingLabel); } }}
      check={observations.length ? { label: `核对已记录的读数 · ${observations.length} 条`, content: (
        <ScrollableRegion className="table-wrap bounded-data-table" label="已记录报告材料读数"><table className="data-table">
          {/* The same columns as steps 6–8. */}
          <thead><tr><th>国家／行业</th><th>年份</th><th>指标</th><th>单位</th><th>读数</th></tr></thead>
          <tbody>{observations.map((item, index) => <tr key={index}>
            <td>{countryLabel(item.country)} · {sectorLabel(item.industry ?? "")}</td><td>{item.year}</td>
            <td>{schema?.fields[item.metric ?? ""]?.label ?? (item.metric === "weighted degree" ? "加权总度" : item.metric ?? label)}</td>
            <td>{unitText(item.unit ?? unit)}</td><td>{indicatorNumber(item.value, item.unit ?? unit)}</td>
          </tr>)}</tbody>
        </table></ScrollableRegion>) } : null}
      syncing={syncing}
      pending={pending}
      syncError={syncError}
      syncConflict={syncConflict}
      onRetrySync={onRetrySync}
    />
  </section>;
}

import { useEffect, useRef, useState } from "react";
import { MATERIAL_LOCKED_ACTION, MATERIAL_LOCKED_NOTE } from "../../../step-task-card";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import {
  CompositionBar,
  QuadrantScatter,
  RankBarChart,
  countryLabel, joinCountries,
  sectorLabel,
} from "../../../viz";
import { AsyncStateMessage, useAsync } from "../../shared";
import {
  currentReleaseId,
  finiteBy,
  LensNav,
  type Row,
  type VizObservation,
  type VizStepState,
} from "./scaffold";
import {
  COMPARISON_LETTERS,
  countryDistribution,
  defaultEntities,
  finiteValue,
  indicatorMaterial,
  indicatorRows,
  materialComplete,
  materialKey,
  MAX_ENTITIES,
  normalizeSelection,
  selectionEntities,
  type IndicatorSelection,
  type IndicatorTopic,
  type IndicatorView,
} from "./indicator-model";
import {
  DistributionStrip,
  IndicatorPairBars,
  IndicatorTrendChart,
  LengthPositionTrajectory,
  TrendSummary,
  indicatorNumber,
} from "./indicator-charts";
import { ScopeCard } from "./scope-card";
import { AddCountryControl } from "./add-country";
import { comparisonCards, compositionCards, industryCards, positioningCards, ReadingCards, segmentCards } from "./reading-cards";
import { Dumbbell, IndustryDotPlot, StackedAreaFacets } from "./theme-charts";
import { CAT } from "../../../viz/shared";

/** "2020" for a single-year material (composition / same-year), "2016–2020" for a range. */
function savedYearSpan(years: number[]): string {
  const first = Math.min(...years);
  const last = Math.max(...years);
  return first === last ? `${first} 年` : `${first}–${last}`;
}

export function IndicatorExplorer({
  meta,
  step,
  state,
  topic,
}: {
  meta: Meta;
  step: Step;
  state: StepStateApi<VizStepState>;
  topic: IndicatorTopic;
}) {
  const years = [...meta.years].sort((a, b) => a - b);
  const countries = meta.countries.filter((country) => country !== "ROW");
  const release = currentReleaseId(meta);
  const saved = (state.data?.observations ?? []).filter(
    (item) =>
      item.source?.startsWith("explicit-indicator-") &&
      item.release === release,
  );
  const [defaultFirst, ...defaultOthers] = defaultEntities(countries, state.data?.compared);
  const defaults: IndicatorSelection = {
    first: defaultFirst,
    second: defaultOthers[0] ?? "",
    others: defaultOthers,
    industry: "",
    metric: topic.defaultMetric,
    start: years[0],
    end: years.at(-1)!,
    year: years.at(-1)!,
    view: topic.defaultView ?? "trend",
    limit: 10,
  };
  const [selection, setSelection] = useState<IndicatorSelection>(
    saved.length && state.data?.indicator_selection
      ? normalizeSelection(state.data.indicator_selection)
      : defaults,
  );
  const touched = useRef(false);
  const hydrated = useRef(Boolean(state.data));
  useEffect(() => {
    if (hydrated.current || touched.current || !state.data) return;
    if (saved.length && state.data.indicator_selection)
      setSelection(normalizeSelection(state.data.indicator_selection));
    hydrated.current = true;
  }, [state.data, saved.length]);
  const select = (patch: Partial<IndicatorSelection>) => {
    touched.current = true;
    setSelection((old) => normalizeSelection({ ...old, ...patch }));
  };
  /** Replace the comparison list (0–4 countries); `second` follows for saved selections. */
  const selectOthers = (others: string[]) => select({ others, second: others[0] ?? "" });
  // The sticky scope card jumps to the control that changes each part of the scope.
  const entityRef = useRef<HTMLSelectElement>(null);
  const addRef = useRef<HTMLSelectElement>(null);

  const rangeRef = useRef<HTMLSelectElement>(null);
  const metricRef = useRef<HTMLSelectElement>(null);
  const yearRef = useRef<HTMLSelectElement>(null);
  // Picking an industry in 定位行业/行业结构 unmounts the clicked row; focus moves to the scope line instead.
  const scopeRef = useRef<HTMLDivElement>(null);
  const [focusScope, setFocusScope] = useState(false);
  useEffect(() => {
    if (!focusScope) return;
    scopeRef.current?.focus();
    setFocusScope(false);
  }, [focusScope]);
  const pickIndustry = (picked: string) => {
    select({ industry: picked, view: "trend" });
    setFocusScope(true);
  };
  const jump = (ref: { current: HTMLSelectElement | null }) => () => {
    ref.current?.scrollIntoView?.({ block: "center" });
    ref.current?.focus();
  };
  const { first, industry, metric, start, end, year, limit } = selection;
  // Step 7 reads the composition from either side; the 定位图 can switch axes and draw year trails.
  const side = selection.composition_side === "alternate" && topic.composition?.alternate ? "alternate" : "primary";
  const activeComposition = side === "alternate" ? topic.composition!.alternate! : topic.composition;
  const axesChoices = topic.axesOptions ?? [topic.axes];
  const axes = axesChoices.find((option) => option.key === selection.axes) ?? axesChoices[0];
  // Trails need country-level rows, so an industry scope turns them off.
  const trail = Boolean(selection.trail) && !industry;
  const [amountMode, setAmountMode] = useState(false);
  // Step 8 段长度对照: the three segments, forward (PLv) against backward (PLy).
  const LENGTH_SEGMENTS = [
    { key: "domestic", label: "纯国内段", forward: "PLv_D", backward: "PLy_D" },
    { key: "traditional", label: "传统贸易段", forward: "PLv_RT", backward: "PLy_RT" },
    { key: "gvc", label: "GVC 段", forward: "PLv_GVC", backward: "PLy_GVC" },
  ];
  const formatOf = (key: string): "pct" | "amount" | "number" =>
    unit(key) === "%" ? "pct" : unit(key) === "百万美元" ? "amount" : "number";
  const others = selection.others ?? [];
  // “进一步探索” used to replace the main chart; it is now a modal, so an old saved view falls back.
  const view: IndicatorView = selection.view === "explore" ? topic.defaultView ?? "trend" : selection.view;
  const selected = selectionEntities(selection);
  const range = years.filter((value) => value >= start && value <= end);
  const timeView =
    view === "trend" || view === "evolution" || view === "directions";
  const validYears = timeView
    ? years.includes(start) && years.includes(end) && start <= end
    : years.includes(year);
  // The 定位图 trail needs every year; otherwise same-year views load one year.
  const chartYears = timeView ? range : view === "positioning" && trail ? years : [year];
  const industryQuery = view === "industry" || view === "structure" || Boolean(industry);
  const schema = useAsync(() => api.indicatorSchema(), []);
  // Cache resolved rows only, scoped to this mount and release; failed requests remain retryable.
  const cache = useRef(new Map<string, Row[]>());
  // The industry ranking also loads the national values (one request per year) for the dot plot's lines.
  const nationalToo = view === "industry";
  const requestKey = `${release}:${industryQuery}:${nationalToo}:${selected.join(",")}:${chartYears.join(",")}`;
  const query = useAsync(
    async () => {
      const pages = await Promise.all(
        chartYears.flatMap((requestedYear) =>
          (industryQuery ? [...selected, ...(nationalToo ? [""] : [])] : [""]).map(async (country) => {
            const key = `${release}:${country ? "industry" : "country"}:${requestedYear}:${country}`;
            const cached = cache.current.get(key);
            if (cached) return cached;
            const rows = country
              ? (await api.industryIndicatorsAll(requestedYear, country)).rows
              : await api.countryIndicators(requestedYear);
            const dated = rows.map((row) => ({ ...row, year: requestedYear }));
            cache.current.set(key, dated);
            return dated;
          }),
        ),
      );
      return pages.flat();
    },
    [requestKey],
    { requestKey, enabled: Boolean(release && first && validYears && chartYears.length) },
  );
  const rows = indicatorRows(query.data ?? [], topic);
  const field = (key: string) => topic.metrics.find((item) => item.key === key);
  // "总出口（VA+TLS）" + unit → "总出口（VA+TLS；百万美元，对数）", not two bracket pairs.
  const withUnitNote = (text: string, note: string) => text.endsWith("）") ? `${text.slice(0, -1)}；${note}）` : `${text}（${note}）`;
  const label = (key: string) =>
    field(key)?.label ?? schema.data?.fields[key]?.label ?? key;
  const unit = (key: string) => field(key)?.unit ?? "百万美元";
  // Shares derived on the page (e.g. 纯国内份额) have no schema text: describe them by their numerator.
  const description = (key: string) => {
    const own = schema.data?.fields[key]?.desc;
    const { numerator, denominator } = field(key) ?? {};
    const numeratorDesc = numerator && schema.data?.fields[numerator]?.desc;
    if (own || !numerator || !denominator || !numeratorDesc) return own;
    return `${label(numerator)}占${label(denominator)}的比重。${label(numerator)}：${numeratorDesc}`;
  };
  const composition = view === "composition" || view === "evolution";
  const metrics =
    composition && activeComposition
      ? [
          ...activeComposition.segments.map((item) => item.key),
          activeComposition.total,
        ]
      : view === "directions"
        ? ["PLv_GVC", "PLy_GVC"]
        : view === "segments"
          ? LENGTH_SEGMENTS.flatMap((segment) => [segment.forward, segment.backward])
          : view === "positioning"
            ? [axes.x, axes.y]
            : [metric];
  const source: VizObservation["source"] = timeView
    ? "explicit-indicator-trend"
    : composition
      ? "explicit-indicator-composition"
      : "explicit-indicator-comparison";
  const scoped = rows.filter(
    (row) =>
      selected.includes(String(row.country)) &&
      String(row.industry ?? "") === industry,
  );
  const ranked = rows
    .filter(
      (row) =>
        row.country === first && row.year === year && row.industry != null && finiteValue(row[metric]),
    )
    .sort(
      (a, b) =>
        (b[metric] as number) - (a[metric] as number) ||
        String(a.industry).localeCompare(String(b.industry)),
    )
    .slice(0, limit);
  const pending =
    view === "industry"
      ? ranked.flatMap((row) =>
          indicatorMaterial(
            rows,
            selected,
            [year],
            [metric],
            topic,
            String(row.industry),
            source,
            release ?? "",
          ),
        )
      : indicatorMaterial(
          scoped,
          selected,
          chartYears,
          metrics,
          topic,
          industry,
          source,
          release ?? "",
        );
  const expectedCount =
    selected.length *
    chartYears.length *
    metrics.length *
    (view === "industry" ? ranked.length : 1);
  const completeComposition =
    !composition ||
    (pending.length === expectedCount &&
      scoped.every(
        (row) =>
          finiteValue(row[activeComposition!.total]) &&
          (row[activeComposition!.total] as number) > 0,
      ));
  // One economy alone is material only with the global reference, i.e. at country scope (not an industry,
  // not the industry ranking); the report gate applies the same rule.
  const singleAllowed = !industry && view !== "industry";
  const canSave =
    view !== "positioning" &&
    view !== "structure" &&
    query.status === "success" &&
    completeComposition &&
    materialComplete(pending, selected, metrics, timeView, singleAllowed);
  // Economies with fewer readings than the chart needs (none at all, or some years / parts missing), named in
  // the blocked message.
  const perCountry = selected.length ? expectedCount / selected.length : 0;
  const missingCountries = selected.filter((country) => pending.filter((item) => item.country === country).length < perCountry);
  // Name the actual reason the material cannot be saved instead of one catch-all sentence.
  const blockedReason =
    view === "positioning"
      ? "定位图只作探索，不记录材料。"
      : view === "structure"
      ? "行业结构只作探索，不记录材料。"
      : selected.length < 2 && !singleAllowed
      ? "只看一个国家时需用国家整体口径（带全球参照）才记录材料；选择了行业时请加入对比国家。"
      : query.status === "error"
        ? "当前比较的数据加载失败，请重试。"
        : query.status !== "success"
          ? "正在加载当前比较的数据，请稍候。"
          : timeView && chartYears.length < 2
            ? "趋势至少需要两个年份；请把起始年份和结束年份设为不同年份。"
            : !completeComposition
              ? "构成图需要所有分项及正总量齐全；请更换国家、行业或年份。"
              : missingCountries.length
                ? `${joinCountries(missingCountries)}在${timeView ? "所选年份范围" : ` ${year} 年`}${industry ? `（${sectorLabel(industry)}）` : ""}缺少读数（缺失不补零）；请${timeView ? "调整年份范围" : "换一个年份"}或更换比较对象。`
                : `所选国家的读数不能配对（缺失不补零）；请${timeView ? "调整年份范围" : "换一个年份"}或更换比较对象。`;
  const matches =
    canSave &&
    materialKey(saved) === materialKey(pending) &&
    // `others` is an array, so compare by value rather than by reference.
    Object.entries(selection).every(
      ([key, value]) =>
        JSON.stringify(state.data?.indicator_selection?.[key as keyof IndicatorSelection]) === JSON.stringify(value),
    );
  const pendingKey = canSave ? `${materialKey(pending)}|${JSON.stringify({ ...selection, view })}` : "";
  // `chosen`: recorded on the student's request after submission, so the report does not call it automatic.
  const recordCurrent = (chosen = false) => state.save({
    compared: selected,
    observations: pending,
    indicator_selection: { ...selection, view },
    material_chosen: chosen || undefined,
  });
  // Report material follows the chart the student is looking at: every complete chart is recorded
  // automatically, replacing the previous one. Incomplete charts never overwrite a complete record.
  // Once the report is submitted, browsing leaves the material alone unless the student asks.
  useEffect(() => {
    if (!canSave || matches || state.syncing || state.materialLocked) return;
    recordCurrent();
    // state/selection objects change every render; pendingKey captures every meaningful change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, matches, state.syncing]);
  // View bar: the step's theme first (default entry), then the two views every step must offer.
  const themeLens = topic.composition
    ? { key: "composition" as const, label: topic.themeLabel }
    : { key: "directions" as const, label: topic.themeLabel };
  const lenses: { key: IndicatorView; label: string }[] = [
    themeLens,
    { key: "trend", label: "历年变化" },
    { key: "comparison", label: "国家对比" },
    ...(topic.key === "length" ? [{ key: "segments" as const, label: "段长度对照" }] : []),
    { key: "positioning", label: "定位图" },
    // Step 6 reads its industries as a dot plot (行业结构, recorded); steps 7–8 keep the paired ranking
    // (定位行业, recorded) and add an exploration-only 行业结构 view.
    ...(topic.key === "trade" ? [] : [{ key: "structure" as const, label: "行业结构" }]),
    { key: "industry", label: topic.key === "trade" ? "行业结构" : "定位行业" },
  ];
  const themeActive = composition || view === "directions";
  const valuesFor = (key: string, sector = industry) =>
    selected.map((country) => {
      const value = rows.find(
        (row) =>
          row.country === country &&
          row.year === year &&
          String(row.industry ?? "") === sector,
      )?.[key];
      return finiteValue(value) ? value : null;
    });
  // 段长度对照 draws one dumbbell per economy; a shared range keeps their axes comparable.
  const segmentValues = view === "segments"
    ? LENGTH_SEGMENTS.flatMap((segment) => [...valuesFor(segment.forward), ...valuesFor(segment.backward)]).filter((value): value is number => value !== null)
    : [];
  const segmentDomain = segmentValues.length ? [Math.min(...segmentValues), Math.max(...segmentValues)] as const : undefined;
  const table = (observations: VizObservation[]) => (
    <ScrollableRegion
      className="table-wrap bounded-data-table"
      label="图表材料读数"
    >
      <table className="data-table">
        <thead>
          <tr>
            <th>国家／行业</th>
            <th>年份</th>
            <th>指标</th>
            <th>单位</th>
            <th>读数</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((item, i) => (
            <tr key={i}>
              <td>
                {countryLabel(item.country)}
                {item.industry
                  ? ` · ${sectorLabel(item.industry)}`
                  : " · 国家整体"}
              </td>
              <td>{item.year}</td>
              <td>{label(item.metric!)}</td>
              <td>{item.unit}</td>
              <td>{indicatorNumber(item.value, item.unit!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableRegion>
  );
  // Every economy's country-level reading gives the global reference; industry views load only the
  // selected countries, so they have none.
  const referenceFor = (key: string) => (industry || industryQuery ? [] : countryDistribution(rows, key, chartYears));
  const exploreYear = chartYears.includes(year) ? year : chartYears.at(-1) ?? year;
  // ROW is an accounting remainder, not an economy: the modal's median and ranking use the same
  // economies as the page's global reference.
  const exploreRows = rows.filter(
    (row) =>
      row.year === exploreYear &&
      row.country !== "ROW" &&
      (industry ? row.industry === industry : !row.industry),
  );
  // Scatter primitives identify industry rows by industry; these points represent
  // countries within ONE industry, so label them by country instead.
  const reference = finiteBy(exploreRows, axes.x, axes.y).map(
    (row) => ({ ...row, industry: null }),
  );
  // 定位图 trails: each selected economy's country-level path through the loaded years.
  const trails = view === "positioning" && trail
    ? selected.map((country, index) => ({
        id: country,
        label: countryLabel(country),
        color: CAT[index],
        points: chartYears.flatMap((value) => {
          const row = rows.find((item) => item.country === country && item.year === value && !item.industry);
          return row && finiteValue(row[axes.x]) && finiteValue(row[axes.y]) ? [{ year: value, x: row[axes.x] as number, y: row[axes.y] as number }] : [];
        }),
      }))
    : [];
  // 行业结构: one economy's industries at the chosen year (steps 7–8, exploration only).
  const structureRows = (country: string) => rows.filter((row) => row.country === country && row.year === year && row.industry != null);
  // 行业结构 bars sort by the focus part's share when the topic derives it, else by the part itself.
  // 行业结构 always reads the forward composition its text describes; the 前向/后向 switch is only shown in the
  // composition view, so a hidden 后向 choice must not change this view.
  const structureComposition = topic.composition;
  const structureFocus = structureComposition?.focus ?? structureComposition?.segments.at(-1)?.key ?? "";
  const structureSortKey = field(`${structureFocus}_share`) ? `${structureFocus}_share` : structureFocus;
  const nationals = selected.map((country) => {
    const value = rows.find((row) => row.country === country && row.year === year && row.industry == null)?.[metric];
    return finiteValue(value) ? value : null;
  });
  return (
    <section
      className="reg-section-card"
      aria-label={`步骤${step.n}比较工作台`}
    >
      <h3>{topic.question}</h3>
      <div className="controls" role="group" aria-label="比较对象">
        <LabeledControl label="国家 A">
          {(id) => (
            <select
              id={id}
              ref={entityRef}
              value={first}
              onChange={(e) => {
                // Choosing a comparison country as A swaps it with the old A rather than dropping it.
                const next = e.target.value;
                const swapped = others.includes(next) ? others.map((item) => (item === next ? first : item)) : others;
                select({ first: next, others: swapped, second: swapped[0] ?? "" });
              }}
            >
              {countries.map((country) => (
                <option key={country} value={country}>
                  {countryLabel(country)}
                </option>
              ))}
            </select>
          )}
        </LabeledControl>
        {others.map((country, index) => (
          <LabeledControl key={index} label={`对比国家 ${COMPARISON_LETTERS[index]}`}>
            {(id) => (
              <span className="add-country">
                <select
                  id={id}
                  value={country}
                  onChange={(e) => selectOthers(others.map((item, at) => (at === index ? e.target.value : item)))}
                >
                  {countries
                    .filter((candidate) => candidate === country || !selected.includes(candidate))
                    .map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {countryLabel(candidate)}
                      </option>
                    ))}
                </select>
                {/* A separate button: as the select's first option, arrow keys could remove a country unnoticed. */}
                <button
                  type="button"
                  className="secondary"
                  aria-label={`移除对比国家 ${COMPARISON_LETTERS[index]}：${countryLabel(country)}`}
                  onClick={() => {
                    selectOthers(others.filter((_, at) => at !== index));
                    // This control unmounts; keep keyboard focus on the comparison controls.
                    window.requestAnimationFrame(() => (addRef.current ?? entityRef.current)?.focus());
                  }}
                >移除</button>
              </span>
            )}
          </LabeledControl>
        ))}
        {selected.length < MAX_ENTITIES && (
          <AddCountryControl
            ref={addRef}
            label={others.length ? "再加一个对比国家" : "对比国家 B"}
            emptyLabel={others.length ? "选择国家…" : "不选对比国家"}
            candidates={countries.filter((candidate) => !selected.includes(candidate))}
            onAdd={(country) => selectOthers([...others, country])}
            focusAfterAdd={() => (addRef.current ?? entityRef.current)?.focus()}
          />
        )}
      </div>
      <LensNav
        lenses={lenses}
        active={composition ? "composition" : view}
        onPick={(next) => select({ view: next === "composition" && composition ? view : next })}
      />
      {themeActive && <p className="muted lens-hint">{side === "alternate"
        ? "后向口径：同样四类生产活动，从最终品回溯；先看复杂 GVC 占多少、与对比国家差在哪一类（分母见图下说明）。"
        : topic.themeHint}</p>}
      {view === "positioning" && <p className="muted lens-hint">定位图把全部经济体放在两项指标上，所选国家高亮，可叠加 {years[0]}→{years.at(-1)} 的轨迹；只作探索，不记录材料。</p>}
      {view === "segments" && <p className="muted lens-hint">段长度对照：每行一段（纯国内、传统贸易、GVC），前向点与后向点用线相连，一眼看出哪一段、哪个方向更长；多国为分面。三段长度不可相加。</p>}
      {view === "structure" && <p className="muted lens-hint">{topic.key === "production" ? "行业结构：所选国家每个行业的四类生产活动份额，按复杂 GVC 生产份额排序；多国为分面。只作探索，不记录材料。" : "行业结构：所选国家每个行业的前向与后向 GVC 段长度，等长线上方更偏上游；多国为分面。只作探索，不记录材料。"}</p>}
      <div className="controls">
        {view !== "industry" && view !== "structure" && (
          <LabeledControl label="比较范围">
            {(id) => (
              <select
                id={id}
                ref={rangeRef}
                value={industry}
                onChange={(e) => select({ industry: e.target.value })}
              >
                <option value="">国家整体</option>
                {meta.sectors.map((sector) => (
                  <option key={sector} value={sector}>
                    {sectorLabel(sector)}
                  </option>
                ))}
              </select>
            )}
          </LabeledControl>
        )}
        {!composition && view !== "directions" && view !== "structure" && view !== "segments" && view !== "positioning" && (
          <LabeledControl label="指标">
            {(id) => (
              <select
                id={id}
                ref={metricRef}
                value={metric}
                onChange={(e) => select({ metric: e.target.value })}
              >
                {[...new Set(topic.metrics.filter((item) => !item.axisOnly).map((item) => item.unit))].map(
                  (category) => (
                    <optgroup
                      key={category}
                      label={
                        category === "%"
                          ? "份额（跨国比较）"
                          : category === "百万美元"
                            ? "金额（当年价格）"
                            : category
                      }
                    >
                      {topic.metrics
                        .filter((item) => item.unit === category && !item.axisOnly)
                        .map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                          </option>
                        ))}
                    </optgroup>
                  ),
                )}
              </select>
            )}
          </LabeledControl>
        )}
            </div>
      {composition && <div className="controls" role="group" aria-label={`${topic.themeLabel}时间范围`}>
        <button className={view === "composition" ? "primary" : "secondary"} aria-pressed={view === "composition"} onClick={() => select({ view: "composition" })}>单年</button>
        <button className={view === "evolution" ? "primary" : "secondary"} aria-pressed={view === "evolution"} onClick={() => select({ view: "evolution" })}>历年</button>
        {topic.composition?.alternate && <span className="controls-sep" aria-hidden="true">·</span>}
        {topic.composition?.alternate && (
          <span role="group" aria-label="构成口径" style={{ display: "inline-flex", gap: 8 }}>
            <button className={side === "primary" ? "primary" : "secondary"} aria-pressed={side === "primary"} onClick={() => select({ composition_side: "primary" })}>{topic.composition.alternate.primaryLabel}</button>
            <button className={side === "alternate" ? "primary" : "secondary"} aria-pressed={side === "alternate"} onClick={() => select({ composition_side: "alternate" })}>{topic.composition.alternate.label}</button>
          </span>
        )}
        {view === "composition" && <span className="controls-sep" aria-hidden="true">·</span>}
        {view === "composition" && (
          <span role="group" aria-label="条形刻度" style={{ display: "inline-flex", gap: 8 }}>
            <button className={amountMode ? "secondary" : "primary"} aria-pressed={!amountMode} onClick={() => setAmountMode(false)}>占比</button>
            <button className={amountMode ? "primary" : "secondary"} aria-pressed={amountMode} onClick={() => setAmountMode(true)}>金额</button>
          </span>
        )}
      </div>}
      {view === "positioning" && <div className="controls" role="group" aria-label="定位图设置">
        {axesChoices.length > 1 && (
          <LabeledControl label="坐标">
            {(id) => (
              <select id={id} value={axes.key} onChange={(e) => select({ axes: e.target.value })}>
                {axesChoices.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            )}
          </LabeledControl>
        )}
        {!industry && <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={trail} onChange={(e) => select({ trail: e.target.checked })} />
          显示 {years[0]}→{years.at(-1)} 轨迹
        </label>}
      </div>}
      <div className="controls">
        {timeView ? (
          <>
            <LabeledControl label="起始年份">
              {(id) => (
                <select
                  id={id}
                  ref={yearRef}
                  value={start}
                  onChange={(e) =>
                    select({
                      start: +e.target.value,
                      end: Math.max(end, +e.target.value),
                    })
                  }
                >
                  {years.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              )}
            </LabeledControl>
            <LabeledControl label="结束年份">
              {(id) => (
                <select
                  id={id}
                  value={end}
                  onChange={(e) =>
                    select({
                      end: +e.target.value,
                      start: Math.min(start, +e.target.value),
                    })
                  }
                >
                  {years.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              )}
            </LabeledControl>
          </>
        ) : (
          <LabeledControl label="比较年份">
            {(id) => (
              <select
                id={id}
                ref={yearRef}
                value={year}
                onChange={(e) => select({ year: +e.target.value })}
              >
                {years.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            )}
          </LabeledControl>
        )}
        {view === "industry" && (
          <LabeledControl label="显示行业">
            {(id) => (
              <select
                id={id}
                value={limit}
                onChange={(e) => select({ limit: +e.target.value })}
              >
                <option value={10}>Top 10（按国家 A）</option>
                <option value={200}>全部行业</option>
              </select>
            )}
          </LabeledControl>
        )}
      </div>
      <ScopeCard
        ref={scopeRef}
        items={[
          { label: "比较对象", value: joinCountries(selected), onJump: jump(entityRef) },
          {
            label: "范围",
            value: view === "industry" ? "行业排名" : view === "structure" ? "所选国家全部行业" : industry ? sectorLabel(industry) : "国家整体",
            onJump: view === "industry" || view === "structure" ? undefined : jump(rangeRef),
          },
          { label: "年份", value: timeView && start !== end ? `${start}–${end}` : String(timeView ? start : year), onJump: jump(yearRef) },
          {
            label: "指标",
            value: composition ? `${topic.themeLabel}${side === "alternate" ? " · 后向" : ""}` : view === "directions" ? "前后向 GVC 段长度与位置" : view === "positioning" ? `定位图（横轴 ${label(axes.x)} · 纵轴 ${label(axes.y)}）` : view === "structure" ? (topic.key === "production" ? "四类生产活动 · 行业" : "前向 × 后向 GVC 段长度 · 行业") : view === "segments" ? "前后向三段长度" : label(metric),
            onJump: composition || view === "directions" || view === "positioning" || view === "structure" || view === "segments" ? undefined : jump(metricRef),
          },
        ]}
      />
      <div className="viz-chart">
      {!validYears ? <div className="error-box" role="alert">
        <p>保存记录中的年份范围无效，请重新选择年份。原有报告材料未更改。</p>
        <button className="secondary" onClick={() => select({ start: years[0], end: years.at(-1)!, year: years.at(-1)! })}>重置年份</button>
      </div> : query.status !== "success" ? (
        <AsyncStateMessage
          status={query.status}
          error={query.error}
          loadingLabel="正在加载所选年份的指标…"
          onRetry={query.retry}
        />
      ) : (
        <>
          {view === "trend" && (
            <IndicatorTrendChart
              rows={scoped}
              countries={selected}
              years={chartYears}
              metric={metric}
              label={label(metric)}
              unit={unit(metric)}
              distribution={referenceFor(metric)}
              mode="context"
            />
          )}
          {view === "directions" &&
            <>
              <LengthPositionTrajectory
                rows={scoped}
                countries={selected}
                cloud={industry ? [] : rows.filter((row) => row.year === chartYears.at(-1))}
                cloudYear={chartYears.at(-1)}
                years={chartYears}
              />
              {metrics.map((key) => (
                <IndicatorTrendChart
                  key={key}
                  rows={scoped}
                  countries={selected}
                  years={chartYears}
                  metric={key}
                  label={label(key)}
                  unit={unit(key)}
                  distribution={referenceFor(key)}
                  mode="context"
                />
              ))}
            </>}
          {view === "comparison" && !industry && referenceFor(metric)[0] && (
            <>
              <DistributionStrip
                rows={rows}
                metric={metric}
                unit={unit(metric)}
                label={label(metric)}
                year={year}
                highlight={selected}
                distribution={referenceFor(metric)[0]}
              />
              <h4>{label(metric)}排名 · 前 20 与所选国家</h4>
              <RankBarChart
                rows={finiteBy(exploreRows, metric)
                  .sort((a, b) => (b[metric] as number) - (a[metric] as number))
                  .filter((row, index) => index < 20 || selected.includes(String(row.country)))}
                metricKey={metric}
                label={label(metric)}
                format={unit(metric) === "%" ? "pct" : unit(metric) === "百万美元" ? "amount" : "number"}
                highlight={new Set(selected)}
              />
              <ReadingCards label="对比读数" cards={comparisonCards({ rows: scoped, countries: selected, metric, label: label(metric), unit: unit(metric), year, industry, distribution: referenceFor(metric).find((item) => item.year === year) })} />
            </>
          )}
          {view === "positioning" && (
            <>
              <h4>定位图 · {industry ? `${sectorLabel(industry)} · 所选国家` : `${exploreYear} 年全部经济体`}</h4>
              <p className="muted">
                虚线中位数只表示当前展示样本的相对高低，不代表好坏或因果关系。
                {axes.xScale === "log" && "横轴为对数刻度，只画出口为正的经济体。"}
                {axes.equality && "等长线以上前向 GVC 段更长；总长度与 GVC 段不能混用。"}
                {trail && "轨迹从较早年份（空心）指向最近年份（实心），灰点是当年全部经济体。"}
              </p>
              <QuadrantScatter
                rows={reference}
                referenceRows={reference}
                xKey={axes.x}
                yKey={axes.y}
                xLabel={unit(axes.x) === "百万美元" ? withUnitNote(label(axes.x), `百万美元${axes.xScale === "log" ? "，对数" : ""}`) : label(axes.x)}
                yLabel={label(axes.y)}
                xFormat={formatOf(axes.x)}
                yFormat={formatOf(axes.y)}
                xScale={axes.xScale}
                equalityLine={axes.equality}
                quadrantLabels={axes.labels}
                highlight={new Set(selected)}
                highlightColors={Object.fromEntries(selected.map((country, index) => [country, CAT[index]]))}
                trails={trails}
              />
              <ReadingCards label="定位读数" cards={positioningCards({ reference, countries: selected, xKey: axes.x, yKey: axes.y, xLabel: label(axes.x), yLabel: label(axes.y), xFormat: formatOf(axes.x), yFormat: formatOf(axes.y) })} />
            </>
          )}
          {view === "comparison" && industry && <p className="muted">全球分布按国家整体比较；选择了行业时只显示所选国家的同行业读数。</p>}
          {view === "comparison" && (industry || !referenceFor(metric)[0]) && (
            <IndicatorPairBars
              countries={selected}
              unit={unit(metric)}
              groups={[
                {
                  key: metric,
                  label: label(metric),
                  values: valuesFor(metric),
                },
              ]}
            />
          )}
          {view === "comparison" && (industry || !referenceFor(metric)[0]) && (
            <ReadingCards label="对比读数" cards={comparisonCards({ rows: scoped, countries: selected, metric, label: label(metric), unit: unit(metric), year, industry })} />
          )}
          {composition && activeComposition && (
            <>
              <p>
                {activeComposition.note}
                {view === "evolution"
                  ? "每国一面，分项颜色与年份顺序相同，先比较各自变化，再比较国家差异。"
                  : amountMode ? "所选国家使用同一金额刻度，条长与总量成比例；负分项画在零轴左侧。" : "所选国家使用相同分项颜色和共同刻度；金额和份额不能混读。"}
                {view !== "evolution" && `条形右侧的数字是${withUnitNote(label(activeComposition.total), unit(activeComposition.total))}。`}
              </p>
              {view === "evolution" ? (
                <StackedAreaFacets
                  facets={selected.map((country) => ({ key: country, label: countryLabel(country), rows: scoped.filter((row) => row.country === country) }))}
                  years={chartYears}
                  segments={activeComposition.segments}
                  total={activeComposition.total}
                  totalLabel={label(activeComposition.total)}
                />
              ) : (
                <CompositionBar
                  rows={selected.flatMap((country) =>
                    chartYears.flatMap((value) => {
                      const row = scoped.find((item) => item.country === country && item.year === value);
                      return row &&
                        finiteValue(row[activeComposition.total]) &&
                        (row[activeComposition.total] as number) > 0 &&
                        activeComposition.segments.every((segment) => finiteValue(row[segment.key]))
                        ? [{ ...row, country: `${countryLabel(country)} · ${value}`, industry: null }]
                        : [];
                    }),
                  )}
                  segments={activeComposition.segments}
                  normalize={!amountMode}
                  normalizationKey={activeComposition.total}
                  sortKey={activeComposition.total}
                  sortDirection="input"
                  sortLabel={label(activeComposition.total)}
                  sortFormat="amount"
                  valueFormat="amount"
                />
              )}
              {view === "composition"
                ? <ReadingCards label="构成读数" cards={compositionCards({ rows: scoped, countries: selected, composition: activeComposition!, totalLabel: label(activeComposition!.total), year, industry })} />
                : (() => {
                    const focus = activeComposition!.focus ?? activeComposition!.segments.at(-1)!.key;
                    const readings = selected.flatMap((country) => chartYears.map((value) => {
                      const row = scoped.find((item) => item.country === country && item.year === value);
                      const total = row?.[activeComposition!.total];
                      const part = row?.[focus];
                      return { country, year: value, value: finiteValue(total) && total > 0 && finiteValue(part) ? part / total : null };
                    }));
                    return <TrendSummary readings={readings} countries={selected} years={chartYears} unit="%" />;
                  })()}
            </>
          )}
          {view === "segments" && (
            <>
              {selected.length > 1 && <p className="muted">各国使用同一坐标范围，点的位置可以跨国比较。</p>}
              {/* Two dumbbells fit side by side; three or more squeezed each plot to ~45px. */}
              <div className={`comparison-facets${selected.length > 2 ? " comparison-facets--stacked" : ""}`}>
                {selected.map((country) => (
                  <section key={country} className="comparison-facet">
                    <h4>{countryLabel(country)} · {year}{industry ? ` · ${sectorLabel(industry)}` : ""}</h4>
                    <Dumbbell
                      title={`${countryLabel(country)} 段长度对照`}
                      unit="长度单位"
                      leftLabel="前向段长度"
                      rightLabel="后向段长度"
                      domain={segmentDomain}
                      rows={LENGTH_SEGMENTS.map((segment) => ({
                        key: segment.key,
                        label: segment.label,
                        left: valuesFor(segment.forward).at(selected.indexOf(country)) ?? null,
                        right: valuesFor(segment.backward).at(selected.indexOf(country)) ?? null,
                      }))}
                    />
                  </section>
                ))}
              </div>
              <ReadingCards label="段长度读数" cards={segmentCards({ rows: scoped, countries: selected, year, industry, segments: LENGTH_SEGMENTS })} />
            </>
          )}
          {view === "structure" && (
            <>
            {topic.key !== "production" && selected.length > 1 && <p className="muted">每个国家的散点按本国行业取坐标范围：点的位置只在同一国家内比较，跨国比较请看数值。</p>}
            {/* The length scatter is 660 wide: two columns shrank its text to ~7px, so it stacks. */}
            {/* Three or more composition facets leave no room for the value column; they stack too. */}
            <div className={`comparison-facets${topic.key !== "production" || selected.length > 2 ? " comparison-facets--stacked" : ""}`}>
              {selected.map((country) => (
                <section key={country} className="comparison-facet">
                  <h4>{countryLabel(country)} · {year} · 行业结构</h4>
                  {topic.key === "production" && structureComposition ? (
                    <CompositionBar
                      rows={structureRows(country)}
                      segments={structureComposition.segments}
                      normalizationKey={structureComposition.total}
                      sortKey={structureSortKey}
                      sortLabel={label(structureSortKey)}
                      sortFormat={unit(structureSortKey) === "%" ? "pct" : "amount"}
                      valueFormat="amount"
                    />
                  ) : (
                    <QuadrantScatter
                      rows={finiteBy(structureRows(country), topic.axes.x, topic.axes.y)}
                      xKey={topic.axes.x}
                      yKey={topic.axes.y}
                      xLabel={label(topic.axes.x)}
                      yLabel={label(topic.axes.y)}
                      xFormat={formatOf(topic.axes.x)}
                      yFormat={formatOf(topic.axes.y)}
                      equalityLine={topic.axes.equality}
                      quadrantLabels={topic.axes.labels}
                    />
                  )}
                </section>
              ))}
            </div>
            </>
          )}
          {view === "industry" && (
            <>
              <p>
                按国家 A 的{label(metric)}降序排列，同一行业对齐对比国家。点击行业查看历年变化；图中不对各国分别排名。
              </p>
              <ScrollableRegion className="bounded-data-table" label="行业差异">
                {topic.key === "trade" && unit(metric) !== "百万美元" ? (
                  <IndustryDotPlot
                    countries={selected}
                    unit={unit(metric)}
                    label={label(metric)}
                    nationals={nationals}
                    groups={ranked.map((row) => ({
                      key: String(row.industry),
                      label: sectorLabel(String(row.industry)),
                      values: valuesFor(metric, String(row.industry)),
                    }))}
                    onPick={pickIndustry}
                  />
                ) : (
                  <IndicatorPairBars
                    countries={selected}
                    unit={unit(metric)}
                    groups={ranked.map((row) => ({
                      key: String(row.industry),
                      label: sectorLabel(String(row.industry)),
                      values: valuesFor(metric, String(row.industry)),
                    }))}
                    onPick={pickIndustry}
                  />
                )}
              </ScrollableRegion>
              <ReadingCards label="行业读数" cards={industryCards({ groups: ranked.map((row) => ({ key: String(row.industry), label: sectorLabel(String(row.industry)), values: valuesFor(metric, String(row.industry)) })), countries: selected, label: label(metric), unit: unit(metric) })} />
            </>
          )}
          <details className="technical-details">
            <summary>
              核对当前图表读数 · {pending.length} 条（缺失不补零）
            </summary>
            {table(pending)}
          </details>
        </>
      )}
      </div>
      {/* One-line definition of the metric being read; caveats live in the step's task card and the report. */}
      {!composition && view !== "directions" && view !== "segments" && view !== "structure"
        && (view === "positioning" ? [axes.x, axes.y] : [metric]).map((key) => description(key) && (
          <p key={key} className="muted viz-metric-desc">
            {label(key)}：{description(key)}
            {field(key)?.denominator && `分母：${label(field(key)!.denominator!)}；分母不为正时份额不显示。`}
          </p>
        ))}
      <section className="qualified-run-card" aria-label="报告材料">
        <h3>报告材料 · {saved.length ? `已${state.materialLocked ? "" : "自动"}记录（${saved.length} 条读数）` : "尚未记录"}</h3>
        <p role="status">
          {!validYears ? "请先修正年份范围，当前图表才能被记录。" : !canSave
            ? `当前图表暂不能记录：${blockedReason}${saved.length ? "已记录的材料保持不变。" : ""}`
            : state.materialLocked
              ? `${MATERIAL_LOCKED_NOTE}${matches ? "当前图表就是已记录的材料。" : ""}`
              : matches ? "当前图表已自动记录为本步报告材料；换视角、国家或年份后会自动更新为最后查看的完整图表。" : "正在记录当前图表…"}
        </p>
        {state.materialLocked && canSave && !matches && (
          <button type="button" className="secondary" onClick={() => recordCurrent(true)}>{MATERIAL_LOCKED_ACTION}</button>
        )}
        {saved.length > 0 && <details>
          <summary>核对已保存材料 · {saved.length} 条读数</summary>
          <p>
            {joinCountries([...new Set(saved.map((item) => item.country))])} · {savedYearSpan(saved.map((item) => item.year))}
            {" "}· {[...new Set(saved.map((item) => item.industry ?? ""))].map((industry) => industry ? sectorLabel(industry) : "国家整体").join("、")}
          </p>
          {table(saved)}
        </details>}
        {state.syncError ? <p role="alert">材料尚未同步成功。<button className="secondary" onClick={state.syncNow}>重试同步</button></p>
          : state.syncing && <p className="muted">正在同步实验记录…</p>}
      </section>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { MATERIAL_LOCKED_ACTION, MATERIAL_LOCKED_NOTE } from "../../../step-task-card";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import { ChartModalButton, SupplementaryCharts } from "./chart-modal";
import type { Meta, Step, StepStateApi } from "../../../types";
import {
  CompositionBar,
  QuadrantScatter,
  RankBarChart,
  countryLabel,
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
  countryDistribution,
  defaultComparison,
  finiteValue,
  indicatorMaterial,
  indicatorRows,
  materialComplete,
  materialKey,
  type IndicatorSelection,
  type IndicatorTopic,
  type IndicatorView,
} from "./indicator-model";
import {
  DistributionStrip,
  IndicatorPairBars,
  IndicatorTrendChart,
  LengthPositionTrajectory,
  indicatorNumber,
} from "./indicator-charts";

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
  const [defaultFirst, defaultSecond] = defaultComparison(
    countries,
    state.data?.compared,
  );
  const defaults: IndicatorSelection = {
    first: defaultFirst,
    second: defaultSecond,
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
      ? state.data.indicator_selection
      : defaults,
  );
  const touched = useRef(false);
  const hydrated = useRef(Boolean(state.data));
  useEffect(() => {
    if (hydrated.current || touched.current || !state.data) return;
    if (saved.length && state.data.indicator_selection)
      setSelection(state.data.indicator_selection);
    hydrated.current = true;
  }, [state.data, saved.length]);
  const select = (patch: Partial<IndicatorSelection>) => {
    touched.current = true;
    setSelection((old) => ({ ...old, ...patch }));
  };
  const { first, second, industry, metric, start, end, year, limit } =
    selection;
  // “进一步探索” used to replace the main chart; it is now a modal, so an old saved view falls back.
  const view: IndicatorView = selection.view === "explore" ? topic.defaultView ?? "trend" : selection.view;
  const selected = second ? [first, second] : [first];
  const range = years.filter((value) => value >= start && value <= end);
  const timeView =
    view === "trend" || view === "evolution" || view === "directions";
  const validYears = timeView
    ? years.includes(start) && years.includes(end) && start <= end
    : years.includes(year);
  const chartYears = timeView ? range : [year];
  const industryQuery = view === "industry" || Boolean(industry);
  const schema = useAsync(() => api.indicatorSchema(), []);
  // Cache resolved rows only, scoped to this mount and release; failed requests remain retryable.
  const cache = useRef(new Map<string, Row[]>());
  const requestKey = `${release}:${industryQuery}:${selected.join(",")}:${chartYears.join(",")}`;
  const query = useAsync(
    async () => {
      const pages = await Promise.all(
        chartYears.flatMap((requestedYear) =>
          (industryQuery ? selected : [""]).map(async (country) => {
            const key = `${release}:${industryQuery}:${requestedYear}:${country}`;
            const cached = cache.current.get(key);
            if (cached) return cached;
            const rows = industryQuery
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
    composition && topic.composition
      ? [
          ...topic.composition.segments.map((item) => item.key),
          topic.composition.total,
        ]
      : view === "directions"
        ? ["PLv_GVC", "PLy_GVC"]
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
        row.country === first && row.year === year && finiteValue(row[metric]),
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
          finiteValue(row[topic.composition!.total]) &&
          (row[topic.composition!.total] as number) > 0,
      ));
  const canSave =
    query.status === "success" &&
    completeComposition &&
    materialComplete(pending, selected, metrics, timeView);
  // Name the actual reason the material cannot be saved instead of one catch-all sentence.
  const blockedReason =
    selected.length < 2
      ? "报告材料需要一个对比国家；现在只看全球参照，不会记录。"
      : query.status === "error"
        ? "当前比较的数据加载失败，请重试。"
        : query.status !== "success"
          ? "正在加载当前比较的数据，请稍候。"
          : timeView && chartYears.length < 2
            ? "趋势至少需要两个年份；请把起始年份和结束年份设为不同年份。"
            : !completeComposition
              ? "构成图需要所有分项及正总量齐全；请更换国家、行业或年份。"
              : "两国在所选范围内的读数不完整或不能配对（缺失不补零）；请调整年份范围或更换比较对象。";
  const matches =
    canSave &&
    materialKey(saved) === materialKey(pending) &&
    Object.entries(selection).every(
      ([key, value]) =>
        state.data?.indicator_selection?.[key as keyof IndicatorSelection] ===
        value,
    );
  const pendingKey = canSave ? `${materialKey(pending)}|${JSON.stringify({ ...selection, view })}` : "";
  const recordCurrent = () => state.save({
    compared: selected,
    observations: pending,
    indicator_selection: { ...selection, view },
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
  const lenses: { key: IndicatorView; label: string }[] = [
    { key: "trend", label: "历年变化" },
    { key: "comparison", label: "全球分布" },
    ...(topic.composition
      ? [
          { key: "composition" as const, label: "构成分析" },
        ]
      : [{ key: "directions" as const, label: "前后向与位置" }]),
    { key: "industry", label: "定位行业" },
  ];
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
  const reference = finiteBy(exploreRows, topic.axes.x, topic.axes.y).map(
    (row) => ({ ...row, industry: null }),
  );
  return (
    <section
      className="reg-section-card"
      aria-label={`步骤${step.n}比较工作台`}
    >
      <h3>{topic.question}</h3>
      <LensNav
        lenses={lenses}
        active={composition ? "composition" : view}
        onPick={(next) => select({ view: next === "composition" && composition ? view : next })}
      />
      <div className="controls">
        <LabeledControl label="国家 A">
          {(id) => (
            <select
              id={id}
              value={first}
              onChange={(e) =>
                select({
                  first: e.target.value,
                  // Choosing B's country as A swaps the pair rather than dropping the comparison.
                  second: e.target.value === second ? (first !== e.target.value ? first : "") : second,
                })
              }
            >
              {countries.map((country) => (
                <option key={country} value={country}>
                  {countryLabel(country)}
                </option>
              ))}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="对比国家 B">
          {(id) => (
            <select
              id={id}
              value={second}
              onChange={(e) => select({ second: e.target.value })}
            >
              <option value="">暂不选择（报告材料需要对比国家）</option>
              {countries
                .filter((country) => country !== first)
                .map((country) => (
                  <option key={country} value={country}>
                    {countryLabel(country)}
                  </option>
                ))}
            </select>
          )}
        </LabeledControl>
        {view !== "industry" && (
          <LabeledControl label="比较范围">
            {(id) => (
              <select
                id={id}
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
        {!composition && view !== "directions" && (
          <LabeledControl label="指标">
            {(id) => (
              <select
                id={id}
                value={metric}
                onChange={(e) => select({ metric: e.target.value })}
              >
                {[...new Set(topic.metrics.map((item) => item.unit))].map(
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
                        .filter((item) => item.unit === category)
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
      {composition && <div className="controls" role="group" aria-label="构成分析时间范围">
        <button className={view === "composition" ? "primary" : "secondary"} aria-pressed={view === "composition"} onClick={() => select({ view: "composition" })}>单年</button>
        <button className={view === "evolution" ? "primary" : "secondary"} aria-pressed={view === "evolution"} onClick={() => select({ view: "evolution" })}>历年</button>
      </div>}
      <div className="controls">
        {timeView ? (
          <>
            <LabeledControl label="起始年份">
              {(id) => (
                <select
                  id={id}
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
      <p aria-label="当前比较口径"><strong>
        {selected.map(countryLabel).join("与")} · {view === "industry" ? "行业排名" : industry ? sectorLabel(industry) : "国家整体"} · {timeView ? `${start}–${end}` : year} · {composition ? "构成分析" : view === "directions" ? "前后向GVC段长度与位置" : label(metric)}
      </strong></p>
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
              <LengthPositionTrajectory
                rows={scoped}
                countries={selected}
                years={chartYears}
              />
            </>}
          {view === "comparison" && !industry && referenceFor(metric)[0] && (
            <DistributionStrip
              rows={rows}
              metric={metric}
              unit={unit(metric)}
              label={label(metric)}
              year={year}
              highlight={selected}
              distribution={referenceFor(metric)[0]}
            />
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
          {composition && topic.composition && (
            <>
              <p>
                {topic.composition.note}
                {view === "evolution"
                  ? "两国分面使用相同分项颜色和年份顺序，先比较各自变化，再比较国家差异。"
                  : "两国使用相同分项颜色和共同刻度；金额和份额不能混读。"}
                条形右侧的数字是{label(topic.composition.total)}（{unit(topic.composition.total)}）。
              </p>
              <div className={view === "evolution" ? "comparison-facets" : undefined}>
                {(view === "evolution" ? selected.map((country) => [country]) : [selected]).map((facetCountries) => (
                  <section key={facetCountries.join(":")} className={view === "evolution" ? "comparison-facet" : undefined}>
                    {view === "evolution" && <h4>{countryLabel(facetCountries[0])} · 构成演变</h4>}
                    <CompositionBar
                      rows={facetCountries.flatMap((country) =>
                        chartYears.flatMap((value) => {
                          const row = scoped.find(
                            (row) => row.country === country && row.year === value,
                          );
                          return row &&
                            finiteValue(row[topic.composition!.total]) &&
                            (row[topic.composition!.total] as number) > 0 &&
                            topic.composition!.segments.every((segment) =>
                              finiteValue(row[segment.key]),
                            )
                            ? [{
                                ...row,
                                country: view === "evolution"
                                  ? String(value)
                                  : `${countryLabel(country)} · ${value}`,
                                industry: null,
                              }]
                            : [];
                        }),
                      )}
                      segments={topic.composition!.segments}
                      normalizationKey={topic.composition!.total}
                      sortKey={topic.composition!.total}
                      sortDirection="input"
                      sortLabel={label(topic.composition!.total)}
                      sortFormat="amount"
                      valueFormat="amount"
                    />
                  </section>
                ))}
              </div>
            </>
          )}
          {view === "industry" && (
            <>
              <p>
                按国家 A 的{label(metric)}降序排列，同一行业对齐国家
                B。点击行业查看历年变化；条形图不对两国分别排名。
              </p>
              <ScrollableRegion className="bounded-data-table" label="行业差异">
                <IndicatorPairBars
                  countries={selected}
                  unit={unit(metric)}
                  groups={ranked.map((row) => ({
                    key: String(row.industry),
                    label: sectorLabel(String(row.industry)),
                    values: valuesFor(metric, String(row.industry)),
                  }))}
                  onPick={(industry) => select({ industry, view: "trend" })}
                />
              </ScrollableRegion>
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
      {!composition && view !== "directions" && description(metric) && <p className="muted viz-metric-desc">
        {label(metric)}：{description(metric)}
        {field(metric)?.denominator && `分母：${label(field(metric)!.denominator!)}；分母不为正时份额不显示。`}
      </p>}
      <SupplementaryCharts>
        <ChartModalButton
          label={industry ? "两国同行业定位图" : "全部国家定位图与排名"}
          title={`步骤 ${step.n} · ${industry ? `${sectorLabel(industry)} · ` : ""}${exploreYear} 年定位图`}
        >
          {() => (
            <>
              <h4>定位图 · {industry ? "所选两国同一行业" : "当年国家样本"}</h4>
              <p>
                虚线中位数只表示当前展示样本的相对高低，不代表好坏或因果关系。
                {topic.axes.equality &&
                  "等长线以上前向GVC段更长；总长度与GVC段不能混用。"}
              </p>
              <QuadrantScatter
                rows={reference}
                referenceRows={reference}
                xKey={topic.axes.x}
                yKey={topic.axes.y}
                xLabel={label(topic.axes.x)}
                yLabel={label(topic.axes.y)}
                xFormat={topic.key === "length" ? "number" : "pct"}
                yFormat={topic.key === "length" ? "number" : "pct"}
                equalityLine={topic.axes.equality}
                quadrantLabels={topic.axes.labels}
                highlight={new Set(selected)}
              />
              {!industry && (
                <>
                  <h4>{label(metric)}排名 · 前20与所选国家</h4>
                  <RankBarChart
                    rows={finiteBy(exploreRows, metric)
                      .sort(
                        (a, b) => (b[metric] as number) - (a[metric] as number),
                      )
                      .filter(
                        (row, index) =>
                          index < 20 || selected.includes(String(row.country)),
                      )}
                    metricKey={metric}
                    label={label(metric)}
                    format={
                      unit(metric) === "%"
                        ? "pct"
                        : unit(metric) === "百万美元"
                          ? "amount"
                          : "number"
                    }
                    highlight={new Set(selected)}
                  />
                </>
              )}
                        </>
          )}
        </ChartModalButton>
      </SupplementaryCharts>
      <section className="qualified-run-card" aria-label="报告材料">
        <h3>报告材料 · {saved.length ? `已自动记录（${saved.length} 条读数）` : "尚未记录"}</h3>
        <p role="status">
          {!validYears ? "请先修正年份范围，当前图表才能被记录。" : !canSave
            ? `当前图表暂不能记录：${blockedReason}${saved.length ? "已记录的材料保持不变。" : ""}`
            : state.materialLocked
              ? `${MATERIAL_LOCKED_NOTE}${matches ? "当前图表就是已记录的材料。" : ""}`
              : matches ? "当前图表已自动记录为本步报告材料；换视角、国家或年份后会自动更新为最后查看的完整图表。" : "正在记录当前图表…"}
        </p>
        {state.materialLocked && canSave && !matches && (
          <button type="button" className="secondary" onClick={recordCurrent}>{MATERIAL_LOCKED_ACTION}</button>
        )}
        {saved.length > 0 && <details>
          <summary>核对已保存材料 · {saved.length} 条读数</summary>
          <p>
            {[...new Set(saved.map((item) => item.country))].map(countryLabel).join(" 与 ")} · {savedYearSpan(saved.map((item) => item.year))}
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

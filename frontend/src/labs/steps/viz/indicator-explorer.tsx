import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import { focusStepPrimaryAction } from "../../../step-task-card";
import type { Meta, Step, StepStateApi } from "../../../types";
import {
  CompositionBar,
  QuadrantScatter,
  RankBarChart,
  countryLabel,
  sectorLabel,
} from "../../../viz";
import { IcioYearNote } from "./icio-year-note";
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
  const { first, second, industry, metric, start, end, year, view, limit } =
    selection;
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
    view !== "explore" &&
    query.status === "success" &&
    completeComposition &&
    materialComplete(pending, selected, metrics, timeView);
  // Name the actual reason the material cannot be saved instead of one catch-all sentence.
  const blockedReason =
    selected.length < 2
      ? "请选择两个不同国家后再保存。"
      : query.status === "error"
        ? "当前比较的数据加载失败，请重试后再保存。"
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
  const save = () => {
    if (!canSave || matches || state.syncing) return;
    state.save({
      compared: selected,
      observations: pending,
      indicator_selection: selection,
    });
  };
  const lenses: { key: IndicatorView; label: string }[] = [
    { key: "trend", label: "比较变化" },
    { key: "comparison", label: "同年差异" },
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
  const exploreRows = rows.filter(
    (row) =>
      row.year === year &&
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
              <option value="">暂不对比（不能保存报告材料）</option>
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
        {selected.map(countryLabel).join("与")} · {view === "industry" ? "行业排名" : industry ? sectorLabel(industry) : "国家整体"} · {timeView ? `${start}–${end}` : year} · {composition ? "构成分析" : view === "directions" ? "前后向GVC段长度与位置" : view === "explore" ? `${label(topic.axes.x)} / ${label(topic.axes.y)}` : label(metric)}
      </strong></p>
      <p className="muted">{topic.key === "length" ? "长度是生产阶段的账户比值，不是跨境次数；国家结果不能用行业均值代替。" : "金额为当年价格，跨年变化不等于实际增长；国家份额不是行业份额的简单平均。"}</p>
      {chartYears.includes(2020) && <p className="reg-boundary">2020 年含疫情期及统计外推影响，不宜仅凭该年转折判断生产调整。详见下方“指标口径”。</p>}
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
                />
              ))}
              <LengthPositionTrajectory
                rows={scoped}
                countries={selected}
                years={chartYears}
              />
            </>}
          {view === "comparison" && (
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
                {topic.composition.note}{" "}
                {view === "evolution"
                  ? "两国分面使用相同分项颜色和年份顺序，先比较各自变化，再比较国家差异。"
                  : "两国使用相同分项颜色和共同刻度；金额和份额不能混读。"}
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
          {view === "explore" && (
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
          {view !== "explore" && (
            <details className="technical-details">
              <summary>
                核对当前图表读数 · {pending.length} 条（缺失不补零）
              </summary>
              {table(pending)}
            </details>
          )}
        </>
      )}
      </div>
      <details className="technical-details">
        <summary>指标口径</summary>
        <p className="muted">{topic.note}</p>
        {!composition && view !== "directions" && <p className="muted">
          {schema.data?.fields[metric]?.desc}
          {field(metric)?.denominator && ` 分母：${label(field(metric)!.denominator!)}；分母不为正时份额不显示。`}
        </p>}
        <IcioYearNote years={chartYears} />
      </details>
      <section className="qualified-run-card" aria-label="报告材料">
        <h3>报告材料 · {saved.length ? `已保存一份比较（${saved.length} 条读数）` : "尚未保存"}</h3>
        <p>
          当前图表：{composition ? "保存全部构成分项及总量，金额单位：百万美元" : metrics.map((key) => `${label(key)}（${unit(key)}）`).join("、")}
          {" "}· {pending.length} 条有效读数{pending.length < expectedCount ? `，缺少 ${expectedCount - pending.length} 条` : ""}
        </p>
        <button className="primary" disabled={!canSave || matches || state.syncing} onClick={save}>
          {matches ? "当前比较已记录" : saved.length ? "更新报告材料" : "保存为报告材料"}
        </button>
        <p role="status">
          {view === "explore"
            ? "补充图表仅供探索；请回到主要图表保存材料。"
            : !validYears ? "请先修正年份范围，再保存当前比较。" : !canSave
              ? blockedReason
              : matches ? "当前图表与已记录材料一致。" : "保存将替换本步已有材料；浏览和切换图表不会修改已保存内容。"}
        </p>
        {saved.length > 0 && <details>
          <summary>核对已保存材料 · {saved.length} 条读数</summary>
          <p>
            {[...new Set(saved.map((item) => item.country))].map(countryLabel).join(" 与 ")} · {savedYearSpan(saved.map((item) => item.year))}
            {" "}· {[...new Set(saved.map((item) => item.industry ?? ""))].map((industry) => industry ? sectorLabel(industry) : "国家整体").join("、")}
          </p>
          {table(saved)}
        </details>}
        {state.syncError ? <p role="alert">材料尚未同步成功。<button className="secondary" onClick={state.syncNow}>重试同步</button></p>
          : <p className="muted">{state.syncing ? "正在同步实验记录…" : "材料随实验记录同步；还需在页面下方完成本步单选题。"}</p>}
      </section>
      <details className="technical-details" key={view === "explore" ? "explore" : "main"} open={view === "explore"}>
        <summary>补充图表</summary>
        <LensNav lenses={[{ key: "explore", label: "进一步探索" }]} active={view} onPick={(view) => {
          select({ view });
          requestAnimationFrame(() => focusStepPrimaryAction(document.querySelector(".content")));
        }} />
      </details>
    </section>
  );
}

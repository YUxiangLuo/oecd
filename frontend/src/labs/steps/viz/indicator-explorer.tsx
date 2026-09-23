import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import {
  CompositionBar,
  QuadrantScatter,
  RankBarChart,
  countryLabel,
  sectorLabel,
} from "../../../viz";
import { CAT } from "../../../viz/shared";
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
    { requestKey, enabled: Boolean(release && first && chartYears.length) },
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
          { key: "composition" as const, label: "解释构成" },
          { key: "evolution" as const, label: "构成演变" },
        ]
      : [{ key: "directions" as const, label: "前后向与位置" }]),
    { key: "industry", label: "定位行业" },
    { key: "explore", label: "进一步探索" },
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
      <p>
        固定两个国家和同一口径，先比较跨年变化，再解释构成或定位行业差异。
        国家整体和同一行业使用各自的原始指标，不能混为一谈。
      </p>
      <div className="controls">
        <LabeledControl label="国家 A">
          {(id) => (
            <select
              id={id}
              value={first}
              onChange={(e) =>
                select({
                  first: e.target.value,
                  second: e.target.value === second ? "" : second,
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
      <LensNav
        lenses={lenses}
        active={view}
        onPick={(view) => select({ view })}
      />
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
      <p className="muted">{topic.note}</p>
      {!composition && view !== "directions" && (
        <p className="muted">
          {schema.data?.fields[metric]?.desc}
          {field(metric)?.denominator &&
            ` 分母：${label(field(metric)!.denominator!)}；分母不为正时份额不显示。`}
        </p>
      )}
      <section className="qualified-run-card" aria-label="报告材料">
        <h3>报告材料 · {saved.length ? "已保存一份比较" : "尚未保存"}</h3>
        <p>
          <b>本次准备保存：</b>
          {selected.map(countryLabel).join(" 与 ")} ·{" "}
          {view === "industry"
            ? "行业比较"
            : industry
              ? sectorLabel(industry)
              : "国家整体"}{" "}
          · {timeView ? `${start}–${end}` : year} ·{" "}
          {lenses.find((item) => item.key === view)?.label}
        </p>
        <p>
          {composition
            ? "保存全部构成分项及总量，金额单位：百万美元"
            : metrics
                .map((key) => `${label(key)}（${unit(key)}）`)
                .join("、")}{" "}
          · {pending.length} 条有效读数
          {pending.length < expectedCount
            ? `，缺少 ${expectedCount - pending.length} 条`
            : ""}
        </p>
        <button
          className="primary"
          disabled={!canSave || matches || state.syncing}
          onClick={save}
        >
          {matches
            ? "当前比较已记录"
            : saved.length
              ? "更新报告材料"
              : "保存为报告材料"}
        </button>
        <p role="status">
          {view === "explore"
            ? "更多探索用于阅读背景；请回到趋势、同年或行业比较保存材料。"
            : !canSave
              ? "请选择两个不同国家并等待加载。趋势需至少两个共同有效年份，各指标的两国读数须配对；构成图还需所有分项及正总量齐全。缺失年份可调整范围，不补零。"
              : matches
                ? "当前图表与已记录材料一致。"
                : "保存将替换本步已有材料；浏览、切年份和换指标不会自动修改已保存内容。"}
        </p>
        {saved.length > 0 && (
          <>
            <p>
              <b>已有材料：</b>
              {[...new Set(saved.map((item) => item.country))]
                .map(countryLabel)
                .join(" 与 ")}{" "}
              · {Math.min(...saved.map((item) => item.year))}–
              {Math.max(...saved.map((item) => item.year))} ·{" "}
              {[
                ...new Set(
                  saved.map((item) =>
                    item.industry ? sectorLabel(item.industry) : "国家整体",
                  ),
                ),
              ].length === 1
                ? saved[0].industry
                  ? sectorLabel(saved[0].industry)
                  : "国家整体"
                : "多个行业"}{" "}
              · {[...new Set(saved.map((item) => item.metric))].length}{" "}
              项指标／分项
            </p>
            <details>
              <summary>核对已保存材料 · {saved.length} 条读数</summary>
              {table(saved)}
            </details>
          </>
        )}
        {state.syncError ? (
          <p role="alert">
            材料尚未同步成功。
            <button className="secondary" onClick={state.syncNow}>
              重试同步
            </button>
          </p>
        ) : (
          <p className="muted">
            {state.syncing
              ? "正在同步实验记录…"
              : "材料随实验记录同步；还需在页面下方完成本步单选题。"}
          </p>
        )}
      </section>
      <div className="controls" style={{ marginTop: 18 }}>
        {selected.map((country, i) => (
          <span key={country}>
            <b style={{ color: CAT[i] }}>{i ? "┄" : "━"}</b>{" "}
            {countryLabel(country)}
          </span>
        ))}
      </div>
      <IcioYearNote years={chartYears} />
      {query.status !== "success" ? (
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
    </section>
  );
}

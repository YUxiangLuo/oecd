import { Fragment, useEffect, useRef, useState } from "react";
import { NO_READINGS_NOTE, NOT_RECORDED_HINT, RECORD_CHART_ACTION, RECORDED_CHART_LABEL, REPLACE_MATERIAL_ACTION } from "../../../step-task-card";
import { MaterialCard } from "../../../material-card";
import { vizMaterialLabel } from "../../../material-label";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import {
  CompositionBar,
  QuadrantScatter,
  RankBarChart,
  countryLabel, joinCountries,
  medianSkipReason,
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
  DEFAULT_MARK,
  defaultEntities,
  defaultMarkFor,
  finiteValue,
  indicatorMaterial,
  indicatorRows,
  materialComplete,
  materialKey,
  MAX_ENTITIES,
  normalizeSelection,
  pickFirst,
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
  scopeLabel,
  textNumber,
} from "./indicator-charts";
import { ScopeCard } from "./scope-card";
import { AddCountryControl } from "./add-country";
import { comparisonCards, compositionCards, industryCards, positioningCards, ReadingCards, segmentCards } from "./reading-cards";
import { Dumbbell, IndustryDotPlot, StackedAreaFacets } from "./theme-charts";
import { CAT } from "../../../viz/shared";
import { cjkSpace } from "../../../format";
import { MaxCountriesNote } from "./add-country";
import { Year2020Note } from "./scaffold";
import { carriedCountryNote } from "../indicator/indicator-table";

/** A saved browsing selection, if it still names a country of this release as A (unknown comparison countries go). */
export function browsedSelection(raw: unknown, countries: readonly string[]): IndicatorSelection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const selection = raw as IndicatorSelection;
  if (typeof selection.first !== "string" || !countries.includes(selection.first)) return null;
  const others = (Array.isArray(selection.others) ? selection.others : [selection.second])
    .filter((country): country is string => typeof country === "string" && countries.includes(country));
  return normalizeSelection({ ...selection, others, second: others[0] ?? "" });
}

/**
 * Under a recorded single-year composition: the material is the parts' and the total's amounts, and the report
 * draws them as shares, whichever of 占比 / 金额 the page shows.
 */
export const COMPOSITION_MATERIAL_SCALE_NOTE = "记录的是各分项与总量的金额读数，报告中的构成图按占比作图；“占比 / 金额”只切换本页的显示方式，不改变记录的材料。";

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
  // The selection last on screen (saved even when its chart is not recorded) wins over the recorded one, so an
  // exploration-only view keeps its countries and view after leaving the step.
  const restoredSelection = (data: VizStepState | undefined, hasSaved: boolean) => {
    const browse = browsedSelection(data?.browse_selection, countries);
    if (browse) return browse;
    return hasSaved && data?.indicator_selection ? normalizeSelection(data.indicator_selection) : null;
  };
  const [selection, setSelection] = useState<IndicatorSelection>(() => restoredSelection(state.data, saved.length > 0) ?? defaults);
  const touched = useRef(false);
  const hydrated = useRef(Boolean(state.data));
  useEffect(() => {
    if (hydrated.current || touched.current || !state.data) return;
    const restored = restoredSelection(state.data, saved.length > 0);
    if (restored) setSelection(restored);
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data, saved.length]);
  // Picking a comparison country as A swaps the two; a short note says so until the next change.
  const [swapNote, setSwapNote] = useState<string | null>(null);
  // Where an opening set of countries came from ("沿用步骤 n 的国家"), until the student changes them here.
  const [carriedFrom] = useState(() => state.carriedFrom != null
    && selectionEntities(selection).join(",") === (state.data?.compared ?? []).join(",") ? state.carriedFrom : undefined);
  const [countriesChosen, setCountriesChosen] = useState(false);
  const select = (patch: Partial<IndicatorSelection>) => {
    touched.current = true;
    setSwapNote(null);
    if (patch.first !== undefined || patch.others !== undefined) setCountriesChosen(true);
    setSelection((old) => normalizeSelection({ ...old, ...patch }));
  };
  // Save what is on screen as browsing state, independently of the report material (see `saveView`).
  const browseKey = JSON.stringify(selection);
  const browseSaved = useRef(browseKey);
  useEffect(() => {
    if (!touched.current || browseSaved.current === browseKey) return;
    browseSaved.current = browseKey;
    state.saveView?.({ browse_selection: selection });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey]);
  /** Replace the comparison list (0–4 countries); `second` follows for saved selections. */
  const selectOthers = (others: string[]) => select({ others, second: others[0] ?? "" });
  // The sticky scope card jumps to the control that changes each part of the scope.
  const entityRef = useRef<HTMLSelectElement>(null);
  const addRef = useRef<HTMLSelectElement>(null);

  const rangeRef = useRef<HTMLSelectElement>(null);
  const metricRef = useRef<HTMLSelectElement>(null);
  const yearRef = useRef<HTMLSelectElement>(null);
  // Picking an industry in 行业排名/行业结构 unmounts the clicked row; focus moves to the scope line instead.
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
  const carriedNote = countriesChosen ? null : carriedCountryNote(carriedFrom);
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
  // 定位图 with an industry reads that industry in every economy, so its medians are not drawn from two points.
  const sectorWide = view === "positioning" && Boolean(industry);
  const industryQuery = !sectorWide && (view === "industry" || view === "structure" || Boolean(industry));
  const schema = useAsync(() => api.indicatorSchema(), []);
  // Cache resolved rows only, scoped to this mount and release; failed requests remain retryable.
  const cache = useRef(new Map<string, Row[]>());
  // The industry ranking also loads the national values (one request per year) for the dot plot's lines.
  const nationalToo = view === "industry";
  const requestKey = `${release}:${sectorWide ? `sector-${industry}` : industryQuery}:${nationalToo}:${selected.join(",")}:${chartYears.join(",")}`;
  const query = useAsync(
    async () => {
      const pages = await Promise.all(
        sectorWide ? chartYears.map(async (requestedYear) => {
          const key = `${release}:sector:${requestedYear}:${industry}`;
          const cached = cache.current.get(key);
          if (cached) return cached;
          const dated = (await api.industryIndicatorsForIndustry(requestedYear, industry)).rows.map((row) => ({ ...row, year: requestedYear }));
          cache.current.set(key, dated);
          return dated;
        }) : chartYears.flatMap((requestedYear) =>
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
  // "总出口（含产品税减补贴）" + unit → "总出口（含产品税减补贴；百万美元，对数）", not two bracket pairs.
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
  // A share whose denominator is 0 or negative (an industry that does not export at all) is undefined, not
  // missing data: "该行业总出口为 0". So is a length whose segment has no activity (step 8: "该行业没有 GVC 生产
  // （GVC 增加值为 0）"). Null when the value is missing for another reason.
  const undefinedReason = (country: string, key: string, at: number, sector = industry): string | null => {
    const row = rows.find((item) => item.country === country && item.year === at && String(item.industry ?? "") === sector);
    const scope = sector ? "该行业" : "该国";
    const idle = field(key)?.zeroOf?.find((item) => row?.[item.column] === 0);
    if (idle) return `${scope}${idle.reason}`;
    const denominator = field(key)?.denominator;
    if (!denominator) return null;
    const raw = row?.[denominator];
    if (!finiteValue(raw) || raw > 0) return null;
    return `${scope}${label(denominator).replace(/（[^）]*）$/, "")}为${raw === 0 ? " 0" : "负"}`;
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
  // 行业排名 records the industries every selected economy can be read in, as step 9's ranking does. A row where
  // an economy has no reading (zero exports leave a share undefined; or the data is missing) is still drawn, with
  // "无法计算" where it is undefined, but it is not recorded, so one such row never blocks the whole chart.
  const rankValue = (country: string, sector: string) =>
    rows.find((item) => item.country === country && item.year === year && String(item.industry ?? "") === sector)?.[metric];
  const rankComplete = ranked.filter((row) => selected.every((country) => finiteValue(rankValue(country, String(row.industry)))));
  const rankGaps = view === "industry"
    ? ranked.filter((row) => !rankComplete.includes(row)).map((row) => {
        const sector = String(row.industry);
        const empty = selected.filter((country) => !finiteValue(rankValue(country, sector)));
        return { sector, empty: empty.map((country) => ({ country, reason: undefinedReason(country, metric, year, sector) })) };
      })
    : [];
  const rankGapsUndefined = rankGaps.every((gap) => gap.empty.every((item) => item.reason));
  // "O 公共管理与国防：KHM 柬埔寨 与 BRN 文莱该行业总出口为 0，国内增加值出口占比无法计算（不是缺少数据）"; a long list
  // (全部行业) names the first three.
  const rankGapItems = rankGaps.map((gap) => {
    const reasons = [...new Set(gap.empty.map((item) => item.reason))];
    return `${sectorLabel(gap.sector)}：${reasons.map((reason) => {
      const countries = joinCountries(gap.empty.filter((item) => item.reason === reason).map((item) => item.country));
      return reason ? `${countries}${reason}，${label(metric)}无法计算（不是缺少数据）` : `${countries}缺少数据`;
    }).join("；")}`;
  });
  const rankGapText = rankGapItems.slice(0, 3).join("；") + (rankGaps.length > 3 ? `等 ${rankGaps.length} 个行业` : "");
  // The short text names three; the full list stays one click away.
  const rankGapList = rankGaps.length > 3 && (
    <details className="rank-gap-list">
      <summary>查看全部 {rankGaps.length} 个行业</summary>
      <ul>{rankGapItems.map((item) => <li key={item}>{item}</li>)}</ul>
    </details>
  );
  // Industries where country A itself has no reading cannot be placed in A's order, so the ranking leaves them out
  // (LUX: A03, B05_06, B09, C19 and T export nothing). With the whole list on screen, name them and say why, as
  // 行业结构 does; in 前 10 个 they would not have made the list anyway.
  const rankHidden = view === "industry"
    ? rows.filter((row) => row.country === first && row.year === year && row.industry != null && !finiteValue(row[metric]))
        .map((row) => String(row.industry))
    : [];
  const rankHiddenNote = (() => {
    const rankable = rows.filter((row) => row.country === first && row.year === year && row.industry != null && finiteValue(row[metric])).length;
    if (!rankHidden.length || rankable > limit) return null;
    const groups = new Map<string, string[]>();
    for (const sector of rankHidden) {
      const reason = undefinedReason(first, metric, year, sector)?.replace(/^该行业/, "") ?? "";
      groups.set(reason, [...(groups.get(reason) ?? []), sector]);
    }
    const clauses = [...groups].map(([reason, sectors]) => reason
      ? `${sectors.join("、")} ${reason}，${label(metric)}无法计算（不是缺少数据）`
      : `${sectors.join("、")} 缺少数据`);
    return `另有 ${rankHidden.length} 个行业没有画出：国家 A（${countryLabel(first)}）在${rankHidden.length === 1 ? "这个行业" : "这些行业"}没有读数，无法排序。${clauses.join("；")}。`;
  })();
  const pending =
    view === "industry"
      ? rankComplete.flatMap((row) =>
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
    (view === "industry" ? rankComplete.length : 1);
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
  // Missing readings that are really undefined (zero exports, no GVC production): changing the years will not
  // help. Each clause names its own indicator, since step 8 reads the forward and backward lengths together.
  // Each clause names the economies it applies to and their years ("LUX 卢森堡在所选年份该行业没有 GVC 生产…，前向 GVC
  // 段长度无法计算；LUX 卢森堡 与 MLT 马耳他在所选年份该行业没有后向 GVC 生产…"), never the whole list for every clause.
  const undefinedReasons = (() => {
    const groups = new Map<string, { when: string; clause: string; countries: string[] }>();
    for (const key of metrics) {
      for (const country of missingCountries) {
        const byReason = new Map<string, number[]>();
        for (const at of chartYears) {
          if (pending.some((item) => item.country === country && item.year === at && item.metric === key)) continue;
          const reason = undefinedReason(country, key, at);
          if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), at]);
        }
        for (const [reason, at] of byReason) {
          const when = timeView ? (at.length === chartYears.length ? "在所选年份" : ` ${at.join("、")} 年`) : ` ${year} 年`;
          const clause = `${reason}，${label(key)}无法计算`;
          const group = groups.get(`${when}|${clause}`) ?? { when, clause, countries: [] };
          group.countries.push(country);
          groups.set(`${when}|${clause}`, group);
        }
      }
    }
    return [...groups.values()].map((group) => `${joinCountries(group.countries)}${group.when}${group.clause}`);
  })();
  const missingOnlyUndefined = missingCountries.length > 0 && missingCountries.every((country) => chartYears.every((at) =>
    metrics.every((key) => pending.some((item) => item.country === country && item.year === at && item.metric === key) || undefinedReason(country, key, at))));
  // A country with no reading in any loaded year: another year range can only help when some years are not loaded.
  const noneLoaded = missingCountries.every((country) => !pending.some((item) => item.country === country));
  const yearsMayHelp = !noneLoaded || (timeView ? chartYears.length < years.length : years.length > 1);
  const missingFix = [
    ...(yearsMayHelp ? [timeView ? "调整年份范围" : "换一个年份"] : []),
    ...(industry ? ["换一个行业"] : []),
    "换国家",
  ];
  // Composition: a total of 0 or below has no shares (MLT's negative value added in H51 is not missing data).
  const totalIssues = composition && activeComposition
    ? selected.flatMap((country) => chartYears.flatMap((at) => {
        const raw = scoped.find((row) => row.country === country && row.year === at)?.[activeComposition.total];
        return finiteValue(raw) && raw <= 0 ? [{ country, year: at, value: raw }] : [];
      }))
    : [];
  // Name the actual reason the material cannot be saved instead of one catch-all sentence.
  const blockedReason =
    view === "positioning"
      ? NO_READINGS_NOTE
      : view === "structure"
      ? NO_READINGS_NOTE
      : selected.length < 2 && !singleAllowed
      ? "只选一个国家时，要把“比较范围”设为“国家整体”才会记录；看某个行业或“行业排名”时，请再加一个对比国家。"
      : query.status === "error"
        ? "当前比较的数据加载失败，请重试。"
        : query.status !== "success"
          ? "正在加载当前比较的数据，请稍候。"
          : timeView && chartYears.length < 2
            ? "趋势至少需要两个年份；请把起始年份和结束年份设为不同年份。"
            : !completeComposition
              ? totalIssues.length
                ? `${joinCountries([...new Set(totalIssues.map((item) => item.country))])}${industry ? `在 ${sectorLabel(industry)}` : ""}的${label(activeComposition!.total)}${totalIssues.every((item) => item.value === 0) ? "为 0" : totalIssues.every((item) => item.value < 0) ? "为负" : "为 0 或为负"}，构成份额无法计算（不是缺少数据）；请换一个${industry ? "行业或" : ""}国家${timeView ? "，或调整年份范围" : ""}。`
                : "构成图需要每个分项都有数据，且总量大于 0；请换国家、行业或年份。"
              : view === "industry" && !rankComplete.length && rankGaps.length
                ? `${year} 年显示的行业里，没有一个行业所有所选国家都有读数（${rankGapText}）；请换国家${rankGapsUndefined || years.length < 2 ? "" : "或换一个年份"}。`
              : missingCountries.length && missingOnlyUndefined && undefinedReasons.length
                ? `${undefinedReasons.join("；")}（不是缺少数据）；请换一个${industry ? "行业或" : ""}国家。`
              : missingCountries.length
                ? `${joinCountries(missingCountries)}在${timeView ? "所选年份范围" : ` ${year} 年`}${industry ? `（${sectorLabel(industry)}）` : ""}缺少数据（缺少的数据留空，不当作 0）；请${missingFix.join("、").replace(/、([^、]+)$/, "或$1")}。`
                : `所选国家没有同一${timeView ? "组年份" : "年份"}的数据，无法并列比较；请${timeView ? "调整年份范围" : "换一个年份"}或换国家。`;
  const indicatorName = composition ? `${topic.themeLabel}${side === "alternate" ? " · 后向" : ""}` : view === "directions" ? "前后向 GVC 段长度与位置" : view === "positioning" ? `定位图（横轴 ${label(axes.x)} · 纵轴 ${label(axes.y)}）` : view === "structure" ? (topic.key === "production" ? "四类生产活动 · 行业" : "前向与后向 GVC 段长度 · 行业") : view === "segments" ? "前后向三段长度" : label(metric);
  const matches =
    canSave &&
    materialKey(saved) === materialKey(pending) &&
    // `others` is an array, so compare by value rather than by reference.
    Object.entries(selection).every(
      ([key, value]) =>
        JSON.stringify(state.data?.indicator_selection?.[key as keyof IndicatorSelection]) === JSON.stringify(value),
    );
  // Recorded on request after submission: the confirmation then says to update the report on step 15.
  const [rechosen, setRechosen] = useState(false);
  // Recorded on the student's request only (the button under the chart): the report calls it 学生选定.
  const materialLabel = () => vizMaterialLabel({
    view: `${lenses.find((lens) => lens.key === (composition ? "composition" : view))?.label ?? ""}${composition && side === "alternate" ? " · 后向" : ""}`,
    // A composition chart is named by its lens already; its readings are the parts and the total.
    metric: composition ? "各分项与总量" : indicatorName,
    countries: selected,
    industry: industry || undefined,
    years: timeView ? chartYears : [year],
    readings: pending.length,
  });
  const recordCurrent = () => state.save({
    compared: selected,
    observations: pending,
    indicator_selection: { ...selection, view },
    material_chosen: true,
    material_label: materialLabel(),
  });
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
    // The recorded industry view is 行业排名 on every step (step 6 draws it as a dot plot, steps 7–8 as paired
    // bars); steps 7–8 add an exploration-only 行业结构 view.
    ...(topic.key === "trade" ? [] : [{ key: "structure" as const, label: "行业结构" }]),
    { key: "industry", label: "行业排名" },
  ];
  const themeActive = composition || view === "directions";
  const chartKey = [view, industry, metric, axes.key, side, start, end, year, limit, trail, amountMode, selected.join(",")].join("|");
  // Notes for values that cannot be computed (zero exports, no GVC production), shown under the trend,
  // comparison and 前后向位置 charts.
  // Economies sharing the same years and reason share one sentence ("BRN 文莱、KHM 柬埔寨…在所选年份该行业…"), so
  // step 8 with T and five economies does not repeat the same sentence five times.
  // `summarised`: the trend chart's own reading already says country A cannot be read in any year, so the note
  // below leaves A out instead of repeating that sentence right after it.
  const notesFor = (key: string, summarised = false) => {
    const groups = new Map<string, string[]>();
    for (const country of selected) {
      const at = (timeView ? chartYears : [year]).filter((value) => undefinedReason(country, key, value));
      if (!at.length || (summarised && country === selected[0] && at.length === chartYears.length)) continue;
      const when = timeView ? (at.length === chartYears.length ? "在所选年份" : ` ${at.join("、")} 年`) : "";
      const clause = `${when}${undefinedReason(country, key, at[0])}，${label(key)}无法计算`;
      groups.set(clause, [...(groups.get(clause) ?? []), country]);
    }
    return [...groups].map(([clause, countries]) => `${joinCountries(countries)}${clause}`);
  };
  // A trend with no economy computable in any year draws nothing: the chart says why in its place, so the note
  // below is not repeated.
  const allUndefined = (key: string) => timeView && selected.every((country) => chartYears.every((at) => undefinedReason(country, key, at)));
  const emptyStatus = (key: string) => allUndefined(key)
    ? `${notesFor(key).join("；")}（不是缺少数据）；请换一个${industry ? "行业或" : ""}国家。`
    : undefined;
  // 前后向位置 draws the trajectory only (no trend chart says the reason in its place), so its notes are complete.
  const undefinedNotes = (view === "trend" || view === "comparison" ? [metric] : view === "directions" ? metrics : [])
    .filter((key) => view === "directions" || !allUndefined(key))
    .flatMap((key) => notesFor(key, view === "trend"));
  // Trend readouts and cards: an undefined reading says "无法计算" and why, with its year, not "缺失".
  const trendEmpty = (key: string) => (country: string, at: number) => (undefinedReason(country, key, at) ? "无法计算" : null);
  const trendReason = (key: string) => (country: string, at: number) => {
    const reason = undefinedReason(country, key, at);
    return reason ? `${reason}，${label(key)}无法计算（不是缺少数据）` : null;
  };
  const shareReason = (country: string) => {
    const reason = undefinedReason(country, metric, year);
    return reason ? `${reason}，${field(metric)?.denominator ? "无法计算占比" : "无法计算"}（不是缺少数据）` : null;
  };
  // Single-year composition bars leave out a total of 0 or below in the share view (shares are undefined);
  // the amount view still draws it, negative parts left of zero.
  const droppedBars = view === "composition" && !amountMode ? totalIssues : [];
  // The note mentions negative parts only when one is on the chart (step 7's activities are almost never negative).
  // The share views leave out a total of 0 or below, and its negative parts with it (ITA·C19 2020 in 占比).
  const compositionHasNegative = Boolean(activeComposition) && scoped.some((row) =>
    selected.includes(String(row.country)) && chartYears.includes(Number(row.year))
    && ((view === "composition" && amountMode) || (finiteValue(row[activeComposition!.total]) && (row[activeComposition!.total] as number) > 0))
    && activeComposition!.segments.some((segment) => typeof row[segment.key] === "number" && (row[segment.key] as number) < 0));
  // "切换到‘金额’可看各分项" only helps when some part is not 0 (LUX T: every part is 0, the amount view is empty too).
  const droppedHaveParts = droppedBars.some((item) => activeComposition?.segments.some((segment) => {
    const value = scoped.find((row) => row.country === item.country && row.year === item.year)?.[segment.key];
    return finiteValue(value) && value !== 0;
  }));
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
  // The scatter leaves its medians out with too few (distinct) points; the note above it then does not name them.
  const mediansDrawn = medianSkipReason(finiteBy(exploreRows, axes.x, axes.y)
    .filter((row) => axes.xScale !== "log" || (row[axes.x] as number) > 0)
    .map((row) => ({ x: row[axes.x] as number, y: row[axes.y] as number }))) === null;
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
  // 行业结构 bars leave out industries whose shares cannot be drawn (the same rule as CompositionBar): say how many
  // and why, so MLT's H51 (negative value added) or LUX's idle industries do not vanish silently.
  const structureHiddenNote = (country: string): string | null => {
    if (!structureComposition) return null;
    const total = structureComposition.total;
    const hidden = structureRows(country).filter((row) => !(finiteValue(row[structureSortKey]) && finiteValue(row[total])
      && (row[total] as number) > 0 && structureComposition.segments.every((segment) => finiteValue(row[segment.key]))));
    if (!hidden.length) return null;
    const groups = [
      { text: `${label(total)}为负`, rows: hidden.filter((row) => finiteValue(row[total]) && (row[total] as number) < 0) },
      { text: `${label(total)}为 0（没有这类生产活动）`, rows: hidden.filter((row) => row[total] === 0) },
      { text: "缺少数据", rows: hidden.filter((row) => !finiteValue(row[total]) || (row[total] as number) > 0) },
    ].filter((group) => group.rows.length);
    const undefinedOnly = groups.every((group) => group.text !== "缺少数据");
    return `另有 ${hidden.length} 个行业没有画出：${groups.map((group) => `${group.rows.map((row) => String(row.industry)).join("、")} ${group.text}`).join("；")}${undefinedOnly ? "，份额无法计算（不是缺少数据）" : ""}。`;
  };
  // 行业排名 rows: an undefined reading reads "无法计算" (zero exports), not "缺失".
  const rankGroups = ranked.map((row) => {
    const sector = String(row.industry);
    return {
      key: sector,
      label: sectorLabel(sector),
      values: valuesFor(metric, sector),
      reasons: selected.map((country) => (undefinedReason(country, metric, year, sector) ? "无法计算" : null)),
    };
  });
  const nationals = selected.map((country) => {
    const value = rows.find((row) => row.country === country && row.year === year && row.industry == null)?.[metric];
    return finiteValue(value) ? value : null;
  });
  return (
    <section
      className="reg-section-card"
      aria-label={`步骤 ${step.n} 图表比较区`}
    >
      <h3>{topic.question}</h3>
      {carriedNote && <p className="muted indicator-carried-note" role="note">{carriedNote}</p>}
      <div className="controls" role="group" aria-label="所选国家">
        <LabeledControl label="国家 A">
          {(id) => (
            <select
              id={id}
              ref={entityRef}
              value={first}
              onChange={(e) => {
                // Choosing a comparison country as A swaps it with the old A rather than dropping it.
                const picked = pickFirst(first, others, e.target.value);
                select({ first: e.target.value, others: picked.others, second: picked.others[0] ?? "" });
                setSwapNote(picked.note);
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
                        {countryLabel(candidate)}{index === 0 && candidate === defaultMarkFor(countries, first) ? DEFAULT_MARK : ""}
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
            label={others.length ? "再加一个对比国家" : "加一个对比国家（可选）"}
            emptyLabel="选择国家…"
            candidates={countries.filter((candidate) => !selected.includes(candidate))}
            onAdd={(country) => selectOthers([...others, country])}
            focusAfterAdd={() => (addRef.current ?? entityRef.current)?.focus()}
          />
        )}
        {selected.length >= MAX_ENTITIES && <MaxCountriesNote />}
        {swapNote && <span className="muted" role="status">{swapNote}</span>}
      </div>
      <LensNav
        lenses={lenses}
        active={composition ? "composition" : view}
        onPick={(next) => select({ view: next === "composition" && composition ? view : next })}
      />
      {themeActive && <p className="muted lens-hint">{side === "alternate"
        ? "后向：同样分为四类生产活动，从最终品端回溯；先看复杂 GVC 的占比，再比较与对比国家差异最大的类别。"
        : topic.themeHint}</p>}
      {view === "positioning" && <p className="muted lens-hint">定位图：每个点是一个经济体{industry ? `（${sectorLabel(industry)}）` : ""}，横轴、纵轴各是一项指标，所选国家高亮；{industry ? "轨迹只在“国家整体”下提供" : `可勾选显示 ${years[0]}→${years.at(-1)} 的轨迹`}。这张图没有可记录的读数条目。</p>}
      {view === "segments" && <p className="muted lens-hint">段长度对照：每行一段（纯国内、传统贸易、GVC），前向点和后向点用线相连，便于比较哪一段、哪个方向更长；选了多个国家时每国一张。三段长度不能相加。</p>}
      {view === "structure" && <p className="muted lens-hint">{topic.key === "production" ? "行业结构：所选国家每个行业的四类生产活动份额，按复杂 GVC 生产份额排序；选了多个国家时每国一张。这张图没有可记录的读数条目。" : "行业结构：所选国家每个行业的前向与后向 GVC 段长度，等长线（前向 = 后向）上方更偏上游；选了多个国家时每国一张。这张图没有可记录的读数条目。"}</p>}
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
                          ? "份额（%）"
                          : category === "百万美元"
                            ? "金额（百万美元，当年价格）"
                            : category === "长度单位" ? "长度（平均生产阶段数）" : category === "无量纲" ? "位置指数（比值）" : category
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
      {/* Mode switches inside the theme view are segmented controls, not primary buttons: the indigo fill stays
          reserved for the page's one main action (下一步). */}
      {composition && <div className="controls viz-modes">
        <div className="seg" role="group" aria-label={`${topic.themeLabel}时间范围`}>
          <button type="button" className={view === "composition" ? "on" : undefined} aria-pressed={view === "composition"} onClick={() => select({ view: "composition" })}>单年构成</button>
          <button type="button" className={view === "evolution" ? "on" : undefined} aria-pressed={view === "evolution"} onClick={() => select({ view: "evolution" })}>历年构成</button>
        </div>
        {topic.composition?.alternate && (
          <div className="seg" role="group" aria-label="构成方向">
            <button type="button" className={side === "primary" ? "on" : undefined} aria-pressed={side === "primary"} onClick={() => select({ composition_side: "primary" })}>{topic.composition.alternate.primaryLabel}</button>
            <button type="button" className={side === "alternate" ? "on" : undefined} aria-pressed={side === "alternate"} onClick={() => select({ composition_side: "alternate" })}>{topic.composition.alternate.label}</button>
          </div>
        )}
        {view === "composition" && (
          <div className="seg" role="group" aria-label="条形刻度">
            <button type="button" className={amountMode ? undefined : "on"} aria-pressed={!amountMode} onClick={() => setAmountMode(false)}>占比</button>
            <button type="button" className={amountMode ? "on" : undefined} aria-pressed={amountMode} onClick={() => setAmountMode(true)}>金额</button>
          </div>
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
          <LabeledControl label="年份">
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
                <option value={10}>前 10 个（按国家 A 排序）</option>
                <option value={200}>全部行业</option>
              </select>
            )}
          </LabeledControl>
        )}
      </div>
      <ScopeCard
        ref={scopeRef}
        items={[
          { label: "所选国家", value: view === "trend" || view === "directions" ? selected.map((country, index) => (
            <Fragment key={country}>
              {index > 0 && (selected.length === 2 ? " 与 " : "、")}
              <span className="scope-country">
                <svg width="20" height="12" aria-hidden="true">
                  <line x1="0" x2="20" y1="6" y2="6" stroke={CAT[index]} strokeWidth="2" strokeDasharray={index ? "7 4" : undefined} />
                  <circle cx="10" cy="6" r="3" fill={CAT[index]} />
                </svg>
                {countryLabel(country)}
              </span>
            </Fragment>
          )) : joinCountries(selected), onJump: jump(entityRef) },
          {
            label: "范围",
            value: view === "industry" ? "所选国家各行业" : view === "structure" ? "所选国家全部行业" : industry ? sectorLabel(industry) : "国家整体",
            onJump: view === "industry" || view === "structure" ? undefined : jump(rangeRef),
          },
          { label: "年份", value: timeView && start !== end ? `${start}–${end}` : String(timeView ? start : year), onJump: jump(yearRef) },
          {
            label: "指标",
            value: indicatorName,
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
          <Fragment key={chartKey}>
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
              emptyStatus={emptyStatus(metric)}
              emptyReading={trendEmpty(metric)}
              reasonFor={trendReason(metric)}
              industry={industry}
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
                highlightColors={Object.fromEntries(selected.map((country, index) => [country, CAT[index]]))}
              />
              <ReadingCards label="对比读数" cards={comparisonCards({ rows: scoped, countries: selected, metric, label: label(metric), unit: unit(metric), year, industry, distribution: referenceFor(metric).find((item) => item.year === year), reasonFor: shareReason })} />
            </>
          )}
          {view === "positioning" && (
            <>
              <h4>定位图 · {exploreYear} 年全部经济体{industry ? ` · ${sectorLabel(industry)}` : ""}</h4>
              {(mediansDrawn || axes.xScale === "log" || axes.equality || trail) && <p className="muted">
                {mediansDrawn && "灰色虚线是图上各经济体的中位数，只表示相对高低，不代表好坏或因果关系。"}
                {axes.xScale === "log" && "横轴为对数刻度，只画出口为正的经济体。"}
                {axes.equality && "等长线（前向 = 后向）上方：前向 GVC 段更长。注意总长度和 GVC 段长度是两个不同的指标。"}
                {trail && "轨迹从较早年份（空心）指向最近年份（实心），灰点是当年全部经济体。"}
              </p>}
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
              <ReadingCards label="定位读数" cards={positioningCards({ reference, countries: selected, xKey: axes.x, yKey: axes.y, xLabel: label(axes.x), yLabel: label(axes.y), xFormat: formatOf(axes.x), yFormat: formatOf(axes.y), xScale: axes.xScale, industry, reasonFor: (country) => {
                const reasons = [axes.x, axes.y].flatMap((key) => {
                  const reason = undefinedReason(country, key, exploreYear);
                  return reason ? [`${reason}，${label(key)}无法计算`] : [];
                });
                return reasons.length ? reasons.join("；") : null;
              } })} />
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
                  reasons: selected.map((country) => (undefinedReason(country, metric, year) ? "无法计算" : null)),
                },
              ]}
            />
          )}
          {view === "comparison" && (industry || !referenceFor(metric)[0]) && (
            <ReadingCards label="对比读数" cards={comparisonCards({ rows: scoped, countries: selected, metric, label: label(metric), unit: unit(metric), year, industry, reasonFor: shareReason })} />
          )}
          {composition && activeComposition && (
            <>
              <p>
                {view === "evolution" ? activeComposition.evolutionNote ?? activeComposition.note
                  : amountMode ? activeComposition.amountNote ?? activeComposition.note : activeComposition.note}
                {view === "evolution"
                  ? "每个国家一张图，颜色和年份顺序都相同；先看各国自己的变化，再比较国家之间的差别。"
                  : amountMode ? `所选国家使用同一金额刻度，条长与总量成比例${compositionHasNegative ? "；负分项画在零轴左侧" : ""}。`
                  // A note that already says when a part turns red (出口构成's 产品税减补贴) is not repeated.
                  : `所选国家使用相同分项颜色和共同刻度；金额和份额不能混读。${compositionHasNegative && !/为负/.test(activeComposition.note) ? "负分项画成红色，放在 0 的左边。" : ""}`}
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
                        (amountMode || (row[activeComposition.total] as number) > 0) &&
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
              {droppedBars.length > 0 && (
                <p className="muted">
                  {droppedBars.map((item) => `${countryLabel(item.country)} · ${item.year}：${label(activeComposition.total)}为${item.value === 0 ? " 0" : `负（${textNumber(item.value, "百万美元")} 百万美元）`}`).join("；")}，构成份额无法计算，占比图里不画{droppedHaveParts ? "；切换到“金额”可看各分项" : ""}。
                </p>
              )}
              {view === "composition"
                ? <ReadingCards label="构成读数" cards={compositionCards({ rows: scoped, countries: selected, composition: activeComposition!, totalLabel: label(activeComposition!.total), year, industry, amountShown: amountMode })} />
                : (() => {
                    const focus = activeComposition!.focus ?? activeComposition!.segments.at(-1)!.key;
                    const readings = selected.flatMap((country) => chartYears.map((value) => {
                      const row = scoped.find((item) => item.country === country && item.year === value);
                      const total = row?.[activeComposition!.total];
                      const part = row?.[focus];
                      return { country, year: value, value: finiteValue(total) && total > 0 && finiteValue(part) ? part / total : null };
                    }));
                    const focusLabel = activeComposition!.focusLabel ?? activeComposition!.segments.find((segment) => segment.key === focus)?.name;
                    // A total of 0 or below leaves the share undefined in that year, not missing.
                    const totalReason = (country: string, at: number) => {
                      const total = scoped.find((item) => item.country === country && item.year === at)?.[activeComposition!.total];
                      return finiteValue(total) && total <= 0
                        ? `${industry ? "该行业" : "该国"}${label(activeComposition!.total)}${total === 0 ? "为 0" : "为负"}，${focusLabel ?? "构成份额"}无法计算（不是缺少数据）`
                        : null;
                    };
                    return <TrendSummary readings={readings} countries={selected} years={chartYears} unit="%" metricLabel={focusLabel} industry={industry} reasonFor={totalReason} />;
                  })()}
            </>
          )}
          {view === "segments" && (
            <>
              {selected.length > 1 && <p className="muted">各国使用同一坐标范围，点的位置可以跨国比较。</p>}
              {/* Summed over a country's industries, the domestic Leontief terms are the same whether read along rows
                  (forward) or columns (backward), so these two pairs coincide by construction (round 21). */}
              {!industry && <p className="muted">国家整体上，纯国内段与传统贸易段的前向长度和后向长度总是相等，这是恒等关系，不是数据错误：这两段的生产全部在本国内部完成（传统贸易只把最终品出口一次），按增加值来源（前向）和按最终品（后向）汇总的是同一批生产活动。只有 GVC 段涉及外国的生产环节，前后向长度一般不同。</p>}
              {/* Each dumbbell needs about 440px for a readable track: two side by side only when they fit (at 1024
                  two columns squeezed each plot to ~40px), three or more always stacked. */}
              <div className={`comparison-facets ${selected.length > 2 ? "comparison-facets--stacked" : "comparison-facets--roomy"}`}>
                {selected.map((country) => (
                  <section key={country} className="comparison-facet">
                    <h4>{scopeLabel(country, industry)} · {year}</h4>
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
                        leftReason: undefinedReason(country, segment.forward, year) ? "无法计算" : null,
                        rightReason: undefinedReason(country, segment.backward, year) ? "无法计算" : null,
                      }))}
                    />
                  </section>
                ))}
              </div>
              <ReadingCards label="段长度读数" cards={segmentCards({ rows: scoped, countries: selected, year, industry, segments: LENGTH_SEGMENTS, reasonFor: (country, key) => {
                const reason = undefinedReason(country, key, year);
                return reason ? `${reason}，${label(key)}无法计算（不是缺少数据）` : null;
              } })} />
            </>
          )}
          {view === "structure" && (
            <>
            {topic.key !== "production" && selected.length > 1 && <p className="muted">每个国家的散点按本国行业取坐标范围：点的位置只在同一国家内比较，跨国比较请看数值。</p>}
            {topic.key === "production" && <p className="muted">条形右侧的数字是{label(structureSortKey)}（{unit(structureSortKey) === "%" ? "%" : unit(structureSortKey)}），行业按它从高到低排列。</p>}
            {/* The length scatter is 660 wide: two columns shrank its text to ~7px, so it stacks. */}
            {/* Three or more composition facets leave no room for the value column; they stack too. */}
            <div className={`comparison-facets${topic.key !== "production" || selected.length > 2 ? " comparison-facets--stacked" : ""}`}>
              {selected.map((country) => (
                <section key={country} className="comparison-facet">
                  <h4>{countryLabel(country)} · {year} · 行业结构</h4>
                  {topic.key === "production" && structureComposition ? (
                    <>
                    <CompositionBar
                      dataLabel={`${countryLabel(country)} 行业结构`}
                      rows={structureRows(country)}
                      segments={structureComposition.segments}
                      normalizationKey={structureComposition.total}
                      sortKey={structureSortKey}
                      sortLabel={label(structureSortKey)}
                      sortFormat={unit(structureSortKey) === "%" ? "pct" : "amount"}
                      valueFormat="amount"
                    />
                    {structureHiddenNote(country) && <p className="muted">{structureHiddenNote(country)}</p>}
                    </>
                  ) : (
                    <QuadrantScatter
                      dataLabel={`${countryLabel(country)} 行业结构`}
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
                {cjkSpace("行业按国家 A 的", label(metric))}从高到低排列，对比国家的同一行业放在同一行。点击行业名，可看它的历年变化。
              </p>
              <ScrollableRegion className="bounded-data-table industry-ranking-box" label="行业排名">
                {topic.key === "trade" && unit(metric) !== "百万美元" ? (
                  <IndustryDotPlot
                    countries={selected}
                    unit={unit(metric)}
                    label={label(metric)}
                    nationals={nationals}
                    groups={rankGroups}
                    onPick={pickIndustry}
                  />
                ) : (
                  <IndicatorPairBars
                    countries={selected}
                    unit={unit(metric)}
                    groups={rankGroups}
                    onPick={pickIndustry}
                  />
                )}
              </ScrollableRegion>
              {rankHiddenNote && <p className="muted">{rankHiddenNote}</p>}
              {rankGaps.length > 0 && rankComplete.length > 0 && (
                <>
                <p className="muted">{rankGapText}。这些行业照常显示，但不记入报告材料：报告材料只记所有所选国家都有读数的 {rankComplete.length} 个行业。</p>
                {rankGapList}
                </>
              )}
              <ReadingCards label="行业读数" cards={industryCards({ groups: rankGroups, countries: selected, label: label(metric), unit: unit(metric) })} />
            </>
          )}
          {undefinedNotes.length > 0 && <p className="muted">{undefinedNotes.join("；")}（不是缺少数据，图上留空）。</p>}
          </Fragment>
          {/* 定位图 and 行业结构 record nothing and carry their own data tables. */}
          {view !== "positioning" && view !== "structure" && <details className="technical-details">
            <summary>
              {/* Readings that are undefined (zero exports, no GVC production) are not missing data. */}
              {/* The suffix only when some reading is actually blank; a complete chart reads just its count. */}
              核对当前图表读数 · {pending.length} 条{rankGaps.length
                ? `（${rankGapsUndefined ? "有国家无法计算的行业不记入" : "有国家缺少或无法计算读数的行业不记入"}）`
                : pending.length < expectedCount ? `（${missingOnlyUndefined ? "无法计算的读数留空" : "缺失留空"}）` : ""}
            </summary>
            {table(pending)}
          </details>}
          {chartYears.includes(2020) && <Year2020Note />}
        </>
      )}
      </div>
      {/* One-line definition of the metric being read; caveats live in the step's task card and the report. */}
      {!composition && view !== "directions" && view !== "segments" && view !== "structure"
        && (view === "positioning" ? [axes.x, axes.y] : [metric]).map((key) => description(key) && (
          <p key={key} className="muted viz-metric-desc">
            {label(key)}：{description(key)}
            {field(key)?.denominator && `分母：${label(field(key)!.denominator!)}（分母为 0 或负数时不显示份额）。`}
          </p>
        ))}
      {/* 本步报告材料: the one card, with the one button, under the chart as on every step. */}
      <MaterialCard
        state={saved.length ? "recorded" : !validYears || !canSave ? "blocked" : "missing"}
        summary={saved.length
          ? (state.data?.material_label as string | undefined) ?? `${joinCountries([...new Set(saved.map((item) => item.country))])} · ${savedYearSpan(saved.map((item) => item.year))} · ${[...new Set(saved.map((item) => item.industry ?? ""))].map((industry) => industry ? sectorLabel(industry) : "国家整体").join("、")}（${saved.length} 条读数）`
          : !validYears ? "请先修正年份范围，当前图表才能被记录。"
          : !canSave ? `${view === "positioning" || view === "structure" ? "" : "当前图表暂不能记录："}${blockedReason}`
          : NOT_RECORDED_HINT}
        extra={validYears && !canSave && view === "industry" && !rankComplete.length ? rankGapList : view === "composition" && canSave && matches ? <span className="composition-material-scale">{COMPOSITION_MATERIAL_SCALE_NOTE}{amountMode ? "本页现在按金额显示。" : ""}</span> : null}
        how={saved.length
          // Restored years out of range: the saved material stays, and the years (not the chart) are what to fix.
          ? (!validYears ? "请先修正年份范围，当前图表才能被记录。" : matches ? "当前图表就是已记录的材料；换视角、国家或年份不会改动它。" : canSave ? "已记录的是另一张图；要换成当前图表，点下面的按钮。" : view === "positioning" || view === "structure" ? "已记录的是另一张图；当前图表没有可记录的读数。" : `已记录的是另一张图；当前图表暂不能记录：${blockedReason}`)
          : canSave ? "每步记一张图：看好了就点下面的按钮；再点另一张即替换。" : undefined}
        locked={state.materialLocked}
        rechosen={rechosen}
        action={!validYears || !canSave ? null
          : matches ? { label: RECORDED_CHART_LABEL, disabled: true }
          : { label: state.materialLocked && saved.length ? REPLACE_MATERIAL_ACTION : RECORD_CHART_ACTION, onClick: () => { setRechosen(Boolean(state.materialLocked)); recordCurrent(); } }}
        check={saved.length ? { label: `核对已记录的读数 · ${saved.length} 条`, content: table(saved) } : null}
        syncing={state.syncing}
        syncError={state.syncError}
        onRetrySync={state.syncNow}
      />
    </section>
  );
}

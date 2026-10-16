import { useEffect, useMemo, useRef, useState } from "react";
import { sameJsonValue } from "../../session-store";
import { MaterialCard, AUTO_RECORD_HOW } from "../../material-card";
import { recordedShockMaterialLabel, shockMaterialLabel } from "../../material-label";

import { api } from "../../api";
import { ScrollableRegion } from "../../a11y";
import { userFacingRequestError } from "../../user-facing-error";
import type {
  Meta, QuizCompletionState, Step, StepStateApi, TeachingCountriesResponse, TeachingGroupsResponse, TeachingPanelResponse,
} from "../../types";
import { TARIFF_IMPOSER, teachingExample } from "../../teaching-example";
import { GENERATED_DATA_NOTE } from "../../regression-lessons";
import { stripNegativeZero } from "../../format";
import { countryLabel, sectorLabel } from "../../viz";
import { CountryExposureChart, ruleYiUsd, ruleYiUsdRange, taxedRuleText } from "../../viz/regression/country-exposure";
import { useAsync } from "../shared";
import { IndicatorTrendChart } from "./viz/indicator-charts";

export interface ShockStepState extends QuizCompletionState, Record<string, unknown> {
  compared?: string[];
  teaching_industry?: string;
  teaching_country?: string;
  teaching_year?: number;
  viewed_teaching_panel?: boolean;
  teaching_panel_version?: string;
  /** True once the student picked the example here (see TeachingExampleSelection). */
  teaching_example_chosen?: boolean;
  /** The countries and industry last on screen, saved with `saveView` whether or not they were recorded (after
   *  the report is submitted the example changes only on request), so leaving the step keeps them. */
  browse_selection?: { first: string; second: string; industry: string };
  teaching_observation?: {
    country: string;
    industry: string;
    year: number;
    teaching_export_share_w: number;
    teaching_tariff_rate_tau: number;
    teaching_tariff_exposure: number;
    version: string;
  };
}

/** Tariff waves by number (teaching data v10: the first from 2018, the second from 2019). */
const WAVE_NAMES: Record<number, string> = { 1: "第一批", 2: "第二批" };

/**
 * What the two-country gap in step 10 means. X = w × τ is 0 before the tariff for everyone, so after it:
 * one taxed and one untaxed → the gap is the taxed country's X; both taxed → the gap comes from their
 * different export dependence w under the same tariff; both untaxed → there is no gap.
 */
export function stepTenGapNote(taxed: boolean[], exposed: boolean[] = taxed, imposer: boolean[] = [], starts: (number | null | undefined)[] = []): string | undefined {
  if (taxed.length !== 2) return undefined;
  // The imposing country's X is 0 only by definition and it is not in the regression sample: no tariff gap to read.
  if (imposer.some(Boolean)) return "美国的 X 记为 0 只是定义（它是加征关税的一方，不在回归样本中），这不是回归要比较的被加税与未被加税国家之差";
  // A taxed country with no exports to the US (w = 0) has X = 0 like an untaxed one.
  if (exposed[0] !== exposed[1]) {
    return taxed[exposed.indexOf(false)]
      ? "两国差距的大小等于美国加税后有暴露那一国的 X：另一国虽被加税，但不向美国出口（w = 0），X 始终为 0"
      : "两国差距的大小等于美国加税后被加税国家的 X：未被加税国家始终为 0";
  }
  if (!exposed[0]) {
    return taxed.some(Boolean)
      ? "两国的 X 都为 0：被加税的国家该行业不向美国出口（w = 0），没有差距"
      : "两国都未被加税：X 一直为 0，没有差距";
  }
  // Taxed in different waves: until the later one starts, the gap is the earlier one's X; only afterwards does it
  // come from w (CHN 2018 against COL 2019: the 2018 gap, then a narrower one of the other sign).
  const [early, late] = [Math.min(starts[0] ?? Infinity, starts[1] ?? Infinity), Math.max(starts[0] ?? -Infinity, starts[1] ?? -Infinity)];
  if (Number.isFinite(early) && Number.isFinite(late) && early !== late) {
    return `两国加税年份不同（${early} 年、${late} 年起）：${late} 年以前的差距来自加税早晚，之后来自对美出口份额 w 的不同；缺少未被加税的对照`;
  }
  return "两国都被加税（税率相同）：差距来自对美出口份额 w 的不同；缺少未被加税的对照";
}

/**
 * The example row worked through on step 10 and saved for steps 11–14, in the last year: an exposed country
 * first (taxed and X > 0), then a taxed one (w = 0), then the first chosen.
 */
export function representativeRow<T extends { country: string; year: number; teaching_tariff_rate_tau: number; teaching_tariff_exposure: number }>(
  rows: readonly T[],
  countries: readonly string[],
  year: number | undefined,
): T | undefined {
  const last = countries.flatMap((country) => rows.filter((row) => row.country === country && row.year === year));
  return last.find((row) => row.teaching_tariff_rate_tau > 0 && row.teaching_tariff_exposure > 0)
    ?? last.find((row) => row.teaching_tariff_rate_tau > 0)
    ?? last[0];
}

/**
 * Whether the saved example was picked by the student. An older save carries no flag: one that differs from the
 * default example was picked; the default one may only have been saved because the page was shown.
 */
export function exampleWasChosen(
  saved: Pick<ShockStepState, "compared" | "teaching_industry" | "teaching_example_chosen"> | undefined,
  defaults: { first: string; second: string; industry: string },
): boolean {
  if (typeof saved?.teaching_example_chosen === "boolean") return saved.teaching_example_chosen;
  if (!saved?.teaching_industry) return false;
  return !sameJsonValue([saved.compared ?? [], saved.teaching_industry], [[defaults.first, defaults.second].filter(Boolean), defaults.industry]);
}

/** Decimals `percentagePoints` (format.ts) prints a share with: two, or two significant digits for a tiny positive one. */
function shownDecimals(share: number): number {
  const points = share * 100;
  return points > 0 && points < 0.005 ? Math.min(10, Math.ceil(-Math.log10(points)) + 1) : 2;
}

/** A shown decimal ("0.10", "25") as an integer and its number of decimals. */
function scaledDecimal(text: string): [bigint, number] {
  const [whole, fraction = ""] = text.split(".");
  return [BigInt(whole + fraction), fraction.length];
}

/** Whether the shown w (in %) times the shown τ (in %), rounded half up to the shown X's decimals, is the shown X. */
function productChecks(wText: string, tauText: string, xText: string): boolean {
  const [w, wScale] = scaledDecimal(wText);
  const [tau, tauScale] = scaledDecimal(tauText);
  const [x, xScale] = scaledDecimal(xText);
  // w% × τ% in percentage points is w × τ / 100.
  const product = w * tau;
  const scale = wScale + tauScale + 2;
  if (scale <= xScale) return product * 10n ** BigInt(xScale - scale) === x;
  const unit = 10n ** BigInt(scale - xScale);
  const rounded = product / unit + (2n * (product % unit) >= unit ? 1n : 0n);
  return rounded === x;
}

/**
 * w (a share, shown in %) and X (a share, shown in percentage points) for "X = w × τ = X" on step 10, with just enough
 * decimals that the shown w times the shown τ gives the shown X by hand: 0.0985% × 25% reads "0.10% × 25% = 0.025",
 * never "0.10% × 25% = 0.02" (0.10 × 0.25 = 0.025). Normal values keep two decimals; an exact zero X reads "0".
 */
export function workedNumbers(w: number, tau: number, x: number): { w: string; x: string; xDecimals: number } {
  const wBase = shownDecimals(w);
  const xBase = shownDecimals(x);
  const wAt = (decimals: number) => stripNegativeZero((w * 100).toFixed(decimals));
  // An exact zero reads "0" for w as for X ("0% × 0% = 0"), not "0.00%" beside a tiny "0.006%".
  if (x === 0) return { w: w === 0 ? "0" : wAt(wBase), x: "0", xDecimals: 2 };
  const tauText = String(Number((tau * 100).toFixed(2)));
  // The fewest extra decimals in all that check by hand, X's first on a tie: "0.0985% × 25% = 0.025" (one more for
  // X), "0.898% × 25% = 0.22" and IDN B07_08's "0.006% × 25% = 0.0015" (one more for w), never eight decimals of w.
  for (let extra = 0; extra <= 12; extra += 1) {
    for (let wExtra = 0; wExtra <= extra; wExtra += 1) {
      const xDecimals = xBase + extra - wExtra;
      const shown = { w: wAt(wBase + wExtra), x: (x * 100).toFixed(xDecimals), xDecimals };
      if (productChecks(shown.w, tauText, shown.x)) return shown;
    }
  }
  return { w: wAt(wBase), x: (x * 100).toFixed(xBase), xDecimals: xBase };
}

/** A number a teaching-panel row may carry (an older release sends no L1.X or exchange-rate change). */
function numberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A saved step 10 browsing selection, if its countries and industry still exist. */
export function browsedExample(raw: unknown, countries: readonly string[], sectors: readonly string[]) {
  if (typeof raw !== "object" || raw === null) return null;
  const { first, second, industry } = raw as Record<string, unknown>;
  if (typeof first !== "string" || !countries.includes(first) || typeof industry !== "string" || !sectors.includes(industry)) return null;
  return { first, second: typeof second === "string" && second !== first && countries.includes(second) ? second : "", industry };
}

export function ShockLab({ meta, step: _step, state }: {
  meta: Meta;
  step: Step;
  state: StepStateApi<ShockStepState>;
}) {
  const defaults = teachingExample(meta);
  // A saved example always leads; a fresh one is the default CAN vs CRI in C29 (not the industry last seen on step 9,
  // which would contradict the autos reason in the lead text).
  const savedChosen = exampleWasChosen(state.data, defaults);
  const example = teachingExample(meta, state.data);
  const countries = example.countries;
  const browsed = browsedExample(state.data?.browse_selection, countries, meta.sectors);
  const opening = browsed ?? example;
  const [first, setFirst] = useState(opening.first);
  const [second, setSecond] = useState(opening.second);
  const [industry, setIndustry] = useState(opening.industry);
  const [chosen, setChosen] = useState(savedChosen || (browsed != null
    && !sameJsonValue([browsed.first, browsed.second, browsed.industry], [example.first, example.second, example.industry])));
  const touched = useRef(false);
  const choose = () => { touched.current = true; setChosen(true); };
  // Save the selection on screen as browsing state (not report material), as steps 6–9 do.
  useEffect(() => {
    if (!touched.current) return;
    state.saveView?.({ browse_selection: { first, second, industry } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, second, industry]);
  const groups = useAsync<TeachingGroupsResponse>(() => api.teachingGroups(), ["teaching-groups"]);
  const sample = groups.status === "success" ? groups.data?.sample : undefined;
  // The whole sample comes first: every country's X in the last year, before any example.
  const overviewQuery = useAsync<TeachingCountriesResponse>(() => api.teachingCountries(), ["teaching-countries"]);
  const overview = overviewQuery.status === "success" ? overviewQuery.data ?? undefined : undefined;
  const selectedCountries = [first, second].filter(Boolean);
  const years = [...meta.years].sort((a, b) => a - b);
  const requestKey = `teaching-series:${selectedCountries.join(",")}:${industry}`;
  const query = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(selectedCountries, industry),
    [requestKey],
    { requestKey, enabled: selectedCountries.length >= 1 && Boolean(industry) },
  );
  const panel = query.status === "success" ? query.data : null;
  // Units whose first-year data fail the sample rules are not in the teaching panel; an example must
  // have both countries in the representative (last) year, otherwise the saved example is kept rather
  // than replaced by a record without an observation.
  const lastYear = years.at(-1);
  const missing = panel
    ? selectedCountries.filter((country) => !panel.rows.some((row) => row.country === country && row.year === lastYear))
    : [];
  const complete = Boolean(panel) && selectedCountries.length >= 1 && missing.length === 0;
  const sampleIndustries = groups.status === "success" ? groups.data?.industries : undefined;
  const industryOptions = meta.sectors.filter((code) => !sampleIndustries || sampleIndustries.includes(code) || code === industry);

  const savedExample = state.data?.teaching_observation && state.data.teaching_observation.version === panel?.version
    ? sameJsonValue([state.data.compared, state.data.teaching_industry], [selectedCountries, industry])
    : false;
  // The saved flag follows the student's first real choice, even when the selection ends where it started.
  const savedFlagCurrent = (state.data?.teaching_example_chosen ?? false) === chosen;
  const recordExample = () => {
    if (!panel) return;
    // The same row the page works through below (the taxed country first), so the saved example and the
    // worked example never differ.
    const representative = representativeRow(panel.rows, selectedCountries, years.at(-1)) ?? panel.rows[0];
    state.save({
      compared: selectedCountries,
      teaching_industry: industry,
      teaching_country: representative?.country ?? first,
      teaching_year: representative?.year ?? lastYear,
      viewed_teaching_panel: true,
      teaching_panel_version: panel.version,
      teaching_example_chosen: chosen,
      material_label: shockMaterialLabel({
        first, second: second || undefined, industry,
        firstTaxed: overview?.countries.find((row) => row.country === first)?.taxed,
        secondTaxed: overview?.countries.find((row) => row.country === second)?.taxed,
        serviceExempt: Boolean(overview?.taxed_rule?.scope) && !/^[ABC]/.test(industry),
      }),
      teaching_observation: representative
        ? {
          country: representative.country,
          industry: representative.industry,
          year: representative.year,
          teaching_export_share_w: representative.teaching_export_share_w,
          teaching_tariff_rate_tau: representative.teaching_tariff_rate_tau,
          teaching_tariff_exposure: representative.teaching_tariff_exposure,
          version: panel.version,
        }
        : undefined,
    });
  };
  // The example follows the selection; once the report is submitted it changes only on request.
  useEffect(() => {
    if (!panel || !complete || (savedExample && savedFlagCurrent) || state.materialLocked) return;
    recordExample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, complete, savedExample, savedFlagCurrent, first, second, industry]);
  const recordStripRef = useRef<HTMLElement | null>(null);
  // The recorded example's X (the row steps 11–14 convert with): 0 or tiny makes every conversion 0 or nearly so.
  const recordedX = state.data?.teaching_observation?.teaching_tariff_exposure ?? null;
  // The recorded example as saved (not the current selects): "CAN 加拿大 · C29 汽车（对比 CRI 哥斯达黎加）".
  const savedCompared = state.data?.teaching_observation ? state.data.compared ?? [] : [];
  const recordedExample = savedCompared.length && state.data?.teaching_industry
    ? `${countryLabel(savedCompared[0])} · ${sectorLabel(state.data.teaching_industry)}${savedCompared[1] ? `（对比 ${countryLabel(savedCompared[1])}）` : ""}`
    : null;
  // Worded as steps 6–9 word their recorded chart.
  // Recorded on request after submission: the confirmation then says to update the report on step 15.
  const [rechosen, setRechosen] = useState(false);

  // While the current selection cannot be used (not in the sample), the recorded example stays on screen: its
  // worked X and trend, rather than the CAN all-industry average.
  const savedIndustry = state.data?.teaching_observation ? state.data.teaching_industry ?? "" : "";
  const showRecorded = Boolean(panel) && !complete && savedCompared.length > 0 && Boolean(savedIndustry)
    && !sameJsonValue([savedCompared, savedIndustry], [selectedCountries, industry]);
  const recordedKey = `teaching-series:${savedCompared.join(",")}:${savedIndustry}`;
  const recordedQuery = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(savedCompared, savedIndustry),
    [recordedKey],
    { requestKey: recordedKey, enabled: showRecorded },
  );
  const recordedPanel = showRecorded && recordedQuery.status === "success" ? recordedQuery.data : null;
  const recordedUsable = Boolean(recordedPanel) && savedCompared.every((country) => recordedPanel!.rows.some((row) => row.country === country && row.year === lastYear));
  // What the worked card and the trend read: the current example, else the recorded one.
  const shownExample = panel && complete
    ? { panel, countries: selectedCountries, industry, first, recorded: false }
    : recordedPanel && recordedUsable
      ? { panel: recordedPanel, countries: savedCompared, industry: savedIndustry, first: savedCompared[0], recorded: true }
      : null;
  const shownCountries = shownExample?.countries ?? selectedCountries;
  const shownIndustry = shownExample?.industry ?? industry;
  const shownPanel = shownExample?.panel;
  const rows = useMemo(() => shownPanel?.rows ?? [], [shownPanel]);
  // The chart reads X in percentage points like the rest of steps 10–14 (the rows store it as a share).
  const chartRows = useMemo(() => rows.map((row) => ({ ...row, teaching_tariff_exposure: row.teaching_tariff_exposure * 100 })), [rows]);

  // The worked example uses the student's own rows: the taxed country in the latest year if there is one.
  const lastRows = shownCountries
    .map((country) => rows.find((row) => row.country === country && row.year === years.at(-1)))
    .filter((row): row is NonNullable<typeof row> => row != null);
  // The tariff rate as set; shares and X in percentage points come from workedNumbers (two decimals, more only where
  // needed, and an exact zero X reads "0", not "0.00").
  const rate = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  // "X = w × τ" with w and X at the digits that check by hand (see workedNumbers).
  const worked = (row: { teaching_export_share_w: number; teaching_tariff_rate_tau: number; teaching_tariff_exposure: number }) =>
    workedNumbers(row.teaching_export_share_w, row.teaching_tariff_rate_tau, row.teaching_tariff_exposure);
  const sharedW = (row: { country: string; industry: string } & Parameters<typeof worked>[0]) => {
    const last = rows.find((other) => other.country === row.country && other.industry === row.industry && other.year === years.at(-1));
    return worked(last ?? row).w;
  };
  // The chart cards read X at the same digits as the summary above them: two decimals, more for a tiny X
  // ("0.00083" rather than "不到 0.01") or where two would not check by hand ("0.025", not "0.02").
  const chartDigits = Math.max(2, ...lastRows.filter((row) => row.teaching_tariff_exposure > 0).map((row) => worked(row).xDecimals));
  // Each country's own card reads its X as its line above does ("23.25", not "23.250" because B needs three).
  const countryDigits = Object.fromEntries(lastRows.map((row) => [row.country, row.teaching_tariff_exposure > 0 ? worked(row).xDecimals : 2]));
  const isImposer = (country: string) => country === TARIFF_IMPOSER;
  const imposerMissing = missing.filter(isImposer);
  const otherMissing = missing.filter((country) => !isImposer(country));
  const names = (codes: readonly string[]) => codes.map(countryLabel).join("、");
  const imposers = selectedCountries.filter(isImposer);
  // The data rule that picks the taxed countries (teaching data v7 on); an older server sends none.
  const ruleClause = taxedRuleText(overview?.taxed_rule, "达到或超过 ");
  const ruleMin = overview?.taxed_rule?.min_million_usd;
  const sampleRows = sample?.rows ?? (overview ? overview.entities * years.length : undefined);
  const policyYear = groups.status === "success" ? groups.data?.policy_year : overview?.policy_year;
  // Teaching data v8 taxes goods only (ICIO A–C); an older server sends no scope and taxed every industry.
  const goodsOnly = Boolean(overview?.taxed_rule?.scope);
  const isService = (code: string) => goodsOnly && !/^[ABC]/.test(code);
  // Whether a country is on the taxed list: τ is 0 for its services, so a row's τ cannot say it.
  const countryTaxed = (code: string) => overview?.countries.find((row) => row.country === code)?.taxed ?? false;
  // Teaching data v10 taxes in two waves: a country's own start year ("第一批，2018 年起"); one wave before v10.
  const waves = overview?.waves?.filter((wave) => wave.countries > 0) ?? [];
  const startYearOf = (code: string) => overview?.countries.find((row) => row.country === code)?.start_year ?? policyYear ?? undefined;
  const waveText = (code: string) => {
    const row = overview?.countries.find((item) => item.country === code);
    return waves.length > 1 && row?.wave && row.start_year ? `（${WAVE_NAMES[row.wave] ?? `第 ${row.wave} 批`}，${row.start_year} 年起）` : "";
  };
  // The example chart marks when its own tariff starts: the earliest start among the taxed rows shown; with none (a
  // service industry), the shown countries' own start (COL's 2019, not the first wave's 2018); else the first tariff.
  const exampleStart = (() => {
    const taxedStarts = lastRows
      .filter((row) => row.teaching_tariff_rate_tau > 0)
      .map((row) => startYearOf(row.country))
      .filter((year): year is number => year != null);
    const countryStarts = lastRows
      .map((row) => overview?.countries.find((item) => item.country === row.country)?.start_year)
      .filter((year): year is number => year != null);
    const starts = taxedStarts.length ? taxedStarts : countryStarts;
    // Neither shown country is taxed (AUS vs CRI): no tariff starts on this chart.
    if (!starts.length && overview && !lastRows.some((row) => countryTaxed(row.country))) return undefined;
    return starts.length ? Math.min(...starts) : policyYear ?? undefined;
  })();
  // Each taxed country's own start, so a first-wave and a second-wave example show both jumps (as the 先看数据
  // charts of steps 11–14 do); one start keeps the single "N 年起加税" line.
  const exampleMarks = (() => {
    const taxedRows = lastRows.filter((row) => row.teaching_tariff_rate_tau > 0);
    const waveStarts = [...new Map(taxedRows.flatMap((row) => {
      const item = overview?.countries.find((entry) => entry.country === row.country);
      return item?.start_year != null && item.wave ? [[item.start_year, item.wave] as const] : [];
    })).entries()].sort(([a], [b]) => a - b);
    if (waveStarts.length > 1) {
      return waveStarts.map(([year, wave]) => ({ year, label: `${year} 年${WAVE_NAMES[wave] ?? `第 ${wave} 批`}加税` }));
    }
    if (!exampleStart) return undefined;
    return { year: exampleStart, label: isService(shownIndustry) ? `${exampleStart} 年起对货物加税` : `${exampleStart} 年起加税` };
  })();
  // One note under the selects for a selection outside the regression sample (the imposer, or an industry with
  // no first-year data), and what is shown instead.
  const boundaryNote = (() => {
    const parts = [
      ...(imposers.length
        ? [`美国是加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义（w 是“对美出口份额”，美国不会向自己出口），不是数据缺失${imposerMissing.length ? (second && isImposer(second) ? "，不能作为对照国家" : "，不能作为例子") : ""}`]
        : []),
      ...(panel && otherMissing.length
        ? [`${names(otherMissing)} · ${sectorLabel(industry)} 不在回归样本里：${otherMissing.length > 1
          ? `这两个国家的这个行业在首年（${years[0]} 年）指标无法计算（例如没有出口或没有增加值），回归没有用到它们`
          : `这个国家的这个行业在首年（${years[0]} 年）指标无法计算（例如没有出口或没有增加值），回归没有用到它`}`]
        : []),
    ];
    if (!parts.length) return null;
    if (!panel || complete) return `${parts.join("；")}。`;
    const action = otherMissing.length
      ? (otherMissing.length > 1 ? "请换国家或行业" : "请换一个国家或行业")
      : second && isImposer(second) ? "请换一个对照国家，或选“不选对照国家”" : "请换一个国家";
    const recorded = shownExample?.recorded && recordedExample
      // The parts above already say why the selection is out of the sample: no second "不在回归样本中".
      ? `下面仍显示已记录的例子 ${recordedExample}。`
      : state.data?.teaching_observation ? "已记录的例子保持不变。" : "";
    return `${parts.join("；")}。${action}。${recorded}`;
  })();

  // Last year's X and the country's exchange-rate change, as the year-by-year table shows them (teaching data v10).
  const lagOf = (row: Record<string, unknown>) => numberField(row, "teaching_tariff_exposure_lag1");
  const rateChangeOf = (row: Record<string, unknown>) => numberField(row, "teaching_exchange_rate_change");
  const hasRateChange = rows.some((row) => rateChangeOf(row) != null);
  const rateRows = useMemo(() => rows.flatMap((row) => {
    const value = numberField(row, "teaching_exchange_rate_change");
    return value == null ? [] : [{ ...row, teaching_exchange_rate_change: value }];
  }), [rows]);
  const firstWave = waves.find((wave) => wave.wave === 1)?.start_year ?? policyYear ?? undefined;
  // The first wave's currencies fall from its start year: marked only when an example country is in that wave.
  const exampleInFirstWave = lastRows.some((row) => overview?.countries.find((item) => item.country === row.country)?.wave === 1);
  // A later wave only (COL: 2019): its line is drawn too, and the page says why the currency does not move then (the
  // course's depreciation is the first wave's).
  const exampleLaterWave = exampleInFirstWave ? undefined : lastRows
    .map((row) => overview?.countries.find((item) => item.country === row.country))
    .find((item) => item?.wave && item.wave > 1 && item.start_year != null);

  // The example's X with its worked "w × τ", and why it is 0 when it is: one line a country, then the chart.
  const exampleLines = lastRows.map((row) => {
    const status = isImposer(row.country) ? "加征关税的一方（不在回归样本中）"
      : row.teaching_tariff_rate_tau > 0 ? `被加税${waveText(row.country)}`
      : !overview ? "该行业未加税（国家税况暂不可用）"
      : countryTaxed(row.country) && isService(shownIndustry) ? `被加税国家${waveText(row.country)}，但这个行业不是货物，不加税`
      : "未被加税";
    return { row, status };
  });
  const exampleHint = (() => {
    // The example shows the before/after gap only when a taxed and an untaxed country are both on the chart.
    const taxed = lastRows.map((row) => row.teaching_tariff_rate_tau > 0);
    // Taxed but with no exports to the US (w = 0): the tariff produces no exposure, so X stays 0.
    const unexposed = lastRows.filter((row) => row.teaching_tariff_rate_tau > 0 && row.teaching_tariff_exposure === 0);
    const exposed = lastRows.filter((row) => row.teaching_tariff_exposure > 0);
    const unexposedNames = unexposed.map((row) => countryLabel(row.country)).join("、");
    if (lastRows.some((row) => isImposer(row.country))) {
      return lastRows.length === 1
        ? "要看加税带来的 X，请换成被加税的国家（如加拿大）。"
        : "要比较被加税与未被加税的国家，请把美国换成别的国家（被加税的如加拿大，未被加税的如澳大利亚）。";
    }
    if (!overview && taxed.some((value) => !value)) return "国家税况暂不可用：X 为 0 可能是国家未被加税，也可能是行业不加税；请先重试上方的数据。";
    if (isService(shownIndustry)) return "这个行业不是货物：美国只对农业、采矿业和制造业（A–C）加税，任何国家这个行业的 X 都是 0。换一个货物行业（如 C29 汽车及零部件）才能看到 X 的变化。";
    if (unexposed.length && exposed.length) return `${unexposedNames} 被加税，但这个行业 ${years[0] ?? "首年"} 年不向美国出口（w = 0），X 一直为 0。`;
    if (unexposed.length) return `${unexposedNames} 被加税，但这个行业 ${years[0] ?? "首年"} 年不向美国出口（w = 0），X 一直为 0；换一个行业或国家才能看到 X 的变化。`;
    // A tariff that leaves X tiny (IDN B07_08: 0.0015 points): the axis zooms in, so the jump looks as big as CAN's.
    const largestX = Math.max(0, ...lastRows.map((row) => row.teaching_tariff_exposure * 100));
    if (largestX > 0 && largestX < 0.01) return "这个例子的 X 极小（小于 0.01 个百分点）：纵轴按它放大了，图上的跳升看起来不小，实际几乎为 0。";
    if (taxed.length === 1) {
      return taxed[0]
        ? "再选一个未被加税的对照国家（如澳大利亚），就能看到两国 X 的差距。"
        : "这个国家未被加税，X 一直为 0；换成被加税的国家（如加拿大），或再选一个被加税的对照国家。";
    }
    if (taxed.length === 2 && taxed[0] === taxed[1]) {
      return taxed[0]
        ? "两个国家都被加税，缺少未被加税的对照；可以把其中一个换成未被加税的国家（如澳大利亚）。"
        : "两个国家都未被加税，X 一直为 0；可以把其中一个换成被加税的国家（如加拿大）。";
    }
    return null;
  })();

  return <div className="shock-workbench">
    {/* One story, top to bottom: the US tariff, X on one example, the controls, then every country's X. */}
    <section className="reg-run-card">
      <span className="reg-section-step">课程模拟情景</span>
      <h3>美国对哪些国家加征关税？</h3>
      <p className="muted teaching-data-note" role="note">{GENERATED_DATA_NOTE}</p>
      {overviewQuery.status === "loading" && <div className="reg-request-state" role="status">正在读取全部国家的关税暴露…</div>}
      {overviewQuery.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(overviewQuery.error, "全部国家的关税暴露读取失败")} <button className="secondary" onClick={overviewQuery.retry}>重试</button></div>}
      {overview && <>
        <ul className="teaching-tiles" aria-label="美国加征关税的设定">
          {waves.length > 1
            ? waves.map((wave, index) => <li key={wave.wave} className={`taxed wave-${wave.wave}`}>
              <b>{wave.countries} 国</b>
              <span>{WAVE_NAMES[wave.wave] ?? `第 ${wave.wave} 批`}被加税，{wave.start_year} 年起{index === 0 && wave.min_million_usd != null
                ? `（对美货物顺差 ≥ ${ruleYiUsd(wave.min_million_usd)}）`
                : index > 0 && waves[index - 1].min_million_usd != null
                ? `（顺差 ${ruleYiUsdRange(wave.min_million_usd, waves[index - 1].min_million_usd)}）`
                : ""}</span>
            </li>)
            : <li className="taxed"><b>{overview.taxed_countries} 国</b><span>被加税{overview.policy_year ? `，${overview.policy_year} 年起` : ""}{ruleClause && ruleMin != null ? `（对美货物顺差 ≥ ${ruleYiUsd(ruleMin)}）` : ""}</span></li>}
          <li className="untaxed"><b>{overview.untaxed_countries} 国</b><span>未被加税，X 始终为 0</span></li>
          <li><b>{rate(overview.tariff_rate)}</b><span>{goodsOnly ? "只对货物（农业、采矿业、制造业）征收，加税前为 0" : "加征税率，加税前为 0"}</span></li>
        </ul>
        <p className="teaching-scenario">
          {ruleClause ? `名单${waves.length > 1 ? "和批次" : ""}由 ICIO 数据按 ${overview.taxed_rule?.year ?? years[0] ?? "首年"} 年对美货物顺差确定，不是随机抽取。` : ""}{goodsOnly ? "服务、电力、建筑等非货物行业不加税。" : ""}美国是加税方，不在回归样本中。
        </p>
      </>}
    </section>
    <section className="reg-run-card">
      <span className="reg-section-step">关税暴露 X</span>
      <h3>X = 对美出口份额 w × 加征税率 τ</h3>
      <dl className="teaching-definitions" aria-label="步骤 11–14 的模型用到的关税暴露">
        <div><dt>w</dt><dd>这个国家×行业 {years[0] ?? "首年"} 年（加税前）的出口中卖到美国的比例，之后固定不变<span className="source-tag">ICIO 数据</span></dd></div>
        <div><dt>τ</dt><dd>美国加征的税率；加税前、未被加税的国家{goodsOnly ? "和非货物行业" : ""}都是 0<span className="source-tag">课程设定</span></dd></div>
        <div><dt>L1.X</dt><dd>上一年的 X：加税当年 X 上升，L1.X 次年才上升。与 X 的关联可能分两年出现，所以回归同时放入 X 和 L1.X</dd></div>
      </dl>
      <h4 className="teaching-subhead">举个例子</h4>
      <p className="teaching-example-lead">
        选一个国家和行业，看它的 X 在加税那年怎样从 0 上升；可再选一个对照国家。默认是被加税的加拿大对未被加税的澳大利亚，行业为汽车及零部件。
      </p>
      <div className="controls" role="group" aria-label="例子的国家与行业">
        <label className="model-control"><span className="model-control-label">例子国家</span>
          <select value={first} onChange={(event) => {
            // Choosing the comparison country as A swaps the two rather than dropping one.
            choose();
            const next = event.target.value;
            if (next === second) setSecond(first);
            setFirst(next);
          }}>
            {countries.map((code) => <option key={code} value={code} disabled={isImposer(code) && code !== first}>{countryLabel(code)}{isImposer(code) ? "（加征方，不能作例子）" : ""}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">对照国家（可选）</span>
          <select value={second} onChange={(event) => { choose(); setSecond(event.target.value); }}>
            <option value="">不选对照国家</option>
            {countries.filter((code) => code !== first).map((code) => <option key={code} value={code} disabled={isImposer(code) && code !== second}>{countryLabel(code)}{isImposer(code) ? "（加征方，不能作对照）" : ""}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">行业</span>
          <select value={industry} onChange={(event) => { choose(); setIndustry(event.target.value); }}>
            {industryOptions.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
          </select>
        </label>
      </div>
      {boundaryNote && <p className="reg-boundary" role="status">{boundaryNote}</p>}
      {query.status === "loading" && <div className="shock-panel-state shock-workbench-loading" role="status">正在读取关税数据…</div>}
      {query.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(query.error, "关税数据读取失败")} <button className="secondary" onClick={query.retry}>重试</button></div>}
      {showRecorded && recordedQuery.status === "loading" && <div className="shock-panel-state" role="status">正在读取已记录例子的关税数据；报告材料保持不变…</div>}
      {showRecorded && recordedQuery.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(recordedQuery.error, "已记录例子的关税数据读取失败")} 报告材料保持不变。<button className="secondary" onClick={recordedQuery.retry}>重试已记录例子</button></div>}
      {showRecorded && recordedQuery.status === "success" && !recordedUsable && <p className="reg-boundary" role="status">{savedCompared.some(isImposer)
        ? "已记录的例子里有美国（加征关税的一方，不在回归样本中），无法显示它的趋势；报告材料保持不变。"
        : "已记录例子的逐年数据不完整，暂时无法显示趋势；报告材料保持不变。"}</p>}
      {shownExample && <div className="teaching-example-body">
        <ul className="teaching-example-summary" aria-label="所选例子的关税暴露">
          {exampleLines.map(({ row, status }) => <li key={row.country}>
            <b>{countryLabel(row.country)} · {sectorLabel(shownIndustry)}</b>
            {/* The example's own X = w × τ, at digits that check by hand (see workedNumbers). */}
            {status}：{years.at(-1)} 年 X = {worked(row).w}% × {rate(row.teaching_tariff_rate_tau)} = {worked(row).x} 个百分点{row.teaching_tariff_rate_tau > 0 && row.teaching_tariff_exposure === 0 ? "（不向美国出口：w = 0，所以 X = 0）" : ""}
          </li>)}
        </ul>
        {exampleHint && <p className="teaching-example-hint" role="note">{exampleHint}</p>}
        {shownExample.recorded && !boundaryNote && <p className="muted teaching-table-note">下面显示的是已记录的例子。</p>}
        <IndicatorTrendChart
          rows={chartRows}
          countries={shownCountries}
          years={years}
          metric="teaching_tariff_exposure"
          label={`关税暴露 X${shownCountries.length === 2 ? " · 两国同一刻度" : ""}`}
          unit="个百分点"
          markYear={exampleMarks}
          stepped
          gapNote={!overview && lastRows.length === 2 && lastRows.some((row) => row.teaching_tariff_rate_tau === 0) && !lastRows.some((row) => isImposer(row.country))
            ? "图中比较两国所选行业的 X；国家税况暂不可用，不能据此区分国家未被加税与行业不加税"
            : lastRows.length === 2 && isService(shownIndustry) && !lastRows.some((row) => isImposer(row.country))
            ? "非货物行业不加税：两国这个行业的 X 都为 0，没有差距"
            : stepTenGapNote(
              lastRows.map((row) => row.teaching_tariff_rate_tau > 0),
              lastRows.map((row) => row.teaching_tariff_exposure > 0),
              lastRows.map((row) => isImposer(row.country)),
              lastRows.map((row) => overview?.countries.find((item) => item.country === row.country)?.start_year),
            )}
          digits={chartDigits}
          countryDigits={countryDigits}
        />
        <details className="teaching-year-details">
          <summary>逐年表：每年的 w、τ、X、L1.X</summary>
          <ScrollableRegion className="table-wrap bounded-data-table" label="所选例子的逐年变量表">
            <table className="data-table teaching-year-table"><thead><tr><th scope="col">国家</th><th scope="col">年份</th><th scope="col">对美出口份额 w</th><th scope="col">加征税率 τ</th><th scope="col">关税暴露 X = w × τ</th><th scope="col">上一年的 X（L1.X）</th></tr></thead>
              {/* Country A first, then B (the rows arrive in alphabetical order). */}
              <tbody>{[...rows].sort((a, b) => shownCountries.indexOf(a.country) - shownCountries.indexOf(b.country) || a.year - b.year).map((row) => {
                // w is fixed at its first-year value, so every year of a unit shows it at the same digits: those its
                // last (taxed) year needs to check by hand, not two decimals in the zero-rate years.
                const w = sharedW(row);
                const lag = lagOf(row);
                return <tr key={`${row.country}-${row.industry}-${row.year}`}>
                  <td>{countryLabel(row.country)}</td><td>{row.year}</td><td>{w}%</td><td>{rate(row.teaching_tariff_rate_tau)}</td>
                  <td><b>{w}% × {rate(row.teaching_tariff_rate_tau)} = {worked(row).x} 个百分点</b></td>
                  <td>{lag == null ? "—" : lag === 0 ? "0 个百分点" : `${stripNegativeZero((lag * 100).toFixed(worked(row).xDecimals))} 个百分点`}</td>
                </tr>;
              })}</tbody>
            </table>
          </ScrollableRegion>
          <p className="muted teaching-table-note">行业：{sectorLabel(shownIndustry)}。{years[0] ?? "首年"} 年没有上一年，L1.X 按加税前记为 0。</p>
        </details>
      </div>}
      {/* 本步报告材料: the recorded example, as on every step. */}
      <MaterialCard
        cardRef={(node) => { recordStripRef.current = node; }}
        state={recordedExample ? "recorded" : "missing"}
        summary={recordedExample ? recordedShockMaterialLabel(state.data, overview) ?? recordedExample : "尚未记录：关税数据加载后自动记录当前例子。"}
        how={!recordedExample ? AUTO_RECORD_HOW
          : !panel ? "已记录的例子保持不变。"
          : !complete ? (savedExample
            // An older record the page can no longer use (its comparison is the USA): the same selection, not another.
            ? "这就是已记录的例子，但其中有国家不能用作例子或对照（原因见上方提示），所以下面不显示趋势；报告材料保持不变。"
            : "已记录的例子保持不变；当前选择暂不能记录，见上方提示。")
          : state.materialLocked ? (savedExample ? "当前例子就是已记录的材料。" : "已记录的是另一个例子；换回或点下面的按钮即改为当前例子。")
          : savedExample ? "当前例子就是已记录的材料；换国家或行业后自动更新。"
          : AUTO_RECORD_HOW}
        extra={`步骤 11–14 会把回归结果换算到这个例子上；例子只用来展示，不改变回归样本。${recordedX === 0
          ? "这个例子的 X 为 0，换算结果也会是 0；想看到不为 0 的换算，选被加税国家的货物行业（如加拿大的汽车行业）。"
          // Steps 11–14 convert every country of the example: "close to 0" only when the largest X is tiny, read off
          // the countries on screen while they are the recorded example; otherwise only a one-country record, whose X
          // is the one kept, can tell.
          : recordedX != null && (savedExample ? Math.max(recordedX, ...lastRows.map((row) => row.teaching_tariff_exposure))
            : savedCompared.length === 1 ? recordedX : Infinity) * 100 < 0.01
            ? "这个例子的 X 极小（小于 0.01 个百分点），换算结果会接近 0。" : ""}`}
        locked={state.materialLocked}
        rechosen={rechosen}
        action={state.materialLocked && panel && complete && !savedExample
          ? { label: "改用当前例子作为报告材料（之后需在步骤 15 更新报告）", onClick: () => { recordStripRef.current?.focus({ preventScroll: true }); setRechosen(true); recordExample(); } }
          : null}
        syncing={state.syncing}
        syncError={state.materialSyncError ?? null}
        syncConflict={state.syncConflict}
        onRetrySync={state.syncNow}
      />
    </section>
    <section className="reg-run-card">
      <span className="reg-section-step">控制变量</span>
      <h3>回归还控制汇率变动、GDP 对数和贸易开放度</h3>
      <p className="teaching-one-line">它们和加税同时变化，也会影响步骤 11–14 的 Y，所以默认模型把它们作为控制变量（由课程生成）。{hasRateChange && shownExample ? "下图是例子国家每年的汇率变动。" : ""}</p>
      {hasRateChange && shownExample && exampleLaterWave && firstWave && (
        <p className="muted teaching-one-line">课程设定的汇率贬值只发生在第一批被加税国家（{firstWave} 年起）；这个例子没有第一批国家，所以加税那年看不出汇率变化。</p>
      )}
      {hasRateChange && shownExample && (
        <IndicatorTrendChart
          rows={rateRows}
          countries={shownCountries}
          years={years}
          metric="teaching_exchange_rate_change"
          label="汇率变动（本币兑美元，负为贬值）"
          unit="个百分点"
          markYear={firstWave && exampleInFirstWave ? { year: firstWave, label: `${firstWave} 年第一批加税` }
            : exampleLaterWave ? { year: exampleLaterWave.start_year!, label: `${exampleLaterWave.start_year} 年${WAVE_NAMES[exampleLaterWave.wave!] ?? `第 ${exampleLaterWave.wave} 批`}加税` }
            : undefined}
          digits={1}
          cards={false}
        />
      )}
      <details className="teaching-variable-details">
        <summary>各控制变量的定义与来源</summary>
        <dl className="teaching-variables" aria-label="步骤 11–14 的默认控制变量">
          <div>
            <dt>汇率变动</dt>
            <dd>本币兑美元的年变动（百分点，负为贬值），每个国家每年一个值<span className="source-tag">课程生成</span>。</dd>
          </div>
          <div>
            <dt>GDP 对数与贸易开放度</dt>
            <dd>GDP 对数为 ln（模拟 GDP，美元），开放度为模拟进出口总额 / GDP（%）<span className="source-tag">课程生成</span>。</dd>
          </div>
          <div>
            <dt>可选控制</dt>
            <dd>步骤 11–14 的“改模型、对比”里还可加入人口增长率、FDI 净流入占比<span className="source-tag">课程生成</span>和制造业增加值占比等<span className="source-tag">按 ICIO 计算</span>。控制变量不是越多越好：本身受关税影响的变量不应作为控制。</dd>
          </div>
        </dl>
      </details>
    </section>
    {overview && <section className="reg-run-card">
      <span className="reg-section-step">各国的关税暴露</span>
      <h3>{overview.taxed_countries} 个被加税国家的 X（从高到低）</h3>
      <p className="teaching-one-line">每条是一个国家 {overview.year} 年{goodsOnly ? "货物" : "各"}行业的平均 X；先画 X 最高的 15 个，可在图下展开全部。</p>
      <CountryExposureChart data={overview} limit={15} />
      <p className="muted teaching-table-note">
        回归样本：{overview.countries.length} 国的 {overview.entities.toLocaleString("zh-CN")} 个国家×行业{sampleRows ? ` × ${years.length} 年 = ${sampleRows.toLocaleString("zh-CN")} 条记录` : ""}{goodsOnly ? "，货物和非货物行业都在内" : ""}{overview.entities < overview.countries.length * meta.sectors.length ? `；${years[0] ?? "首年"} 年没有出口或增加值的行业不进入样本` : ""}。
      </p>
    </section>}
  </div>;
}

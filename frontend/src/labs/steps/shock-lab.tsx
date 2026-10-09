import { useEffect, useMemo, useRef, useState } from "react";
import { sameJsonValue } from "../../session-store";
import { MATERIAL_LOCKED_NOTE } from "../../step-task-card";
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
import { CountryExposureChart, taxedRuleText, yiUsd } from "../../viz/regression/country-exposure";
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

/**
 * The one worked X = w × τ on step 10, when the followed example is not a taxed country: the default taxed country
 * (CAN, else the most exposed one) with its industries' mean, since τ is the same for all its industries and so
 * mean X = mean w × τ.
 */
export function fallbackWorkedCountry(data: TeachingCountriesResponse | undefined, preferred = "CAN") {
  const taxed = data?.countries.filter((row) => row.taxed && row.mean_exposure > 0) ?? [];
  const row = taxed.find((item) => item.country === preferred) ?? taxed[0];
  if (!row || !data?.tariff_rate) return undefined;
  return { ...row, mean_w: row.mean_exposure / data.tariff_rate };
}

/**
 * What the two-country gap in step 10 means. X = w × τ is 0 before the tariff for everyone, so after it:
 * one taxed and one untaxed → the gap is the taxed country's X; both taxed → the gap comes from their
 * different export dependence w under the same tariff; both untaxed → there is no gap.
 */
export function stepTenGapNote(taxed: boolean[], exposed: boolean[] = taxed, imposer: boolean[] = []): string | undefined {
  if (taxed.length !== 2) return undefined;
  // The imposing country's X is 0 only by definition and it is not in the regression sample: no tariff gap to read.
  if (imposer.some(Boolean)) return "美国的 X 记为 0 只是定义（它是加征关税的一方，不在回归样本中），这不是回归要比较的被加税与未被加税国家之差";
  // A taxed country with no exports to the US (w = 0) has X = 0 like an untaxed one.
  if (exposed[0] !== exposed[1]) {
    return taxed[exposed.indexOf(false)]
      ? "两国的差距就是加税那年起的 X：另一国虽被加税，但不向美国出口（w = 0），X 始终为 0"
      : "两国的差距就是加税那年起的 X：未被加税国家始终为 0";
  }
  if (!exposed[0]) {
    return taxed.some(Boolean)
      ? "两国的 X 都为 0：被加税的国家该行业不向美国出口（w = 0），没有差距"
      : "两国都未被加税：X 一直为 0，没有差距";
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
  if (x === 0) return { w: wAt(wBase), x: "0", xDecimals: 2 };
  const tauText = String(Number((tau * 100).toFixed(2)));
  for (let extra = 0; extra <= 6; extra += 1) {
    for (const [wDecimals, xDecimals] of [[wBase + extra, xBase + extra], [wBase + extra, xBase + extra + 1]]) {
      const shown = { w: wAt(wDecimals), x: (x * 100).toFixed(xDecimals), xDecimals };
      if (productChecks(shown.w, tauText, shown.x)) return shown;
    }
  }
  return { w: wAt(wBase), x: (x * 100).toFixed(xBase), xDecimals: xBase };
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
  const [first, setFirst] = useState(example.first);
  const [second, setSecond] = useState(example.second);
  const [industry, setIndustry] = useState(example.industry);
  const [chosen, setChosen] = useState(savedChosen);
  const choose = () => setChosen(true);
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
  const recordStripRef = useRef<HTMLDivElement>(null);
  // The recorded example as saved (not the current selects): "CAN 加拿大 · C29 汽车（对比 CRI 哥斯达黎加）".
  const savedCompared = state.data?.teaching_observation ? state.data.compared ?? [] : [];
  const recordedExample = savedCompared.length && state.data?.teaching_industry
    ? `${countryLabel(savedCompared[0])} · ${sectorLabel(state.data.teaching_industry)}${savedCompared[1] ? `（对比 ${countryLabel(savedCompared[1])}）` : ""}`
    : null;
  // Worded as steps 6–9 word their recorded chart.
  const recordStatus = state.materialLocked
    ? `${MATERIAL_LOCKED_NOTE}${panel && complete && savedExample ? "当前例子就是已记录的材料。" : ""}`
    : panel && complete
      ? savedExample ? "当前例子已自动记录；换国家或行业后会自动更新。" : "正在记录当前例子…"
      : null;

  const rows = useMemo(() => panel?.rows ?? [], [panel]);
  // The chart reads X in percentage points like the rest of steps 10–14 (the rows store it as a share).
  const chartRows = useMemo(() => rows.map((row) => ({ ...row, teaching_tariff_exposure: row.teaching_tariff_exposure * 100 })), [rows]);

  // The worked example uses the student's own rows: the taxed country in the latest year if there is one.
  const lastRows = selectedCountries
    .map((country) => rows.find((row) => row.country === country && row.year === years.at(-1)))
    .filter((row): row is NonNullable<typeof row> => row != null);
  const exampleRow = representativeRow(rows, selectedCountries, years.at(-1));
  // The tariff rate as set; shares and X in percentage points come from workedNumbers (two decimals, more only where
  // needed, and an exact zero X reads "0", not "0.00").
  const rate = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  // "X = w × τ" with w and X at the digits that check by hand (see workedNumbers).
  const worked = (row: { teaching_export_share_w: number; teaching_tariff_rate_tau: number; teaching_tariff_exposure: number }) =>
    workedNumbers(row.teaching_export_share_w, row.teaching_tariff_rate_tau, row.teaching_tariff_exposure);
  // The chart cards read X at the same digits as the summary above them: two decimals, more for a tiny X
  // ("0.00083" rather than "不到 0.01") or where two would not check by hand ("0.025", not "0.02").
  const chartDigits = Math.max(2, ...lastRows.filter((row) => row.teaching_tariff_exposure > 0).map((row) => worked(row).xDecimals));
  const isImposer = (country: string) => country === TARIFF_IMPOSER;
  const imposerMissing = missing.filter(isImposer);
  const otherMissing = missing.filter((country) => !isImposer(country));
  const bothTaxed = lastRows.length === 2 && lastRows.every((row) => row.teaching_tariff_rate_tau > 0);

  // The worked X = w × τ: the followed example when it is a taxed country, else CAN's mean over its industries.
  const workedExample = exampleRow && complete && exampleRow.teaching_tariff_rate_tau > 0 && !isImposer(exampleRow.country)
    ? exampleRow
    : undefined;
  const workedCountry = workedExample ? undefined : fallbackWorkedCountry(overview);
  const names = (codes: readonly string[]) => codes.map(countryLabel).join("、");
  // Why the worked card does not use the student's example: every case is named, never a silent switch.
  // The imposer has no rows in the teaching data (an older server sent X = 0 rows for it); either way it is named.
  const imposers = selectedCountries.filter(isImposer);
  const untaxedRows = lastRows.filter((row) => !isImposer(row.country));
  const fallbackReasons = !workedCountry ? [] : [
    ...(imposers.length ? [`你的例子里的 ${names(imposers)} 是加征关税的一方，不在回归样本中`] : []),
    ...(otherMissing.length ? [`你的例子 ${names(otherMissing)} · ${sectorLabel(industry)} 不在回归样本里`] : []),
    ...(complete && untaxedRows.length
      ? [`你的例子 ${names(untaxedRows.map((row) => row.country))} ${untaxedRows.length > 1 ? "都" : ""}未被加税，X 一直是 0`]
      : []),
    ...(query.status === "error" ? ["你的例子的关税数据没有读到"] : []),
  ];
  // The worked row is country B when A has no exposure (untaxed, taxed with w = 0, or the imposer): say so.
  const firstRow = lastRows.find((row) => row.country === first);
  const switchedToB = workedExample && workedExample.country !== first && firstRow
    ? `国家 A ${countryLabel(first)}${isImposer(first)
      ? " 是加征关税的一方，X 记为 0 只是定义"
      : firstRow.teaching_tariff_rate_tau > 0
        ? " 被加税，但该行业首年不向美国出口（w = 0），X 一直是 0"
        : " 未被加税，X 一直是 0"}，所以这里用对比国家 B ${countryLabel(workedExample.country)} 算。`
    : null;
  // The chart marks the example the report records: the current selection once it can be recorded (or while it
  // loads), else the recorded one, so the A/B marks never disagree with the "已记录的例子" line below.
  const marksRecorded = Boolean(panel) && !complete && savedCompared.length > 0;
  const highlight = marksRecorded ? savedCompared : selectedCountries;
  const highlightLabel = marksRecorded
    ? "已记录的例子（当前选择不在回归样本中）"
    : state.materialLocked && recordedExample && !savedExample ? "当前选的例子（不是已记录的报告材料）" : "你跟踪的例子";
  const taxedCount = overview?.taxed_countries ?? sample?.taxed_countries;
  // The data rule that picks the taxed countries (teaching data v7 on); an older server sends none.
  const ruleClause = taxedRuleText(overview?.taxed_rule, "达到或超过 ");
  const ruleMin = overview?.taxed_rule?.min_million_usd;
  const sampleRows = sample?.rows ?? (overview ? overview.entities * years.length : undefined);

  return <div className="shock-workbench">
    <section className="reg-run-card">
      <span className="reg-section-step">全部样本</span>
      <h3>关税暴露 X：哪些国家被加税，暴露有多大？</h3>
      <p className="muted teaching-data-note" role="note">{GENERATED_DATA_NOTE}</p>
      {overviewQuery.status === "loading" && <div className="reg-request-state" role="status">正在读取全部国家的关税暴露…</div>}
      {overviewQuery.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(overviewQuery.error, "全部国家的关税暴露读取失败")} <button className="secondary" onClick={overviewQuery.retry}>重试</button></div>}
      {overview && <>
        {/* The whole scenario is centred on one market: say so before any number or example. */}
        <p className="teaching-scenario">
          <b>情景以美国为中心：</b>{countryLabel(overview.market)}{overview.policy_year ? `从 ${overview.policy_year} 年起` : ""}对 {ruleClause ? `${ruleClause}的 ${overview.taxed_countries} 个国家` : `${overview.taxed_countries} 个国家的商品`}加征 {rate(overview.tariff_rate)} 关税，其余 {overview.untaxed_countries} 个国家未被加税。关税暴露 X 衡量一个国家×行业的出口有多依赖美国市场：X = 首年对美出口份额 w × 加征税率 τ。
        </p>
        <ul className="teaching-tiles" aria-label="全部样本的加税设定">
          <li className="taxed"><b>{overview.taxed_countries} 国</b><span>被美国加税{ruleClause && ruleMin != null ? `（对美货物顺差 ≥ ${yiUsd(ruleMin)}）` : ""}</span></li>
          <li className="untaxed"><b>{overview.untaxed_countries} 国</b><span>未被加税（X 始终为 0）</span></li>
          <li className="imposer"><b>{countryLabel(overview.market)}</b><span>加征关税的一方（不在样本中）</span></li>
          <li><b>{rate(overview.tariff_rate)}</b><span>{overview.policy_year ? `${overview.policy_year} 年起的税率（此前为 0）` : "加征税率"}</span></li>
        </ul>
        <p className="teaching-one-line">
          回归样本：{overview.countries.length} 国的 {overview.entities.toLocaleString("zh-CN")} 个国家×行业{sampleRows ? ` × ${years.length} 年 = ${sampleRows.toLocaleString("zh-CN")} 条记录` : ""}。下图是每个国家 {overview.year} 年各行业的平均 X。
        </p>
        <CountryExposureChart data={overview} highlight={highlight} highlightLabel={highlightLabel} />
      </>}
      {workedExample && (() => {
        const shown = worked(workedExample);
        return <div className="teaching-x-card" role="group" aria-label="用所选例子算一次 X">
          <b>算一次：X = w × τ</b>
          <p>
            {countryLabel(workedExample.country)} · {sectorLabel(industry)} · {workedExample.year} 年：{" "}
            <span className="teaching-x-formula">X = {shown.w}% × {rate(workedExample.teaching_tariff_rate_tau)} = <b>{shown.x} 个百分点</b></span>
            {workedExample.teaching_tariff_exposure === 0 ? "（被加税了，但 w = 0，所以 X 仍是 0）" : bothTaxed ? "（税率相同时，对美出口份额 w 不同，X 也不同）" : ""}
          </p>
          {switchedToB && <p className="muted teaching-x-reason">{switchedToB}</p>}
          <p className="muted">w = 首年（{years[0]} 年）对美出口份额 {shown.w}%，之后各年不变；τ = 加征税率。</p>
        </div>;
      })()}
      {workedCountry && overview && (() => {
        const shown = workedNumbers(workedCountry.mean_w, overview.tariff_rate, workedCountry.mean_exposure);
        return <div className="teaching-x-card" role="group" aria-label="用被加税国家算一次 X">
          <b>算一次：X = w × τ</b>
          <p>
            {countryLabel(workedCountry.country)} · {overview.year} 年 · {workedCountry.industries} 个行业平均：{" "}
            <span className="teaching-x-formula">X = {shown.w}% × {rate(overview.tariff_rate)} = <b>{shown.x} 个百分点</b></span>
          </p>
          {fallbackReasons.length > 0 && (
            <p className="muted teaching-x-reason">{fallbackReasons.join("；")}，所以这里用 {countryLabel(workedCountry.country)} 各行业的平均算。</p>
          )}
          <p className="muted">w = 首年（{years[0]} 年）对美出口份额，之后各年不变；同一国家各行业的 τ 相同，所以平均 X = 平均 w × τ。</p>
        </div>;
      })()}
      <p className="teaching-one-line">步骤 11–14 用每个国家×行业的 X 对照四类指标 Y，读“X 每高 1 个百分点，Y 平均相差多少”。</p>
    </section>
    <section className="reg-run-card">
      <span className="reg-section-step">跟踪一个例子（可选）</span>
      <p className="teaching-example-lead">
        看 X 在加税那年怎样跳起来。默认的加拿大是{taxedCount ? ` ${taxedCount} 个` : ""}被加税国家之一，对比的哥斯达黎加未被加税（两国汽车业都主要卖给美国），行业默认是 C29 汽车及零部件。步骤 11–14 会把回归结果换算到你选的例子上。
      </p>
      <div className="controls" role="group" aria-label="跟随的例子">
        <label className="model-control"><span className="model-control-label">国家 A</span>
          <select value={first} onChange={(event) => {
            // Choosing the comparison country as A swaps the two rather than dropping one.
            choose();
            const next = event.target.value;
            if (next === second) setSecond(first);
            setFirst(next);
          }}>
            {countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">对比国家 B</span>
          <select value={second} onChange={(event) => { choose(); setSecond(event.target.value); }}>
            <option value="">不选对比国家</option>
            {countries.filter((code) => code !== first).map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">行业</span>
          <select value={industry} onChange={(event) => { choose(); setIndustry(event.target.value); }}>
            {industryOptions.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
          </select>
        </label>
      </div>
      {/* What the report material holds, as step 1 shows its recorded cell; it follows the selection until the
          report is submitted, then changes only through the button. */}
      <div className="observation-strip teaching-example-record" ref={recordStripRef} tabIndex={-1} aria-live="polite">
        <b>已记录的例子</b>
        {recordedExample ? <span>{recordedExample}</span> : <span className="empty">尚未记录</span>}
        {recordStatus && <span className="muted">{recordStatus}</span>}
        {state.materialLocked && panel && complete && !savedExample && (
          <button type="button" className="secondary" onClick={() => {
            // The button removes itself: focus the strip (it stays mounted), which then confirms the switch.
            recordStripRef.current?.focus({ preventScroll: true });
            recordExample();
          }}>改用当前例子作为报告材料（之后需在步骤 15 更新报告）</button>
        )}
      </div>
      {selectedCountries.some(isImposer) && (
        <p className="reg-boundary" role="note">
          美国是加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义（w 是“对美出口份额”，美国不会向自己出口），不是数据缺失。
        </p>
      )}
    </section>
    {query.status === "loading" && <div className="shock-panel-state shock-workbench-loading" role="status">正在读取关税数据…</div>}
    {query.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(query.error, "关税数据读取失败")} <button className="secondary" onClick={query.retry}>重试</button></div>}
    {panel && !complete && (
      <div className="reg-boundary" role="status">
        {otherMissing.length > 0
          ? <>{otherMissing.map(countryLabel).join("、")} · {sectorLabel(industry)} 不在回归样本里：{otherMissing.length > 1
            ? `这两个国家的这个行业在首年（${years[0]} 年）都缺少必要数据，回归没有用到它们。请换国家或行业`
            : `这个国家的这个行业在首年（${years[0]} 年）缺少必要数据，回归没有用到它。请换一个国家或行业`}</>
          : <>{imposerMissing.map(countryLabel).join("、")} 不在回归样本里（见上面的说明），不能作为例子。请换一个国家</>}
        {state.data?.teaching_observation ? "；已记录的例子保持不变" : ""}。
      </div>
    )}
    {panel && complete && <>
      <section className="reg-section-card">
        <span className="reg-section-step">五年趋势{selectedCountries.length === 2 ? " · 两国使用同一刻度" : ""}</span>
        <ul className="teaching-example-summary" aria-label="所选例子的关税暴露">
          {lastRows.map((row) => {
            const taxed = row.teaching_tariff_rate_tau > 0;
            return <li key={row.country}>
              <b>{countryLabel(row.country)} · {sectorLabel(industry)}</b>
              {isImposer(row.country) ? "加征关税的一方（不在回归样本中）" : taxed ? "被加税" : "未被加税"}：w = {worked(row).w}%，{years.at(-1)} 年 X = {worked(row).x} 个百分点{taxed && row.teaching_tariff_exposure === 0 ? "（不向美国出口：w = 0，所以 X = 0）" : ""}
            </li>;
          })}
        </ul>
        {(() => {
          // The example shows the before/after gap only when a taxed and an untaxed country are both on the chart.
          const taxed = lastRows.map((row) => row.teaching_tariff_rate_tau > 0);
          // Taxed but with no exports to the US (w = 0): the tariff produces no exposure, so X stays 0.
          const unexposed = lastRows.filter((row) => row.teaching_tariff_rate_tau > 0 && row.teaching_tariff_exposure === 0);
          const exposed = lastRows.filter((row) => row.teaching_tariff_exposure > 0);
          const unexposedNames = unexposed.map((row) => countryLabel(row.country)).join("、");
          const hint = lastRows.some((row) => isImposer(row.country))
            ? (lastRows.length === 1
              ? "想看加税带来的 X，换成被加税的国家（如加拿大），或再选一个被加税的对比国家。"
              : "想看被加税与未被加税国家的差别，把美国换成别的国家（被加税的如加拿大，未被加税的如哥斯达黎加）。")
            : unexposed.length && exposed.length
            // The other country already shows the exposure: nothing to switch.
            ? `${unexposedNames} 被加税，但该行业首年不向美国出口（w = 0），所以 X 一直为 0；图上 ${exposed.map((row) => countryLabel(row.country)).join("、")} 的 X 就是加税带来的暴露。`
            : unexposed.length
            ? `${unexposedNames} 被加税，但该行业首年不向美国出口（w = 0），所以 X 一直为 0；换一个行业或国家才能看到加税带来的暴露。`
            : taxed.length === 1
            ? (taxed[0]
              ? "只看一个被加税国家时，图上是它自己的 X 跳起来；再选一个未被加税的对比国家（如哥斯达黎加），就能看到两者的差距。"
              : "这个国家未被加税，X 一直为 0；换成被加税的国家（如加拿大），或再选一个被加税的对比国家，才能看到差距。")
            : taxed.length === 2 && taxed[0] === taxed[1]
              ? (taxed[0]
                ? "两个国家都被加税，缺少未被加税的对照；可以把其中一个换成未被加税的国家（如哥斯达黎加）。"
                : "两个国家都未被加税，X 一直为 0，看不到加税前后的差距；可以把其中一个换成被加税的国家（如加拿大）。")
              : null;
          return hint && <p className="teaching-example-hint" role="note">{hint}</p>;
        })()}
        <IndicatorTrendChart
          rows={chartRows}
          countries={selectedCountries}
          years={years}
          metric="teaching_tariff_exposure"
          label="关税暴露 X"
          unit="个百分点"
          markYear={groups.status === "success" && groups.data ? { year: groups.data.policy_year, label: `${groups.data.policy_year} 年起加税` } : undefined}
          stepped
          gapNote={stepTenGapNote(
            lastRows.map((row) => row.teaching_tariff_rate_tau > 0),
            lastRows.map((row) => row.teaching_tariff_exposure > 0),
            lastRows.map((row) => isImposer(row.country)),
          )}
          digits={chartDigits}
        />
      </section>
      <details className="technical-details">
        <summary>逐年读数 · {rows.length} 条</summary>
        <ScrollableRegion className="table-wrap bounded-data-table" label="所选例子的五年关税暴露表">
          <table className="data-table"><thead><tr><th>国家</th><th>行业</th><th>年份</th><th>首年对美出口份额 w</th><th>加征税率 τ</th><th>关税暴露 X = w × τ</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.country}-${row.industry}-${row.year}`}><td>{countryLabel(row.country)}</td><td>{sectorLabel(row.industry)}</td><td>{row.year}</td><td>{worked(row).w}%</td><td>{rate(row.teaching_tariff_rate_tau)}</td><td><b>{worked(row).w}% × {rate(row.teaching_tariff_rate_tau)} = {worked(row).x} 个百分点</b></td></tr>)}</tbody>
          </table>
        </ScrollableRegion>
      </details>
    </>}
  </div>;
}

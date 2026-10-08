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
import { percentagePoints } from "../../format";
import { countryLabel, sectorLabel } from "../../viz";
import { CountryExposureChart } from "../../viz/regression/country-exposure";
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
  if (imposer.some(Boolean)) return "美国的 X 记为 0 只是定义（它是加征关税的一方，不在回归样本中），这不是回归要比较的加税与未加税之差";
  // A taxed country with no exports to the US (w = 0) has X = 0 like an untaxed one.
  if (exposed[0] !== exposed[1]) {
    return taxed[exposed.indexOf(false)]
      ? "两国的差距就是加税那年起的 X：另一国虽被加税，但不向美国出口（w = 0），X 始终为 0"
      : "两国的差距就是加税那年起的 X：未加税国家始终为 0";
  }
  if (!exposed[0]) {
    return taxed.some(Boolean)
      ? "两国的 X 都为 0：加税的国家该行业不向美国出口（w = 0），没有差距"
      : "两国都未加税：X 一直为 0，没有差距";
  }
  return "两国都被加税（税率相同）：差距来自对美出口份额 w 的不同；缺少未加税的对照";
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

export function ShockLab({ meta, step: _step, state, getStep }: {
  meta: Meta;
  step: Step;
  state: StepStateApi<ShockStepState>;
  /** Read-only: step 9's recorded industry seeds the example's industry. */
  getStep?: <T>(step: number) => T | undefined;
}) {
  const priorNetwork = getStep?.<{ observations?: { industry?: string }[] }>(9);
  // Only a material about one industry (a trend) seeds the example; a ranking covers many industries,
  // and its first row would be an arbitrary choice the student never made.
  const priorIndustries = new Set((priorNetwork?.observations ?? []).map((item) => item.industry).filter(Boolean));
  const priorIndustry = priorIndustries.size === 1 ? [...priorIndustries][0] : undefined;
  const defaults = teachingExample(meta);
  // A saved example leads only once the student picked it here: an example saved because step 10 was merely
  // shown (a quick click through) still lets a later one-industry step 9 choice lead. After submission the
  // saved example stays put.
  const savedChosen = exampleWasChosen(state.data, defaults);
  const followStepNine = Boolean(priorIndustry) && !savedChosen && !state.materialLocked;
  const example = teachingExample(meta, followStepNine ? { compared: state.data?.compared } : state.data, priorIndustry);
  const countries = example.countries;
  const [first, setFirst] = useState(example.first);
  const [second, setSecond] = useState(example.second);
  const [industry, setIndustry] = useState(example.industry);
  const [chosen, setChosen] = useState(savedChosen);
  // Why step 9's industry was not used, said once in a line (it used to fall back silently).
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const choose = () => {
    setChosen(true);
    setFallbackNote(null);
    inheritedIndustry.current = false;
  };
  // The industry came from step 9 rather than from the student here: if the pair is not in the regression
  // sample for it, fall back to the default industry instead of an unusable example.
  const inheritedIndustry = useRef(followStepNine && example.industry === priorIndustry);
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
  const fallbackIndustry = defaults.industry;
  useEffect(() => {
    if (!panel || complete || !inheritedIndustry.current || industry === fallbackIndustry) return;
    inheritedIndustry.current = false;
    setFallbackNote(`步骤 9 看的是 ${sectorLabel(industry)}，但 ${missing.map(countryLabel).join("、")} 的这个行业不在回归样本里，所以这里先用默认的 ${sectorLabel(fallbackIndustry)}；也可以在下面换行业或国家。`);
    setIndustry(fallbackIndustry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, complete, industry, fallbackIndustry]);
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
  // The recorded example as saved (not the current selects): "CAN 加拿大 · C29 汽车（对比 MEX 墨西哥）".
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
  // Shares and X in percentage points with two decimals everywhere on this step; the tariff rate as set.
  const pct = (value: number) => `${percentagePoints(value)}%`;
  // X in percentage points; an exact zero (untaxed, or w = 0) reads "0", not "0.00".
  const xPoints = (value: number) => (value === 0 ? "0" : percentagePoints(value));
  const rate = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  // A tiny X (w of a few thousandths of a percent) keeps two significant digits on the chart cards, so they
  // read "0.00083" rather than "不到 0.01"; normal values keep two decimals.
  const positiveX = chartRows.map((row) => row.teaching_tariff_exposure).filter((value) => value > 0);
  const chartDigits = positiveX.length && Math.max(...positiveX) < 0.005
    ? Math.min(10, Math.ceil(-Math.log10(Math.min(...positiveX))) + 1)
    : 2;
  const isImposer = (country: string) => country === TARIFF_IMPOSER;
  const imposerMissing = missing.filter(isImposer);
  const otherMissing = missing.filter((country) => !isImposer(country));
  const bothTaxed = lastRows.length === 2 && lastRows.every((row) => row.teaching_tariff_rate_tau > 0);

  // The worked X = w × τ: the followed example when it is a taxed country, else CAN's mean over its industries.
  const workedExample = exampleRow && complete && exampleRow.teaching_tariff_rate_tau > 0 && !isImposer(exampleRow.country)
    ? exampleRow
    : undefined;
  const workedCountry = workedExample ? undefined : fallbackWorkedCountry(overview);
  const taxedCount = overview?.taxed_countries ?? sample?.taxed_countries;
  const sampleRows = sample?.rows ?? (overview ? overview.entities * years.length : undefined);

  return <div className="shock-workbench">
    <section className="reg-run-card">
      <span className="reg-section-step">全部样本</span>
      <h3>关税暴露 X：哪些国家被加税，暴露有多大？</h3>
      <p className="muted teaching-data-note" role="note">{GENERATED_DATA_NOTE}</p>
      {overviewQuery.status === "loading" && <div className="reg-request-state" role="status">正在读取全部国家的关税暴露…</div>}
      {overviewQuery.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(overviewQuery.error, "全部国家的关税暴露读取失败")} <button className="secondary" onClick={overviewQuery.retry}>重试</button></div>}
      {overview && <>
        <ul className="teaching-tiles" aria-label="全部样本的加税设定">
          <li className="taxed"><b>{overview.taxed_countries} 国</b><span>加税</span></li>
          <li className="untaxed"><b>{overview.untaxed_countries} 国</b><span>未加税（X 始终为 0）</span></li>
          <li className="imposer"><b>{countryLabel(overview.market)}</b><span>加征关税的一方（不在样本中）</span></li>
          <li><b>{rate(overview.tariff_rate)}</b><span>{overview.policy_year ? `${overview.policy_year} 年起的税率（此前为 0）` : "加征税率"}</span></li>
        </ul>
        <p className="teaching-one-line">
          回归样本：{overview.countries.length} 国的 {overview.entities.toLocaleString("zh-CN")} 个国家×行业{sampleRows ? ` × ${years.length} 年 = ${sampleRows.toLocaleString("zh-CN")} 条记录` : ""}。下图是每个国家 {overview.year} 年各行业的平均 X。
        </p>
        <CountryExposureChart data={overview} highlight={selectedCountries} />
      </>}
      {workedExample && (
        <div className="teaching-x-card" role="group" aria-label="用所选例子算一次 X">
          <b>算一次：X = w × τ</b>
          <p>
            {countryLabel(workedExample.country)} · {sectorLabel(industry)} · {workedExample.year} 年：{" "}
            <span className="teaching-x-formula">X = {pct(workedExample.teaching_export_share_w)} × {rate(workedExample.teaching_tariff_rate_tau)} = <b>{xPoints(workedExample.teaching_tariff_exposure)} 个百分点</b></span>
            {workedExample.teaching_tariff_exposure === 0 ? "（加税了，但 w = 0，所以 X 仍是 0）" : bothTaxed ? "（税率相同时，对美出口份额 w 不同，X 也不同）" : ""}
          </p>
          <p className="muted">w = 首年（{years[0]} 年）对美出口份额 {pct(workedExample.teaching_export_share_w)}，之后各年不变；τ = 加征税率。</p>
        </div>
      )}
      {workedCountry && overview && (
        <div className="teaching-x-card" role="group" aria-label="用加税国家算一次 X">
          <b>算一次：X = w × τ</b>
          <p>
            {countryLabel(workedCountry.country)} · {overview.year} 年 · {workedCountry.industries} 个行业平均：{" "}
            <span className="teaching-x-formula">X = {pct(workedCountry.mean_w)} × {rate(overview.tariff_rate)} = <b>{xPoints(workedCountry.mean_exposure)} 个百分点</b></span>
          </p>
          {exampleRow && complete && (
            <p className="muted">
              {isImposer(exampleRow.country)
                ? "你的例子是美国：它是加征关税的一方，X 记为 0 只是定义"
                : `你的例子 ${countryLabel(exampleRow.country)} 未被加税，X 一直是 0`}，所以这里用 {countryLabel(workedCountry.country)} 算。
            </p>
          )}
          <p className="muted">w = 首年（{years[0]} 年）对美出口份额，之后各年不变；同一国家各行业的 τ 相同，所以平均 X = 平均 w × τ。</p>
        </div>
      )}
      <p className="teaching-one-line">步骤 11–14 用每个国家×行业的 X 对照四类指标 Y，读“X 每高 1 个百分点，Y 平均相差多少”。</p>
    </section>
    <section className="reg-run-card">
      <span className="reg-section-step">跟踪一个例子（可选）</span>
      <p className="teaching-example-lead">
        看 X 在加税那年怎样跳起来。默认的加拿大是{taxedCount ? ` ${taxedCount} 个` : ""}加税国家之一，对比的墨西哥未加税；行业沿用步骤 9 最后看的行业。步骤 11–14 会把回归结果换算到你选的例子上。
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
      {fallbackNote && <p className="reg-boundary teaching-fallback-note" role="status">{fallbackNote}</p>}
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
          ? <>{otherMissing.map(countryLabel).join("、")} · {sectorLabel(industry)} 不在回归样本里：这个国家的这个行业在首年（{years[0]} 年）缺少必要数据，回归没有用到它。请换一个国家或行业</>
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
              {isImposer(row.country) ? "加征关税的一方（不在回归样本中）" : taxed ? "加税" : "未加税"}：w = {pct(row.teaching_export_share_w)}，{years.at(-1)} 年 X = {xPoints(row.teaching_tariff_exposure)} 个百分点{taxed && row.teaching_tariff_exposure === 0 ? "（不向美国出口：w = 0，所以 X = 0）" : ""}
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
              ? "想看加税带来的 X，换成加税的国家（如加拿大），或再选一个加税的对比国家。"
              : "想看加税与未加税的差别，把美国换成别的国家（加税的如加拿大，未加税的如墨西哥）。")
            : unexposed.length && exposed.length
            // The other country already shows the exposure: nothing to switch.
            ? `${unexposedNames} 被加税，但该行业首年不向美国出口（w = 0），所以 X 一直为 0；图上 ${exposed.map((row) => countryLabel(row.country)).join("、")} 的 X 就是加税带来的暴露。`
            : unexposed.length
            ? `${unexposedNames} 被加税，但该行业首年不向美国出口（w = 0），所以 X 一直为 0；换一个行业或国家才能看到加税带来的暴露。`
            : taxed.length === 1
            ? (taxed[0]
              ? "只看一个加税国家时，图上是它自己的 X 跳起来；再选一个未加税的对比国家（如墨西哥），就能看到两者的差距。"
              : "这个国家未被加税，X 一直为 0；换成加税的国家（如加拿大），或再选一个加税的对比国家，才能看到差距。")
            : taxed.length === 2 && taxed[0] === taxed[1]
              ? (taxed[0]
                ? "两个国家都被加税，缺少未加税的对照；可以把其中一个换成未加税的国家（如墨西哥）。"
                : "两个国家都未被加税，X 一直为 0，看不到加税前后的差距；可以把其中一个换成加税的国家（如加拿大）。")
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
            <tbody>{rows.map((row) => <tr key={`${row.country}-${row.industry}-${row.year}`}><td>{countryLabel(row.country)}</td><td>{sectorLabel(row.industry)}</td><td>{row.year}</td><td>{pct(row.teaching_export_share_w)}</td><td>{rate(row.teaching_tariff_rate_tau)}</td><td><b>{pct(row.teaching_export_share_w)} × {rate(row.teaching_tariff_rate_tau)} = {xPoints(row.teaching_tariff_exposure)} 个百分点</b></td></tr>)}</tbody>
          </table>
        </ScrollableRegion>
      </details>
    </>}
  </div>;
}

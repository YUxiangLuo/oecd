import { useEffect, useMemo, useState } from "react";
import { sameJsonValue } from "../../session-store";
import { MATERIAL_LOCKED_NOTE } from "../../step-task-card";
import { api } from "../../api";
import { ScrollableRegion } from "../../a11y";
import { userFacingRequestError } from "../../user-facing-error";
import type { Meta, QuizCompletionState, Step, StepStateApi, TeachingGroupsResponse, TeachingPanelResponse } from "../../types";
import { teachingExample } from "../../teaching-example";
import { countryLabel, sectorLabel } from "../../viz";
import { useAsync } from "../shared";
import { IndicatorTrendChart } from "./viz/indicator-charts";

export interface ShockStepState extends QuizCompletionState, Record<string, unknown> {
  compared?: string[];
  teaching_industry?: string;
  teaching_country?: string;
  teaching_year?: number;
  viewed_teaching_panel?: boolean;
  teaching_panel_version?: string;
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

/** 步骤 10 只介绍四个后续回归共同使用的虚构关税暴露 X。 */
export function ShockLab({ meta, step: _step, state }: {
  meta: Meta;
  step: Step;
  state: StepStateApi<ShockStepState>;
}) {
  const example = teachingExample(meta, state.data);
  const countries = example.countries;
  const [first, setFirst] = useState(example.first);
  const [second, setSecond] = useState(example.second);
  const [industry, setIndustry] = useState(example.industry);
  const groups = useAsync<TeachingGroupsResponse>(() => api.teachingGroups(), ["teaching-groups"]);
  const sample = groups.status === "success" ? groups.data?.sample : undefined;
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
  const recordExample = () => {
    if (!panel) return;
    const lastYear = years.at(-1);
    const representative = panel.rows.find((row) => row.country === first && row.year === lastYear)
      ?? panel.rows[0];
    state.save({
      compared: selectedCountries,
      teaching_industry: industry,
      teaching_country: representative?.country ?? first,
      teaching_year: representative?.year ?? lastYear,
      viewed_teaching_panel: true,
      teaching_panel_version: panel.version,
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
    if (!panel || !complete || savedExample || state.materialLocked) return;
    recordExample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, complete, savedExample, first, second, industry]);

  const rows = useMemo(() => panel?.rows ?? [], [panel]);

  // The worked example uses the student's own rows: the taxed country in the latest year if there is one.
  const lastRows = selectedCountries
    .map((country) => rows.find((row) => row.country === country && row.year === years.at(-1)))
    .filter((row): row is NonNullable<typeof row> => row != null);
  const exampleRow = lastRows.find((row) => row.teaching_tariff_rate_tau > 0) ?? lastRows[0];
  const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;

  return <div className="shock-workbench">
    <section className="reg-run-card">
      <span className="reg-section-step">先看一个例子</span>
      <h3>模拟关税暴露 X 怎样随年份变化？</h3>
      <p>选一个国家和一个行业；再选一个对比国家，就能看到加税与未加税的差别。默认是加拿大和墨西哥的汽车行业：两国出口都高度依赖美国，但只有加拿大在模拟中被加税。步骤 11–14 会把回归结果换算到你选的例子上。</p>
      <div className="controls" role="group" aria-label="跟随的例子">
        <label className="model-control"><span className="model-control-label">国家 A</span>
          <select value={first} onChange={(event) => {
            // Choosing the comparison country as A swaps the two rather than dropping one.
            const next = event.target.value;
            if (next === second) setSecond(first);
            setFirst(next);
          }}>
            {countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">对比国家 B</span>
          <select value={second} onChange={(event) => setSecond(event.target.value)}>
            <option value="">不选对比国家</option>
            {countries.filter((code) => code !== first).map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">行业</span>
          <select value={industry} onChange={(event) => setIndustry(event.target.value)}>
            {industryOptions.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
          </select>
        </label>
      </div>
      {selectedCountries.includes("USA") && (
        <p className="reg-boundary" role="note">
          美国本身就是模拟加税的市场：w 是“销往美国的出口份额”，美国不会向自己出口，所以美国各年的 w、τ 和 X 都是 0。这不是数据缺失；它在回归中始终是未受模拟加税影响的单元。
        </p>
      )}
    </section>
    {query.status === "loading" && <div className="shock-panel-state shock-workbench-loading" role="status">正在读取教学关税面板…</div>}
    {query.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(query.error, "教学关税面板读取失败")} <button className="secondary" onClick={query.retry}>重试</button></div>}
    {panel && !complete && (
      <div className="reg-boundary" role="status">
        {missing.map(countryLabel).join("、")} · {sectorLabel(industry)} 不在教学样本中：该国家×行业单元的首年数据不满足样本条件，没有进入回归面板。请换一个国家或行业{state.data?.teaching_observation ? "；已记录的例子保持不变" : ""}。
      </div>
    )}
    {panel && complete && state.materialLocked && !savedExample && (
      <div className="reg-boundary" role="status">
        {MATERIAL_LOCKED_NOTE}
        <button type="button" className="secondary" onClick={recordExample}>改用当前例子作为报告材料（之后需在步骤 15 更新报告）</button>
      </div>
    )}
    {panel && complete && <>
      <section className="reg-section-card">
        <span className="reg-section-step">五年趋势{selectedCountries.length === 2 ? " · 两国使用同一刻度" : ""}</span>
        <ul className="teaching-example-summary" aria-label="所选例子的模拟关税暴露">
          {lastRows.map((row) => {
            const taxed = row.teaching_tariff_rate_tau > 0;
            return <li key={row.country}>
              <b>{countryLabel(row.country)} · {sectorLabel(industry)}</b>
              {taxed ? "模拟加税" : "未加税"}：w = {pct(row.teaching_export_share_w)}，{years.at(-1)} 年 X = {(row.teaching_tariff_exposure * 100).toFixed(2)} 个百分点
            </li>;
          })}
        </ul>
        {(() => {
          // The example shows the before/after gap only when a taxed and an untaxed country are both on the chart.
          const taxed = lastRows.map((row) => row.teaching_tariff_rate_tau > 0);
          const hint = taxed.length === 1
            ? (taxed[0]
              ? "只看一个加税国家时，图上是它自己的 X 跳起来；再选一个未加税的对比国家（如墨西哥），就能看到两者的差距。"
              : "这个国家未被模拟加税，X 一直为 0；换成模拟加税的国家（如加拿大），或再选一个加税的对比国家，才能看到差距。")
            : taxed.length === 2 && taxed[0] === taxed[1]
              ? (taxed[0]
                ? "两个国家都被模拟加税，缺少未加税的对照；可以把其中一个换成未加税的国家（如墨西哥）。"
                : "两个国家都未被模拟加税，X 一直为 0，看不到加税前后的差距；可以把其中一个换成模拟加税的国家（如加拿大）。")
              : null;
          return hint && <p className="teaching-example-hint" role="note">{hint}</p>;
        })()}
        <IndicatorTrendChart
          rows={rows}
          countries={selectedCountries}
          years={years}
          metric="teaching_tariff_exposure"
          label="模拟关税暴露 X"
          unit="%"
          markYear={groups.status === "success" && groups.data ? { year: groups.data.policy_year, label: `${groups.data.policy_year} 年起模拟加税` } : undefined}
        />
        {exampleRow && (
          <div className="reg-variable-plain-grid" role="group" aria-label="用所选例子算一次 X">
            <div>
              <b>算一次：X = w × τ</b>
              <span>
                {countryLabel(exampleRow.country)} · {sectorLabel(industry)} · {exampleRow.year} 年：出口份额 w = {pct(exampleRow.teaching_export_share_w, 2)}，模拟税率 τ = {pct(exampleRow.teaching_tariff_rate_tau, 0)}，
                所以 X = {pct(exampleRow.teaching_export_share_w, 2)} × {pct(exampleRow.teaching_tariff_rate_tau, 0)} = <b>{(exampleRow.teaching_tariff_exposure * 100).toFixed(2)} 个百分点</b>。
                {exampleRow.teaching_tariff_rate_tau > 0 ? "税率相同时，出口依赖程度不同，暴露也不同。" : "这个国家未被模拟加税，所以 X 一直是 0。"}
              </span>
            </div>
            <div>
              <b>后面四步用它做什么</b>
              <span>把每个国家×行业的 X 当作解释变量，看贸易、生产、长度、网络四个指标（Y）随它怎样变化；结果都按“X 增加 1 个百分点”来读。</span>
            </div>
          </div>
        )}
        <p className="reg-boundary" role="note">
          设定：前两年税率为 0；模拟加税国家在后三年统一为 25%，未加税国家仍为 0。税率路径及生成值仅为教学模拟，不是现实政策，也不能据此作因果结论。
        </p>
        {sample && <p className="muted" role="note">
          后续回归使用全部 {sample.entities.toLocaleString("zh-CN")} 个国家×行业单元 × 5 年 = {sample.rows.toLocaleString("zh-CN")} 条记录，覆盖 {sample.countries} 个国家（{sample.taxed_countries} 国模拟加税、{sample.untaxed_countries} 国未加税）；你选的{selectedCountries.length === 2 ? "两个例子只是其中两行" : "例子只是其中一行"}。
        </p>}
      </section>
      <details className="technical-details">
        <summary>逐年读数 · {rows.length} 条</summary>
        <ScrollableRegion className="table-wrap bounded-data-table" label="所选例子的五年教学关税暴露表">
          <table className="data-table"><thead><tr><th>国家</th><th>行业</th><th>年份</th><th>冲击前出口份额 w</th><th>模拟税率 τ</th><th>关税暴露 X = w × τ</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.country}-${row.industry}-${row.year}`}><td>{countryLabel(row.country)}</td><td>{sectorLabel(row.industry)}</td><td>{row.year}</td><td>{(row.teaching_export_share_w * 100).toFixed(2)}%</td><td>{(row.teaching_tariff_rate_tau * 100).toFixed(2)}%</td><td><b>{(row.teaching_export_share_w * 100).toFixed(2)}% × {(row.teaching_tariff_rate_tau * 100).toFixed(2)}% = {(row.teaching_tariff_exposure * 100).toFixed(3)} 个百分点</b></td></tr>)}</tbody>
          </table>
        </ScrollableRegion>
      </details>
    </>}
  </div>;
}

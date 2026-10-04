import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { ScrollableRegion } from "../../a11y";
import { userFacingRequestError } from "../../user-facing-error";
import type { Meta, QuizCompletionState, Step, StepStateApi, TeachingPanelResponse } from "../../types";
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
  const countries = meta.countries.filter((code) => code !== "ROW");
  const savedCompared = state.data?.compared?.filter((code) => countries.includes(code)) ?? [];
  const defaultFirst = savedCompared[0] ?? (countries.includes("CAN") ? "CAN" : countries[0] ?? "");
  const defaultSecond = savedCompared.find((code) => code !== defaultFirst)
    ?? (defaultFirst !== "KOR" && countries.includes("KOR") ? "KOR" : countries.find((code) => code !== defaultFirst) ?? "");
  const [first, setFirst] = useState(defaultFirst);
  const [second, setSecond] = useState(defaultSecond);
  const [industry, setIndustry] = useState(
    state.data?.teaching_industry && meta.sectors.includes(state.data.teaching_industry)
      ? state.data.teaching_industry
      : meta.sectors.includes("C29") ? "C29" : meta.sectors[0] ?? "",
  );
  const selectedCountries = [first, second].filter(Boolean);
  const years = [...meta.years].sort((a, b) => a - b);
  const requestKey = `teaching-series:${selectedCountries.join(",")}:${industry}`;
  const query = useAsync<TeachingPanelResponse>(
    () => api.teachingSeries(selectedCountries, industry),
    [requestKey],
    { requestKey, enabled: selectedCountries.length === 2 && Boolean(industry) },
  );
  const panel = query.status === "success" ? query.data : null;

  useEffect(() => {
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
  }, [panel, first, second, industry]);

  const rows = useMemo(() => panel?.rows ?? [], [panel]);

  return <div className="shock-workbench">
    <section className="reg-run-card">
      <span className="reg-section-step">先认识两个变量</span>
      <h3>解释变量 X 与结果变量 Y</h3>
      <div className="reg-variable-plain-grid">
        <div><b>解释变量（X）</b><span>模拟关税暴露：不同国家和行业的模拟暴露强度。</span></div>
        <div><b>结果变量（Y）</b><span>步骤 11–14 分别检验贸易、生产、长度和网络指标是否随 X 变化。</span></div>
      </div>
      <div className="reg-boundary" role="note">
        X = 冲击前出口份额 w × 虚构关税税率 τ。税率路径及生成值仅为教学模拟，不是现实政策事实，也不能据此作因果结论。
      </div>
      <p>本版设定：前两年税率为 0；模拟加税国家在后三年统一为 10%，未加税国家仍为 0。同一国家、行业的出口份额固定，所以政策后三年的 X 保持不变，Y 仍会因扰动而变化。</p>
      <div className="reg-variable-plain-grid" role="group" aria-label="理解 X 的独立算例">
        <div><b>算一次：税率不等于暴露</b><span>假设出口份额为 25%，模拟税率为 20%，X = 0.25 × 0.20 = 0.05，即 5%。同样税率下，出口依赖程度不同，暴露也不同。</span></div>
        <div><b>读一次：什么是 1 个百分点？</b><span>X 从 5% 变为 6%，增加的是 1 个百分点，不是相对增加 1%。后四步都按“X 增加 1 个百分点”读结果。</span></div>
      </div>
      <p className="muted">以上是独立算例，不是下方所选国家的实际读数。</p>
      <p>先选择两个国家和一个行业，查看五年变化。后续四步会沿用这组对象帮助读图；正式计算仍使用完整国家×行业面板。</p>
      <div className="controls">
        <label className="model-control"><span className="model-control-label">国家 A</span>
          <select value={first} onChange={(event) => setFirst(event.target.value)}>
            {countries.filter((code) => code !== second).map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">国家 B</span>
          <select value={second} onChange={(event) => setSecond(event.target.value)}>
            {countries.filter((code) => code !== first).map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">行业</span>
          <select value={industry} onChange={(event) => setIndustry(event.target.value)}>
            {meta.sectors.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
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
    {panel && <>
      <section className="reg-section-card">
        <span className="reg-section-step">五年趋势 · 两国使用同一刻度</span>
        <IndicatorTrendChart
          rows={rows}
          countries={selectedCountries}
          years={years}
          metric="teaching_tariff_exposure"
          label="模拟关税暴露 X"
          unit="%"
        />
        <p className="muted">同一条模拟税率路径下，冲击前出口份额 w 不同，会形成不同的暴露 X。趋势仅帮助理解数据结构，不代表只用这两个国家计算回归。</p>
      </section>
      <p className="muted">{panel.disclaimer} · 当前显示 {rows.length} 条两国逐年读数。</p>
      <ScrollableRegion className="table-wrap bounded-data-table" label="两国五年教学关税暴露表">
        <table className="data-table"><thead><tr><th>国家</th><th>行业</th><th>年份</th><th>冲击前出口份额 w</th><th>虚构税率 τ</th><th>教学暴露 X = w × τ</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={`${row.country}-${row.industry}-${row.year}`}><td>{countryLabel(row.country)}</td><td>{sectorLabel(row.industry)}</td><td>{row.year}</td><td>{(row.teaching_export_share_w * 100).toFixed(2)}%</td><td>{(row.teaching_tariff_rate_tau * 100).toFixed(2)}%</td><td><b>{(row.teaching_export_share_w * 100).toFixed(2)}% × {(row.teaching_tariff_rate_tau * 100).toFixed(2)}% = {(row.teaching_tariff_exposure * 100).toFixed(3)} 个百分点</b></td></tr>)}</tbody>
        </table>
      </ScrollableRegion>
    </>}
  </div>;
}

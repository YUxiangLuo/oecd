import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { ScrollableRegion } from "../../a11y";
import { userFacingRequestError } from "../../user-facing-error";
import type { Meta, QuizCompletionState, Step, StepStateApi, TeachingPanelResponse } from "../../types";
import { countryLabel, sectorLabel } from "../../viz";
import { useAsync } from "../shared";

export interface ShockStepState extends QuizCompletionState, Record<string, unknown> {
  teaching_country?: string;
  teaching_year?: number;
  viewed_teaching_panel?: boolean;
  teaching_panel_version?: string;
}

/** 步骤 10 只介绍四个后续回归共同使用的虚构关税暴露 X。 */
export function ShockLab({ meta, step: _step, state }: {
  meta: Meta;
  step: Step;
  state: StepStateApi<ShockStepState>;
}) {
  const defaultCountry = meta.countries.find((code) => code !== "ROW") ?? meta.countries[0] ?? "";
  const savedCountry = state.data?.teaching_country;
  const [country, setCountry] = useState(
    typeof savedCountry === "string" && meta.countries.includes(savedCountry) && savedCountry !== "ROW"
      ? savedCountry
      : defaultCountry,
  );
  const savedYear = state.data?.teaching_year;
  const [year, setYear] = useState<number>(
    typeof savedYear === "number" && meta.years.includes(savedYear) ? savedYear : meta.years.at(-1) ?? 2020,
  );
  const requestKey = `teaching-panel:${country}:${year}`;
  const query = useAsync<TeachingPanelResponse>(() => api.teachingPanel(country, year), [requestKey], { requestKey });
  const panel = query.status === "success" ? query.data : null;

  useEffect(() => {
    if (!panel) return;
    state.save({
      teaching_country: country,
      teaching_year: year,
      viewed_teaching_panel: true,
      teaching_panel_version: panel.version,
    });
  }, [panel, country, year]);

  const rows = useMemo(() => panel?.rows ?? [], [panel]);

  return <div className="shock-workbench">
    <section className="reg-run-card">
      <h3>构造四个回归共同的 X：教学关税暴露</h3>
      <div className="reg-boundary" role="note">
        X = 冲击前出口份额 w × 虚构关税税率 τ。税率路径及生成值仅为教学模拟，不是现实政策事实，也不能据此作因果结论。
      </div>
      <p>步骤 11–14 都固定使用 <code>teaching_tariff_exposure</code>；改变的是 Y，而不是 X。</p>
      <div className="controls">
        <label className="model-control"><span className="model-control-label">国家</span>
          <select value={country} onChange={(event) => { setCountry(event.target.value); state.save({ teaching_country: event.target.value }); }}>
            {meta.countries.filter((code) => code !== "ROW").map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </label>
        <label className="model-control"><span className="model-control-label">年份</span>
          <select value={year} onChange={(event) => { const value = Number(event.target.value); setYear(value); state.save({ teaching_year: value }); }}>
            {meta.years.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
    </section>
    {query.status === "loading" && <div className="shock-panel-state shock-workbench-loading" role="status">正在读取教学关税面板…</div>}
    {query.status === "error" && <div className="error-box" role="alert">{userFacingRequestError(query.error, "教学关税面板读取失败")} <button className="secondary" onClick={query.retry}>重试</button></div>}
    {panel && <>
      <p className="muted">{panel.disclaimer} · 当前显示 {rows.length} 行（接口匹配 {panel.total} 行）。</p>
      <ScrollableRegion className="table-wrap bounded-data-table" label="教学关税暴露表">
        <table className="data-table"><thead><tr><th>国家</th><th>行业</th><th>年份</th><th>冲击前出口份额 w</th><th>虚构税率 τ</th><th>教学暴露 X = w × τ</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={`${row.country}-${row.industry}-${row.year}`}><td>{countryLabel(row.country)}</td><td>{sectorLabel(row.industry)}</td><td>{row.year}</td><td>{(row.teaching_export_share_w * 100).toFixed(2)}%</td><td>{(row.teaching_tariff_rate_tau * 100).toFixed(2)}%</td><td><b>{(row.teaching_export_share_w * 100).toFixed(2)}% × {(row.teaching_tariff_rate_tau * 100).toFixed(2)}% = {(row.teaching_tariff_exposure * 100).toFixed(3)} 个百分点</b></td></tr>)}</tbody>
        </table>
      </ScrollableRegion>
    </>}
  </div>;
}

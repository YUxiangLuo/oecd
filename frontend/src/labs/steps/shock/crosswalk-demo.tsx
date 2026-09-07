import { useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { CrosswalkHsRow, CrosswalkPayload } from "../../../types";
import { userFacingRequestError } from "../../../user-facing-error";
import { sectorLabel } from "../../../viz";
import { pct, useAsync } from "../../shared";
import { shockTypeLabel } from "./model";

const CROSSWALK_YEARS = [2018, 2019, 2020];
type CrosswalkTab = "summary" | "hs" | "icio";

function crosswalkRate(row: CrosswalkHsRow, year: number) {
  if (year === 2018) return row.rate_2018;
  if (year === 2020) return row.rate_2020;
  return row.rate_2019;
}

function CrosswalkContent({ selectedShockType }: { selectedShockType: string }) {
  const [year, setYear] = useState(2019);
  const [tab, setTab] = useState<CrosswalkTab>("summary");
  const { data, error } = useAsync<CrosswalkPayload>(() => api.crosswalkDemo(year), [year]);
  const mappedRows = data?.mapped_rows.slice(0, 10) ?? [];
  const tabs: { key: CrosswalkTab; label: string }[] = [
    { key: "summary", label: "映射摘要" },
    { key: "hs", label: "HS 清单样本" },
    { key: "icio", label: "ICIO 行业结果" },
  ];
  const selectTabByKeyboard = (current: CrosswalkTab, key: string) => {
    const currentIndex = tabs.findIndex((item) => item.key === current);
    const nextIndex = key === "Home" ? 0
      : key === "End" ? tabs.length - 1
        : key === "ArrowRight" ? (currentIndex + 1) % tabs.length
          : key === "ArrowLeft" ? (currentIndex - 1 + tabs.length) % tabs.length
            : -1;
    if (nextIndex < 0) return false;
    const next = tabs[nextIndex].key;
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`crosswalk-tab-${next}`)?.focus());
    return true;
  };

  return (
    <div className="crosswalk-content">
      {selectedShockType !== "tariff" && (
        <div className="crosswalk-scope-note">
          当前面板选择的是“{shockTypeLabel(selectedShockType)}”，不直接使用 HS 商品编码；下方保留虚构关税篮子的分类映射示例。
        </div>
      )}
      <div className="controls crosswalk-controls">
        <span className="field">
          <LabeledControl label="示例年份">
            {(id) => (
              <select id={id} value={year} onChange={(event) => setYear(Number(event.target.value))}>
                {CROSSWALK_YEARS.map((value) => <option key={value}>{value}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        {data && <span className="muted">HS6 {data.summary.n_hs_products} 个商品 → ICIO {data.summary.n_icio_sectors} 个商品相关行业</span>}
      </div>
      {error ? <div className="error-box" role="alert">{userFacingRequestError(error, "HS→ICIO 映射示例读取失败")}</div> : !data ? (
        <div className="shock-panel-state">正在读取 HS→ICIO 映射示例…</div>
      ) : (
        <>
          <div className="tipbox crosswalk-disclaimer">
            {data.disclaimer} 本篮子中加税商品覆盖 {pct(data.summary.demo_list_value_coverage)} 的示例贸易额；
            这里只解释编码转换，最终面板的维度、值域、日期与 treated 一致性在本步下方的「冲击数据质检」一并检查。
          </div>
          <p className="muted">按商品的生产活动对应行业，不能按它使用的钢材、电气部件等上游投入直接分摊。C26 示例同时保留加税芯片和未加税芯片的贸易额。</p>
          <div className="crosswalk-stats">
            <div><strong>{data.summary.n_hs_products}</strong><span>HS6商品</span></div>
            <div><strong>{data.summary.n_crosswalk_rows}</strong><span>商品归属映射</span></div>
            <div><strong>{data.summary.n_icio_sectors}</strong><span>商品相关ICIO行业</span></div>
            <div><strong>{data.checks.filter((check) => check.passed).length}/{data.checks.length}</strong><span>演示检查通过</span></div>
          </div>
          <div className="crosswalk-tabs" role="tablist" aria-label="HS 到 ICIO 映射详情">
            {tabs.map((item) => (
              <button
                key={item.key}
                id={`crosswalk-tab-${item.key}`}
                type="button"
                role="tab"
                tabIndex={tab === item.key ? 0 : -1}
                aria-selected={tab === item.key}
                aria-controls={`crosswalk-panel-${item.key}`}
                onClick={() => setTab(item.key)}
                onKeyDown={(event) => {
                  if (selectTabByKeyboard(item.key, event.key)) event.preventDefault();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === "summary" && (
            <div id="crosswalk-panel-summary" role="tabpanel" tabIndex={0} aria-labelledby="crosswalk-tab-summary" className="table-wrap scrollable-region">
              <table className="data-table crosswalk-table">
                <thead><tr><th>映射检查</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr></thead>
                <tbody>
                  {data.checks.map((check) => (
                    <tr key={check.name}>
                      <td>{check.name}</td>
                      <td className={check.passed ? "qc-pass" : "qc-fail"}>{check.passed ? "通过" : "异常"}</td>
                      <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                        {check.detail}
                        {check.warnings.map((warning) => <div key={warning} className="muted">{warning}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "hs" && (
            <div id="crosswalk-panel-hs" role="tabpanel" tabIndex={0} aria-labelledby="crosswalk-tab-hs" className="table-wrap scrollable-region">
              <table className="data-table crosswalk-table">
                <thead>
                  <tr><th>HS6商品</th><th>清单</th><th>贸易额权重</th><th>清单覆盖</th><th>{year} 税率</th><th style={{ textAlign: "left" }}>说明</th></tr>
                </thead>
                <tbody>
                  {data.hs_rows.map((row) => (
                    <tr key={row.hs_code}>
                      <td><a href={row.source_url} target="_blank" rel="noreferrer">{row.hs_code}</a></td><td>{row.list_name}</td><td>{pct(row.value_weight)}</td>
                      <td>{pct(row.coverage)}</td><td>{pct(crosswalkRate(row, year))}</td>
                      <td style={{ textAlign: "left", whiteSpace: "normal" }}>{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "icio" && (
            <div id="crosswalk-panel-icio" role="tabpanel" tabIndex={0} aria-labelledby="crosswalk-tab-icio" className="table-wrap scrollable-region">
              <table className="data-table crosswalk-table">
                <thead>
                  <tr><th>ICIO行业</th><th>本篮子行业平均税率</th><th>映射贸易权重</th><th>受影响权重</th><th style={{ textAlign: "left" }}>HS6商品（含未加税项）</th></tr>
                </thead>
                <tbody>
                  {mappedRows.map((row) => (
                    <tr key={row.icio_sector}>
                      <td title={row.icio_sector}>{sectorLabel(row.icio_sector)}</td>
                      <td>{pct(row.avg_tariff)}</td><td>{pct(row.mapped_value_weight)}</td><td>{pct(row.affected_value_weight)}</td>
                      <td style={{ textAlign: "left" }}>{row.top_hs_chapters}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function CrosswalkDemo({ selectedShockType }: { selectedShockType: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="shock-details crosswalk-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <div className="shock-section-title compact" role="heading" aria-level={3}>
          <span>3</span>
          <div><strong>关税清单如何从 HS 映射到 ICIO</strong><small>仅关税冲击直接适用 · 可查分类 × 虚构关税篮子</small></div>
        </div>
        <span className="shock-details-meta">技术细节 · 默认收起</span>
      </summary>
      {open && <CrosswalkContent selectedShockType={selectedShockType} />}
    </details>
  );
}

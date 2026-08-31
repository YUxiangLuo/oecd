import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { Meta, PagedRows, ShockSummary } from "../../../types";
import { userFacingRequestError } from "../../../user-facing-error";
import { countryLabel, sectorLabel } from "../../../viz";
import {
  SHOCK_FILTERS,
  SHOCK_FILTER_LABELS,
  SHOCK_SORTS,
  SHOCK_SORT_LABELS,
  SHOCK_TYPES,
  SHOCK_TYPE_LABELS,
  shockPanelRequestKey,
  shockSortChange,
  type ShockSort,
  type ShockType,
} from "./model";
import { Pager, pct, useAsync } from "../../shared";
import type { ShockPanelFilters } from "./model";
import { exposureSourceTeaching } from "./shock-contract";

const INTENSITY_COLUMN_LABELS: Record<ShockType, string> = {
  tariff: "加权关税冲击强度",
  sanctions: "制裁暴露强度",
  export_control: "出口管制暴露强度",
};

export function ShockPanelSuccessView({
  panel,
  shockType,
  typeLabel,
  definition,
  sort,
}: {
  panel: PagedRows;
  shockType: ShockType;
  typeLabel: string;
  definition: string;
  sort: ShockSort;
}) {
  const tariff = shockType === "tariff";
  const formula = tariff
    ? String(panel.rows.find((row) => row.formula)?.formula
      ?? "shock_intensity = Σ(事件双边行业平均加征税率 × 该国家–行业对加征方的出口份额)")
    : null;
  return (
    <>
      <div className="shock-table-scroll-cue" role="note">
        <span aria-hidden="true">↔</span> 左右滚动查看更多；国家和行业列保持固定。
      </div>
      <ScrollableRegion className="table-wrap" label="国家行业冲击面板表，可横向滚动">
        <table className={`data-table shock-panel-table${tariff ? " tariff" : ""}`}>
          <caption className="sr-only">国家行业冲击面板，当前排序：{SHOCK_SORT_LABELS[sort]}</caption>
          <thead>
            <tr>
              <th scope="col" aria-sort={sort === "country_asc" ? "ascending" : undefined} style={{ textAlign: "left" }}>国家</th>
              <th scope="col" aria-sort={sort === "industry_asc" ? "ascending" : undefined}>行业</th>
              <th scope="col" aria-sort={sort === "intensity_desc" ? "descending" : sort === "intensity_asc" ? "ascending" : undefined}>{INTENSITY_COLUMN_LABELS[shockType]}</th>
              {tariff && <><th scope="col">主要加征方</th><th scope="col">行业出口暴露度</th><th scope="col">暴露度来源</th></>}
              <th scope="col">超过课程阈值</th><th scope="col">宣布</th><th scope="col">生效</th><th scope="col" style={{ textAlign: "left" }}>主要事件 / 教学映射</th>
            </tr>
          </thead>
          <tbody>
            {panel.rows.map((row, index) => {
              const exposureSource = row.exposure_source == null
                ? null
                : exposureSourceTeaching(row.exposure_source);
              return (
              <tr key={`${row.country}-${row.sector}-${index}`}>
                <td style={{ textAlign: "left" }}>{countryLabel(String(row.country))}</td>
                <td>{sectorLabel(String(row.sector))}</td>
                <td>{typeof row.shock_intensity === "number" ? pct(row.shock_intensity) : "—"}</td>
                {tariff && <>
                  <td>{String(row.main_imposer ?? "—")}</td>
                  <td title={exposureSource?.disclosure}>
                    {typeof row.export_exposure === "number" ? pct(row.export_exposure) : "—"}
                  </td>
                  <td title={exposureSource?.disclosure}>
                    {exposureSource?.label ?? "—"}
                  </td>
                </>}
                <td>{row.treated === 1 ? "✓" : ""}</td>
                <td>{row.announced_date ?? "—"}</td>
                <td>{row.effective_date ?? "—"}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>{row.note ?? "—"}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollableRegion>
      <div className="tipbox shock-panel-note">
        <b>{typeLabel}定义：</b>{definition}
        {tariff && <> 只有关税类型使用加征方与国家–行业出口暴露度；分母是该行业全部跨境出口，不是国家总出口。<span className="tariff-formula">公式：{formula}</span></>}
        面板按冲击类型聚合全部已编码事件；左侧单个事件只用于定位。
      </div>
    </>
  );
}

export function ShockPanel({
  meta,
  filters,
  onChange,
}: {
  meta: Meta;
  filters: ShockPanelFilters;
  onChange: (patch: Partial<ShockPanelFilters>) => void;
}) {
  const releaseKey = meta.dataset?.release_id ?? "missing-release";
  const summaryKey = `${releaseKey}:shock-summary:${filters.shockType}`;
  const panelKey = shockPanelRequestKey(releaseKey, filters);
  const summaryQuery = useAsync<ShockSummary>(
    () => api.shockSummary(filters.shockType),
    [filters.shockType],
    { requestKey: summaryKey },
  );
  const panelQuery = useAsync<PagedRows>(
    () => api.shockPanel(
      filters.year,
      filters.shockType,
      filters.country,
      filters.sector,
      filters.filter,
      filters.sort,
      filters.page,
    ),
    [filters.year, filters.shockType, filters.country, filters.sector, filters.filter, filters.sort, filters.page],
    { requestKey: panelKey },
  );
  const { data: summary, error: summaryError, status: summaryStatus } = summaryQuery;
  const { data: panel, error: panelError, status: panelStatus } = panelQuery;
  const refreshing = panelStatus === "loading" || summaryStatus === "loading";
  const refreshAnnouncement = refreshing
    ? "正在按当前筛选读取冲击面板"
    : panelError || summaryError
      ? "当前筛选的冲击面板读取失败"
      : "当前筛选的冲击面板已更新";
  const summaryYear = summary?.years.find((row) => row.year === filters.year);
  const pages = panel ? Math.max(1, Math.ceil(panel.total / panel.page_size)) : 1;

  return (
    <div className="shock-panel-embedded" role="region" aria-label="国家–行业冲击面板">
      <div className="controls shock-panel-controls">
        <span className="field">
          <LabeledControl label="冲击类型">
            {(id) => (
              <select id={id} value={filters.shockType} onChange={(event) => onChange({ shockType: event.target.value, page: 1 })}>
                {SHOCK_TYPES.map((value) => <option key={value} value={value}>{SHOCK_TYPE_LABELS[value]}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="年份">
            {(id) => (
              <select id={id} value={filters.year} onChange={(event) => onChange({ year: Number(event.target.value), page: 1 })}>
                {meta.years.map((value) => <option key={value}>{value}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="国家">
            {(id) => (
              <select id={id} value={filters.country} onChange={(event) => onChange({ country: event.target.value, page: 1 })}>
                <option value="">全部</option>
                {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="行业">
            {(id) => (
              <select id={id} value={filters.sector} onChange={(event) => onChange({ sector: event.target.value, page: 1 })}>
                <option value="">全部</option>
                {meta.sectors.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="记录范围">
            {(id) => (
              <select id={id} value={filters.filter} onChange={(event) => onChange({ filter: event.target.value as ShockPanelFilters["filter"], page: 1 })}>
                {SHOCK_FILTERS.map((value) => <option key={value} value={value}>{SHOCK_FILTER_LABELS[value]}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="排序">
            {(id) => (
              <select id={id} value={filters.sort} onChange={(event) => onChange(shockSortChange(event.target.value as ShockSort))}>
                {SHOCK_SORTS.map((value) => <option key={value} value={value}>{SHOCK_SORT_LABELS[value]}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
      </div>

      {summaryError ? (
        <div className="error-box" role="alert">
          {userFacingRequestError(summaryError, "当前冲击类型的概览读取失败")}
          <button type="button" className="secondary" onClick={summaryQuery.retry}>按同一类型重试</button>
        </div>
      ) : summaryStatus === "loading" ? (
        <div className="shock-panel-summary" role="status">正在读取当前冲击类型的概览…</div>
      ) : (
        <div className="shock-panel-summary">
          <strong>{filters.year} 年 · {SHOCK_TYPE_LABELS[filters.shockType as ShockType] ?? filters.shockType}</strong>
          {summaryYear ? (
            <>
              <span>超过课程阈值：{summaryYear.treated_countries} 个经济体 / {summaryYear.treated_pairs} 个国家–行业</span>
              <span>非零强度：{summaryYear.nonzero_countries} 个经济体 / {summaryYear.nonzero_pairs} 个国家–行业</span>
              {summaryYear.max_shock > 0 && <span>最高 {pct(summaryYear.max_shock)}（{summaryYear.max_shock_target}）</span>}
            </>
          ) : <span className="muted">该年份没有概览记录。</span>}
        </div>
      )}

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {refreshAnnouncement}
      </span>
      {/* 定高区:行数在 1~25 之间跳变(每页 25 条),不锁高度整页会随联动上下弹。 */}
      <div className={`shock-panel-body${refreshing ? " refreshing" : ""}`} aria-busy={panelStatus === "loading"}>
      {panelError ? (
        <div className="error-box" role="alert">
          {userFacingRequestError(panelError, "当前筛选的冲击面板读取失败")}
          <button type="button" className="secondary" onClick={panelQuery.retry}>按同一筛选重试</button>
        </div>
      ) : panelStatus === "loading" || !panel ? (
        <div className="shock-panel-state">正在按当前条件读取冲击面板…</div>
      ) : panel.rows.length === 0 ? (
        <div className="shock-panel-state">
          <p>当前条件下没有记录。旧事件的国家或行业筛选可能不适用于当前冲击类型。</p>
          <div className="shock-empty-actions">
            {(filters.country || filters.sector) && (
              <button type="button" className="secondary" onClick={() => onChange({ country: "", sector: "", page: 1 })}>
                清除国家与行业
              </button>
            )}
            {filters.filter !== "all" && (
              <button type="button" className="secondary" onClick={() => onChange({ filter: "all", page: 1 })}>
                查看全部记录
              </button>
            )}
          </div>
        </div>
      ) : (
        <ShockPanelSuccessView
          panel={panel}
          shockType={filters.shockType as ShockType}
          typeLabel={summary?.type.label ?? SHOCK_TYPE_LABELS[filters.shockType as ShockType]}
          definition={summary?.type.definition ?? "正在读取当前冲击类型定义。"}
          sort={(panel.sort as ShockSort | undefined) ?? filters.sort}
        />
      )}
      {/* 事件联动常把口径收窄到单个国家×行业,定高后会空出一片。与其留白,
          不如把它变成"怎么看到完整范围"的引导——顺带点明左右两侧是同一套筛选。 */}
      {panel && panelStatus === "success" && panel.rows.length > 0 && panel.total <= panel.page_size && (
        <p className="shock-panel-hint">
          以上是当前口径下的全部 {panel.total} 条命中。想看这次冲击波及的完整范围,
          可把上方的「国家 / 行业」改回“全部”。
        </p>
      )}
      </div>

      {panel && panelStatus === "success" && panel.rows.length > 0 && (
        <Pager page={filters.page} pages={pages} total={panel.total} onChange={(page) => onChange({ page })} />
      )}
    </div>
  );
}

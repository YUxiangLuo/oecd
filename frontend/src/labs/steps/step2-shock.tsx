import { useMemo, useState } from "react";
import { api } from "../../api";
import { EvidencePanel } from "../../step-evidence";
import type { EvidenceRules, Meta, QcCheck, ShockEvent, Step, StepEvidenceApi } from "../../types";
import { countryLabel, sectorLabel } from "../../viz";
import { CrosswalkDemo } from "./step2/crosswalk-demo";
import { EventList } from "./step2/event-list";
import { eventKey, filtersForEvent, filtersMatchEvent, shockTypeLabel, type ShockPanelFilters } from "./step2/model";
import { SelectedEventBar } from "./step2/selected-event";
import { ShockPanel } from "./step2/shock-panel";
import { QcChecksTable } from "./qc-checks-table";
import { StepIntro } from "./viz/scaffold";
import { useAsync } from "../shared";

/** 步骤11:从政策事件到国家×行业冲击面板——左右并排、点事件即联动右侧冲击。 */
/** 第 11 步的学习证据:三类政策冲击各查看过至少一个具体事件。 */
interface ShockEvidence extends Record<string, unknown> {
  viewed_shock_types?: string[];
}

export function ShockLab({ meta, step, evidence, rules }: {
  meta: Meta;
  step: Step;
  evidence: StepEvidenceApi<ShockEvidence>;
  rules: EvidenceRules;
}) {
  const initialYear = meta.years.at(-1) ?? 2020;
  const [filters, setFilters] = useState<ShockPanelFilters>({
    year: initialYear,
    shockType: "tariff",
    country: "",
    sector: "",
    onlyHit: true,
    page: 1,
  });
  const [selectedEvent, setSelectedEvent] = useState<ShockEvent | null>(null);
  const { data: eventsResponse, error: eventsError } = useAsync(() => api.shockEvents(), []);
  // 冲击面板的专项质检随冲击一起放在回归前(本步),作为回归前的口径检查。
  const { data: shockChecks, error: shockQcError } = useAsync<QcCheck[]>(() => api.qcShocks(), []);
  const events = eventsResponse?.events ?? [];
  const selectedKey = selectedEvent ? eventKey(selectedEvent) : null;
  const expectedFilters = useMemo(
    () => (selectedEvent ? filtersForEvent(selectedEvent, meta, initialYear) : null),
    [initialYear, meta, selectedEvent],
  );
  const filtersDirty = expectedFilters ? !filtersMatchEvent(filters, expectedFilters) : false;

  const pickEvent = (event: ShockEvent) => {
    // 证据:这一类政策冲击的具体事件被真正打开过。累加而不是覆盖——
    // 三类冲击是分三次看的,整份覆盖会把前两次抹掉。
    const type = event.shock_type ?? filters.shockType;
    const viewed = evidence.data?.viewed_shock_types ?? [];
    if (type && !viewed.includes(type)) {
      evidence.save({ viewed_shock_types: [...viewed, type] });
    }
    setSelectedEvent(event);
    setFilters(filtersForEvent(event, meta, initialYear));
  };
  const updateFilters = (patch: Partial<ShockPanelFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const panelDesc = `${filters.year} · ${shockTypeLabel(filters.shockType)} · ${filters.country ? countryLabel(filters.country) : "全部经济体"} · ${filters.sector ? sectorLabel(filters.sector) : "全部行业"}`;

  return (
    <div className="shock-workbench">
      <StepIntro
        kicker={`步骤 ${step.n} · 回归设计与建模`}
        lead="回归前,先接入“外生的因”:政策冲击"
        concept={step.concept}
        todo={[
          "从左侧列表选一个政策事件(行内时间条给出宣布→生效时点),右侧即联动出它的国家×行业冲击",
          "关税 / 制裁 / 出口管制三类各看一个(留下证据)",
          "记住:这些冲击就是接下来第 12–15 步回归的处理变量",
        ]}
      />
      <EvidencePanel
        evidence={evidence}
        title={`本步要留下的证据:${rules.required_shock_types.map(shockTypeLabel).join("、")} 三类事件各打开一个`}
      />
      <div className="warnbox shock-disclaimer">
        ⚠ 拟真演示数据:以 2018–2020 全球贸易摩擦真实事件为原型手工编码(税率量级参考 PIIE/Bown),
        出口暴露度由真实 OECD ICIO 双边流向计算;覆盖 {meta.countries.length} 经济体 × {meta.sectors.length} 行业,不能用于研究结论。
      </div>

      {eventsError ? (
        <div className="error-box">政策事件读取失败:{eventsError}</div>
      ) : !eventsResponse ? (
        <div className="shock-panel-state">正在读取政策事件时间线…</div>
      ) : events.length === 0 ? (
        <div className="shock-panel-state">当前没有可展示的政策事件。</div>
      ) : (
        <>
          {/* 左右联动:左选事件 → 右看冲击。中间这条实时显示"选了谁 → 面板同步成什么",
              并展开该事件的完整档案(原"全部政策事件清单"表的信息收敛到这里)。 */}
          <SelectedEventBar event={selectedEvent} panelDesc={panelDesc} filtersDirty={filtersDirty} />

          <div className="shock-split">
            <div className="shock-split-left">
              <div className="shock-split-head"><span className="shock-split-num">①</span>选择政策事件</div>
              <p className="shock-split-hint">
                按三类冲击分组;每行的时间条是 ○ 宣布 → ● 生效(○ 解除)。所有行共用顶部年份刻度,
                因此可以横向比较:谁先发生、谁从宣布到生效拖得更久——这正是第 12–15 步事件研究要用的时点。
              </p>
              <EventList events={events} selectedKey={selectedKey} onSelect={pickEvent} />
            </div>
            <div className="shock-split-right">
              <div className="shock-split-head"><span className="shock-split-num">②</span>它造成的国家×行业冲击 <span className="muted">· 随左侧实时联动,也可手动调整</span></div>
              <ShockPanel meta={meta} filters={filters} onChange={updateFilters} />
            </div>
          </div>
        </>
      )}

      <details className="shock-details" style={{ marginBottom: 18 }}>
        <summary>
          <span>冲击数据质检 · 回归前的口径检查</span>
          <span className="shock-details-meta">
            {shockChecks ? `${shockChecks.length} 项 · ${shockChecks.filter((c) => !c.passed).length} 项异常` : "加载中"}
          </span>
        </summary>
        {shockQcError ? (
          <div className="error-box">{shockQcError}</div>
        ) : (
          <QcChecksTable rows={shockChecks} />
        )}
      </details>

      <CrosswalkDemo selectedShockType={filters.shockType} />
    </div>
  );
}

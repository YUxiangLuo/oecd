import { useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { Meta, ShockEvent } from "../../types";
import { CrosswalkDemo } from "./step2/crosswalk-demo";
import { EventCatalog } from "./step2/event-catalog";
import { EventTimeline } from "./step2/event-timeline";
import {
  eventKey,
  filtersForEvent,
  filtersMatchEvent,
  type ShockPanelFilters,
} from "./step2/model";
import { SelectedEventCard } from "./step2/selected-event-card";
import { ShockPanel } from "./step2/shock-panel";
import { useAsync } from "../shared";

/** 步骤2:从政策事件选择到国家×行业冲击面板，并按需查看 HS→ICIO 技术细节。 */
export function ShockLab({ meta }: { meta: Meta }) {
  const initialYear = meta.years.at(-1) ?? 2020;
  const [filters, setFilters] = useState<ShockPanelFilters>({
    year: initialYear,
    shockType: "关税冲击",
    country: "",
    sector: "",
    onlyHit: true,
    page: 1,
  });
  const [selectedEvent, setSelectedEvent] = useState<ShockEvent | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const { data: eventsResponse, error: eventsError } = useAsync(() => api.shockEvents(), []);
  const events = eventsResponse?.events ?? [];
  const selectedKey = selectedEvent ? eventKey(selectedEvent) : null;
  const expectedFilters = useMemo(
    () => selectedEvent ? filtersForEvent(selectedEvent, meta, initialYear) : null,
    [initialYear, meta, selectedEvent],
  );
  const filtersDirty = expectedFilters ? !filtersMatchEvent(filters, expectedFilters) : false;

  const pickEvent = (event: ShockEvent) => {
    setSelectedEvent(event);
    setFilters(filtersForEvent(event, meta, initialYear));
  };
  const updateFilters = (patch: Partial<ShockPanelFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="shock-workbench">
      <div className="warnbox shock-disclaimer">
        ⚠ 拟真演示数据：以2018–2020全球贸易摩擦真实事件为原型手工编码（税率量级参考 PIIE/Bown），
        出口暴露度由 OECD ICIO 双边流向计算；覆盖 {meta.countries.length} 个经济体 × {meta.sectors.length} 个行业，不能用于研究结论。
      </div>

      <section className="shock-workbench-section" aria-labelledby="shock-event-title">
        <div className="shock-section-title" id="shock-event-title" role="heading" aria-level={3}>
          <span>1</span>
          <div><strong>选择政策事件</strong><small>时间线展示宣布与生效日期；选择后会立即生成可见摘要并联动冲击面板。</small></div>
        </div>
        <SelectedEventCard
          event={selectedEvent}
          filters={filters}
          filtersDirty={filtersDirty}
          onViewPanel={() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
        {eventsError ? <div className="error-box">政策事件读取失败：{eventsError}</div> : !eventsResponse ? (
          <div className="shock-panel-state">正在读取政策事件时间线…</div>
        ) : events.length === 0 ? (
          <div className="shock-panel-state">当前没有可展示的政策事件。</div>
        ) : (
          <>
            <EventTimeline events={events} selectedKey={selectedKey} onSelect={pickEvent} />
            <EventCatalog events={events} selectedKey={selectedKey} onSelect={pickEvent} />
          </>
        )}
      </section>

      <ShockPanel meta={meta} filters={filters} onChange={updateFilters} sectionRef={panelRef} />
      <CrosswalkDemo selectedShockType={filters.shockType} />
    </div>
  );
}

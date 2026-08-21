import type { ShockEvent } from "../../../types";
import { sectorLabel } from "../../../viz";
import { pct } from "../../shared";
import { shockTypeColor, shockTypeLabel } from "./model";

/**
 * 左右联动之间的「已选事件」条:上半行说明"选了谁 → 面板同步成什么",
 * 下半区给出该事件的完整档案。
 *
 * 这里的字段(涉及行业 / 豁免 / 实体)原先散在一张"全部政策事件清单"表里——
 * 那张表把所有事件的所有字段又列了一遍,与列表和右侧面板大面积重复。现在只对
 * **当前选中的**事件展开,信息不丢,重复消失。
 */
export function SelectedEventBar({
  event,
  panelDesc,
  filtersDirty,
}: {
  event: ShockEvent | null;
  panelDesc: string;
  filtersDirty: boolean;
}) {
  if (!event) {
    return (
      <div className="shock-linkbar" role="status" aria-live="polite">
        <span className="muted">从左侧列表选一个政策事件，右侧会按事件时间、目标与行业定位教学暴露；下游回归仍按冲击类型汇总全部已编码事件。</span>
      </div>
    );
  }
  const color = shockTypeColor(event.shock_type);
  return (
    <div className="shock-linkbar active" role="status" aria-live="polite">
      <div className="shock-linkbar-head">
        <span className="shock-linkbar-tag" style={{ borderColor: color, color }}>
          {shockTypeLabel(event.shock_type)}
        </span>
        <b className="shock-linkbar-name">{event.name}</b>
        <span className="shock-linkbar-arrow">→</span>
        <span className="shock-linkbar-tag">{filtersDirty ? "面板(已微调)" : "面板已联动"}</span>
        <b className="shock-linkbar-panel">{panelDesc}</b>
      </div>
      <dl className="shock-selected-facts">
        <div><dt>发起方 → 目标</dt><dd>{event.imposer} → {event.targets}</dd></div>
        <div>
          <dt>宣布 → 生效</dt>
          <dd>{event.announced} → {event.effective}{event.removal ? `(解除 ${event.removal})` : ""}</dd>
        </div>
        <div>
          <dt>涉及行业</dt>
          <dd>{event.n_sectors} 个{event.top_sectors.length ? ` · ${event.top_sectors.map(sectorLabel).join("、")}` : ""}</dd>
        </div>
        {event.peak_rate > 0 && <div><dt>教学编码峰值</dt><dd>{pct(event.peak_rate)}（不是官方统计）</dd></div>}
        {event.exempt && <div><dt>豁免</dt><dd>{event.exempt}</dd></div>}
        {event.entities && <div><dt>实体</dt><dd>{event.entities}</dd></div>}
        {event.timeline_note && <div><dt>时间线说明</dt><dd>{event.timeline_note}</dd></div>}
        <div>
          <dt>事件 / 日期来源</dt>
          <dd>
            {event.source_status === "official_event_source"
              ? <>有官方事件来源：{event.source_urls.map((url, index) => (
                  <span key={url}>{index > 0 ? "、" : ""}<a href={url} target="_blank" rel="noreferrer">来源 {index + 1}</a></span>
                ))}</>
              : "没有逐项事件 URL；按未引证教学编码展示"}
          </dd>
        </div>
        <div><dt>行业 / 数值映射</dt><dd>{event.source_disclosure}</dd></div>
      </dl>
    </div>
  );
}

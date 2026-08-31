import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShockEvent } from "../../../types";
import { EventList } from "./event-list";
import { SelectedEventBar } from "./selected-event";

const event = (source: ShockEvent["source_status"]): ShockEvent => ({
  name: source === "official_event_source_complete" ? "有来源事件" : "教学或部分来源事件",
  shock_type: source === "official_event_source_complete" ? "tariff" : "sanctions",
  imposer: "USA",
  targets: "CHN",
  exempt: "",
  announced: "2020-01-01",
  effective: "2020-02-01",
  n_sectors: 1,
  top_sectors: ["C26"],
  peak_rate: 0.02,
  source_status: source,
  source_disclosure: "ICIO 行业映射与数值强度是未逐项引证的教学编码，不是官方统计。",
  source_urls: source === "teaching_encoding_no_event_source" ? [] : ["https://example.gov/event"],
});

describe("shock event provenance teaching", () => {
  test("event cards distinguish official event dates from uncited teaching encodings", () => {
    const events = [
      event("official_event_source_complete"),
      event("partial_official_event_source"),
      event("teaching_encoding_no_event_source"),
    ];
    const renderType = (activeType: string) => renderToStaticMarkup(createElement(EventList, {
      events,
      selectedKey: null,
      activeType,
      viewedTypes: ["tariff"],
      viewedEventCount: 1,
      onTypeChange: () => {},
      onSelect: () => {},
    }));
    const markup = renderType("tariff") + renderType("sanctions");
    expect(markup).toContain("事件/日期：官方来源覆盖完整");
    expect(markup).toContain("事件/日期：官方来源仅部分覆盖");
    expect(markup).toContain("事件/日期：未逐项引证的教学编码");
    expect(markup).toContain("教学峰值");
    expect(markup).toContain("已查看 1/2 个可选类型");
    expect(markup).toContain("政策冲击类型");
    expect(markup).toContain("出口管制 0");
    expect(markup).toContain("disabled");
    expect((markup.match(/tabindex="0"/g) ?? []).length).toBe(4);
  });

  test("selected facts separate URL-backed event facts from teaching numeric mapping", () => {
    const sourced = renderToStaticMarkup(createElement(SelectedEventBar, {
      event: event("official_event_source_complete"), panelDesc: "2020", filtersDirty: false,
    }));
    expect(sourced).toContain("官方来源覆盖该事件/日期主张");
    expect(sourced).toContain("https://example.gov/event");
    expect(sourced).toContain("行业 / 数值映射");
    expect(sourced).toContain("不是官方统计");

    const uncited = renderToStaticMarkup(createElement(SelectedEventBar, {
      event: event("teaching_encoding_no_event_source"), panelDesc: "2020", filtersDirty: false,
    }));
    expect(uncited).toContain("没有逐项事件 URL");
  });

  test("manual filters expose a direct restore action", () => {
    const markup = renderToStaticMarkup(createElement(SelectedEventBar, {
      event: event("official_event_source_complete"),
      panelDesc: "2020 · 全部经济体",
      filtersDirty: true,
      onRestore: () => {},
    }));
    expect(markup).toContain("自由筛选");
    expect(markup).toContain("恢复事件条件");
  });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IndicatorSchema, Meta, StepStateApi } from "../../../types";
import {
  IndicatorDataTable,
  IndicatorRequestBoundary,
  IndicatorTable,
  type IndicatorStepState,
} from "./indicator-table";

const noop = () => {};

function requestSurface(
  status: "idle" | "loading" | "success" | "error",
  options: { error?: string | null; empty?: boolean } = {},
) {
  return renderToStaticMarkup(
    <section>
      <label htmlFor="country">国家</label><select id="country"><option>中国</option></select>
      <label htmlFor="year">年份</label><select id="year"><option>2020</option></select>
      <IndicatorRequestBoundary
        status={status}
        error={options.error ?? null}
        loadingLabel="加载当前指标中…"
        empty={options.empty ?? false}
        onRetry={noop}
      >
        <div data-testid="old-count">共 999 条</div>
        <table><tbody><tr><td>旧国家行</td></tr></tbody></table>
        <div className="pager">旧分页器</div>
      </IndicatorRequestBoundary>
    </section>,
  );
}

describe("indicator request surfaces", () => {
  test("keeps controls mounted while loading and hides prior rows, count and pager", () => {
    const html = requestSurface("loading");
    expect(html).toContain("国家");
    expect(html).toContain("年份");
    expect(html).toContain('role="status"');
    expect(html).toContain("加载当前指标中");
    expect(html).not.toContain("旧国家行");
    expect(html).not.toContain("共 999 条");
    expect(html).not.toContain("旧分页器");
  });

  test("localizes a current-request error, offers retry and exposes no stale result", () => {
    const html = requestSurface("error", { error: "Failed to fetch" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("指标表加载失败：网络连接中断，请检查连接后重试。");
    expect(html).toContain("重试");
    expect(html).toContain("国家");
    expect(html).not.toContain("旧国家行");
    expect(html).not.toContain("旧分页器");
  });

  test("renders successful empty as status rather than loading and hides stale result", () => {
    const html = requestSurface("success", { empty: true });
    expect(html).toContain('role="status"');
    expect(html).toContain("没有行业指标数据");
    expect(html).not.toContain("加载当前指标中");
    expect(html).not.toContain("旧国家行");
    expect(html).not.toContain("旧分页器");
  });
});

describe("indicator table semantics", () => {
  test("names the current group and context, scopes every column, and provides a sticky country-industry row header", () => {
    const schema: IndicatorSchema = {
      groups: [{ key: "trade", label: "贸易分解", fields: ["FVA"] }],
      fields: {
        country: { label: "国家", format: "number", desc: "国家代码" },
        industry: { label: "行业", format: "number", desc: "行业代码" },
        year: { label: "年份", format: "number", desc: "指标年份" },
        FVA: { label: "外国增加值", format: "amount", desc: "金额" },
      },
    };
    const html = renderToStaticMarkup(
      <IndicatorDataTable
        groupLabel="贸易分解"
        schema={schema}
        columns={["country", "industry", "year", "FVA"]}
        rows={[{ country: "CHN", industry: "A", year: 2020, FVA: -12.5 }]}
        year={2020}
        country="CHN"
        page={2}
      />,
    );

    expect(html).toContain('<caption class="sr-only">贸易分解指标数据 · 2020 年 · CHN 中国 · 第 2 页</caption>');
    expect(html).toContain("<thead>");
    expect(html.match(/scope="col"/g)).toHaveLength(4);
    expect(html.match(/scope="row"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="国家 CHN 中国；行业 A');
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*style="position:sticky;left:0;z-index:2;background:#fff"[^>]*>CHN<\/th>/);
    expect(html).toContain("-12.5");
    expect(html).toContain("外国增加值 ⓘ");
  });
});

describe("network table sort scope", () => {
  const release = "a".repeat(32);
  const meta: Meta = { years: [2020], countries: ["CHN", "USA"], sectors: ["A"], dataset: { years: [2020], release_id: release } };
  const schema: IndicatorSchema = {
    groups: [{
      key: "network",
      label: "网络",
      fields: ["weighted degree", "betweenesscentrality", "degree", "indegree", "outdegree", "closnesscentrality"],
    }],
    fields: {},
  };
  const state: StepStateApi<IndicatorStepState> = {
    data: undefined,
    save: noop,
    complete: false,
    syncing: false,
    syncError: null,
    syncNow: noop,
  };

  test("labels and disables sorting in global paginated scope without claiming a global rank", () => {
    const html = renderToStaticMarkup(
      <IndicatorTable
        meta={meta}
        groupKey="network"
        schema={schema}
        state={state}
        year={2020}
        country=""
        page={1}
        interacted={false}
        onYear={noop}
        onCountry={noop}
        onPage={noop}
      />,
    );
    expect(html).toContain("行业排序（仅单国完整结果）");
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*>/);
    expect(html).toContain("全球范围按服务端分页顺序显示");
    expect(html).not.toContain("全球排名第");
    expect(html).toContain("国家");
    expect(html).toContain("年份");
    expect(html).toContain("报告材料 · 已记录 0/2 个国家");
    expect(html).toContain("系统会一次保存两个国家在同一年、同一指标下的数值");
    expect(html).toContain("比较国家 A");
    expect(html).toContain("比较国家 B");
    expect(html).toContain("保存两国同年比较");
    expect(html).toContain("尚未记录。点击一次即可完成本步报告材料");
  });

  test("enables the labelled native sorter only for an explicit country", () => {
    const html = renderToStaticMarkup(
      <IndicatorTable
        meta={meta}
        groupKey="network"
        schema={schema}
        state={state}
        year={2020}
        country="CHN"
        page={1}
        interacted={false}
        onYear={noop}
        onCountry={noop}
        onPage={noop}
      />,
    );
    expect(html).toContain("单国行业排序");
    expect(html).toContain("全正边二值介数（降序）");
    expect(html).toContain("加权总度（入+出；自环双计）");
    expect(html).toContain("完整行业结果在浏览器内排序");
    expect(html).not.toContain("行业排序（仅单国完整结果）");
  });

  test("shows captured progress and values without hiding the explicit mechanism", () => {
    const recordedState: StepStateApi<IndicatorStepState> = {
      ...state,
      data: {
        year: 2020,
        country: "USA",
        metric: "weighted degree",
        compared: ["CHN", "USA"],
        observations: [
          { entity: "CHN", country: "CHN", industry: "", year: 2020, value: 12, metric: "weighted degree", unit: "加权流量", release, scope: "country", source: "explicit-indicator-table-comparison" },
          { entity: "USA", country: "USA", industry: "", year: 2020, value: 9, metric: "weighted degree", unit: "加权流量", release, scope: "country", source: "explicit-indicator-table-comparison" },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <IndicatorTable
        meta={meta}
        groupKey="network"
        schema={schema}
        state={recordedState}
        year={2020}
        country="USA"
        page={1}
        interacted={false}
        onYear={noop}
        onCountry={noop}
        onPage={noop}
      />,
    );

    expect(html).toContain("报告材料 · 已记录 2/2 个国家");
    expect(html).toContain("2020 · CHN 中国 = 12");
    expect(html).toContain("2020 · USA 美国 = 9");
    expect(html).toContain("更新两国同年比较");
  });
});

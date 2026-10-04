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
    expect(html).toContain("选择“全部”时按默认顺序分页显示");
    expect(html).not.toContain("全球排名第");
    expect(html).toContain("国家");
    expect(html).toContain("年份");
    // The report material is recorded automatically next to the table, so the table has no save card.
    expect(html).not.toContain("保存两国同年比较");
    expect(html).not.toContain("比较国家 A");
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
    expect(html).toContain("排序只改变显示顺序，不改变指标数值");
    expect(html).not.toContain("行业排序（仅单国完整结果）");
  });

});

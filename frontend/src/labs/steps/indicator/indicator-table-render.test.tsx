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
        totalPages={3}
      />,
    );

    expect(html).toContain('<caption class="sr-only">贸易分解指标数据 · 2020 年 · CHN 中国 · 第 2 页</caption>');
    // A single-page table does not name a page the pager no longer shows.
    expect(renderToStaticMarkup(
      <IndicatorDataTable groupLabel="贸易分解" schema={schema} columns={["country"]} rows={[]} year={2020} country="CHN" page={1} />,
    )).toContain('<caption class="sr-only">贸易分解指标数据 · 2020 年 · CHN 中国</caption>');
    expect(html).toContain("<thead>");
    expect(html.match(/scope="col"/g)).toHaveLength(4);
    expect(html.match(/scope="row"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="国家 CHN 中国；行业 A');
    expect(html).toMatch(/<th[^>]*scope="row"[^>]*style="position:sticky;left:0;z-index:2;background:#fff"[^>]*>CHN 中国<\/th>/);
    // 行业 stays in view too, right after the (measured) country column, with the edge of the sticky block.
    expect(html).toMatch(/<td[^>]*style="position:sticky;left:0;z-index:2;background:#fff;box-shadow:inset -1px 0 #e8eaf0"[^>]*>A[^<]*<\/td>/);
    expect(html).toContain("-13");
    // The definition is a focusable ⓘ described by its text, not a hover-only title.
    expect(html).toMatch(/外国增加值<button type="button" class="column-info" aria-label="外国增加值的说明" aria-describedby="(column-info-[^"]+)"/);
    const tipId = html.match(/aria-describedby="(column-info-[^"]+)"/)![1];
    expect(html).toContain(`<span id="${tipId}" role="tooltip" class="sr-only">`);
    expect(html).not.toMatch(/<th[^>]*title="[^"]*外国增加值/);
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
    expect(html).toContain("行业排序（先选一个国家）");
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
    expect(html).toContain("按介数从高到低");
    expect(html).toContain("按加权总度从高到低");
    expect(html).toContain("排序只改变显示顺序，不改变指标数值");
    expect(html).not.toContain("行业排序（先选一个国家）");
  });

});

describe("undefined path metrics in the step 5 table (round 12)", () => {
  test("an isolated node reads 无连接，无法定义 for its distances, not 0, while its degree stays 0", () => {
    // LUX A03 2020: no links at all; the pipeline stores 0 for every distance metric.
    const html = renderToStaticMarkup(
      <IndicatorDataTable
        groupLabel="生产网络指标"
        schema={null}
        columns={["country", "industry", "year", "degree", "closnesscentrality", "Eccentricity", "harmonicclosnesscentrality"]}
        rows={[{ country: "LUX", industry: "A03", year: 2020, degree: 0, closnesscentrality: 0, Eccentricity: 0, harmonicclosnesscentrality: 0 }]}
        year={2020}
        country="LUX"
        page={1}
      />,
    );
    expect(html.match(/data-metric-undefined="true"/g)).toHaveLength(3);
    expect(html).toContain("无连接，无法定义");
    // The degree of an isolated node is a real zero.
    expect(html).toMatch(/<td>0<\/td>/);
  });
});

test("steps 2–5 tables use the compact cells that let step 5's nine columns fit at 1024 px", async () => {
  const html = renderToStaticMarkup(
    <IndicatorDataTable groupLabel="网络" schema={null} columns={["country", "industry"]} rows={[]} year={2020} country="CHN" page={1} />,
  );
  expect(html).toContain('<table class="data-table indicator-data-table">');
  const css = await Bun.file(new URL("./indicator-method.css", import.meta.url)).text();
  expect(css).toContain(".data-table.indicator-data-table th, .data-table.indicator-data-table td { padding-left: 8px; padding-right: 8px; }");
  expect(css).toContain(".data-table.indicator-data-table td.text-col { white-space: normal;");
});

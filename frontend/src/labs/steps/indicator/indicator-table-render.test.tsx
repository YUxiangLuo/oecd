import { describe, expect, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
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
    // 行业 and 年份 stay in view too, each right after the (measured) columns before it; 年份 carries the edge of the
    // sticky block, so no part of it slides under 行业 (round 21: a stray "0" of 2020 showed there).
    expect(html).toMatch(/<td[^>]*style="position:sticky;left:0;z-index:2;background:#fff"[^>]*>A[^<]*<\/td>/);
    expect(html).toMatch(/<td[^>]*style="position:sticky;left:0;z-index:2;background:#fff;box-shadow:inset -1px 0 #e8eaf0"[^>]*>2020<\/td>/);
    expect(html).toMatch(/<th[^>]*style="position:sticky;left:0;z-index:4;background:#fafbfd"[^>]*>年份/);
    expect(html).not.toMatch(/<td[^>]*style="[^"]*sticky[^"]*"[^>]*>-13/);
    expect(html).toContain("-13");
    // The definition is a focusable ⓘ described by its text, not a hover-only title.
    expect(html).toMatch(/外国增加值<button type="button" class="column-info" aria-label="外国增加值的说明" aria-describedby="(column-info-[^"]+)"/);
    const tipId = html.match(/aria-describedby="(column-info-[^"]+)"/)![1];
    expect(html).toContain(`<span id="${tipId}" role="tooltip" class="sr-only">`);
    expect(html).not.toMatch(/<th[^>]*title="[^"]*外国增加值/);
  });

  test("年份 sticks right after the measured 国家 and 行业 columns (round 21)", () => {
    const widths: Record<string, number> = { 国家: 92.5, 行业: 118 };
    const measure = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: widths[this.textContent ?? ""] ?? 0 } as DOMRect;
    });
    const schema: IndicatorSchema = {
      groups: [{ key: "network", label: "生产网络", fields: ["weighted degree"] }],
      fields: {
        country: { label: "国家", format: "number", desc: "" },
        industry: { label: "行业", format: "number", desc: "" },
        year: { label: "年份", format: "number", desc: "" },
        "weighted degree": { label: "加权总度", format: "amount", desc: "" },
      },
    };
    const view = render(
      <IndicatorDataTable groupLabel="生产网络" schema={schema} columns={["country", "industry", "year", "weighted degree"]}
        rows={[{ country: "JPN", industry: "G", year: 2020, "weighted degree": 982056 }]} year={2020} country="JPN" page={1} />,
    );
    const [, industryCell, yearCell, valueCell] = view.container.querySelectorAll("tbody tr > *");
    expect((industryCell as HTMLElement).style.left).toBe("92.5px");
    expect((yearCell as HTMLElement).style.left).toBe("210.5px");
    expect((yearCell as HTMLElement).style.position).toBe("sticky");
    expect((valueCell as HTMLElement).style.position).toBe("");
    measure.mockRestore();
    cleanup();
  });
});

describe("indicator table column widths", () => {
  test("a bracketed note in a column name goes on its own line, keeping the name's text in order", () => {
    const schema: IndicatorSchema = {
      groups: [],
      fields: {
        country: { label: "国家", format: "number", desc: "" },
        eigencentrality: { label: "特征向量中心性（软件近似）", format: "number", desc: "被重要节点连接的节点得分更高。" },
        degree: { label: "度", format: "number", desc: "" },
      },
    };
    const view = render(
      <IndicatorDataTable groupLabel="生产网络" schema={schema} columns={["country", "eigencentrality", "degree"]}
        rows={[{ country: "DEU", eigencentrality: 0.98, degree: 6377 }]} year={2020} country="DEU" page={1} />,
    );
    const header = view.getByRole("columnheader", { name: /特征向量中心性/ });
    expect(header.querySelector(".th-note")?.textContent?.startsWith("（软件近似）")).toBe(true);
    // The ⓘ ends the note's line.
    expect(header.querySelector(".th-note button")).toBeTruthy();
    expect(header.textContent?.startsWith("特征向量中心性（软件近似）")).toBe(true);
    expect(view.getByRole("columnheader", { name: "度" }).querySelector(".th-note")).toBeNull();
    cleanup();
  });

  test("the step table scrolls in a region that marks more columns on the right", async () => {
    const source = await Bun.file(new URL("./indicator-table.tsx", import.meta.url)).text();
    expect(source).toContain('className="table-wrap bounded-data-table indicator-table-scroll"');
    const css = await Bun.file(new URL("../../../workbench.css", import.meta.url)).text();
    expect(css).toMatch(/\.indicator-table-scroll \{[^}]*no-repeat local/);
    expect(css).toMatch(/\.indicator-data-table td\.text-col:nth-child\(2\) \{ min-width: 11em; \}/);
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
  test("an isolated node reads 到不了其他节点，无法定义 for its distances, not 0, while its degree stays 0", () => {
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
    expect(html).toContain("到不了其他节点，无法定义");
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

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShockPanel, ShockPanelSuccessView } from "./shock-panel";

describe("shock panel refresh accessibility", () => {
  test("keeps its live status outside the busy results container", () => {
    const markup = renderToStaticMarkup(createElement(ShockPanel, {
      meta: { years: [2020], countries: [], sectors: [] },
      filters: {
        year: 2020,
        shockType: "tariff",
        country: "",
        sector: "",
        filter: "all",
        sort: "intensity_desc",
        page: 1,
      },
      onChange: () => {},
    }));
    const statusStart = markup.indexOf('role="status"');
    const statusEnd = markup.indexOf("</span>", statusStart);
    const busyStart = markup.indexOf('aria-busy="true"');

    expect(statusStart).toBeGreaterThanOrEqual(0);
    expect(statusEnd).toBeLessThan(busyStart);
    expect(markup).toContain("正在按当前筛选读取冲击面板");
    expect(markup).toContain("排序");
    expect(markup).toContain("冲击强度：从高到低");
    expect(markup).toContain("冲击强度：从低到高");
    expect(markup).toContain("国家：A→Z");
    expect(markup).toContain("行业：A→Z");
    expect(markup).not.toContain("主要加征方");
  });

  test("renders type-specific successful tariff, sanctions, and export-control surfaces", () => {
    const panel = (row: Record<string, string | number | null>) => ({
      total: 1,
      page: 1,
      page_size: 25,
      rows: [{
        country: "CHN", sector: "C26", shock_intensity: 0.02, treated: 1,
        announced_date: "2019-01-01", effective_date: "2019-02-01", note: "教学事件",
        ...row,
      }],
    });
    const tariff = renderToStaticMarkup(createElement(ShockPanelSuccessView, {
      panel: panel({
        main_imposer: "USA", export_exposure: 0.2,
        exposure_source: "oecd_icio_bilateral_flow",
        formula: "shock_intensity = Σ(rate × exposure)",
      }),
      shockType: "tariff",
      typeLabel: "关税冲击",
      definition: "双边行业平均加征税率乘以出口暴露度。",
      sort: "intensity_desc",
    }));
    expect(tariff).toContain("加权关税冲击强度");
    expect(tariff).toContain("主要加征方");
    expect(tariff).toContain("出口暴露度");
    expect(tariff).toContain("当前排序：冲击强度：从高到低");
    expect(tariff).toContain("左右滚动查看更多；国家和行业列保持固定");
    expect(tariff).toContain("shock-panel-table tariff");
    expect(tariff).toContain('aria-sort="descending"');
    expect(tariff).toContain("公式：shock_intensity = Σ(rate × exposure)");

    const sanctions = renderToStaticMarkup(createElement(ShockPanelSuccessView, {
      panel: panel({}), shockType: "sanctions", typeLabel: "制裁清单",
      definition: "教学制裁实体映射强度，不是关税税率。", sort: "country_asc",
    }));
    expect(sanctions).toContain("制裁暴露强度");
    expect(sanctions).toContain("不是关税税率");
    expect(sanctions).toContain('<th scope="col" aria-sort="ascending" style="text-align:left">国家</th>');
    expect(sanctions).not.toContain("主要加征方");
    expect(sanctions).not.toContain("出口暴露度");
    expect(sanctions).not.toContain("公式：");

    const exportControl = renderToStaticMarkup(createElement(ShockPanelSuccessView, {
      panel: panel({}), shockType: "export_control", typeLabel: "出口管制",
      definition: "教学供应受限强度，不使用关税暴露度加权。", sort: "industry_asc",
    }));
    expect(exportControl).toContain("出口管制暴露强度");
    expect(exportControl).toContain("教学供应受限强度");
    expect(exportControl).toContain('<th scope="col" aria-sort="ascending">行业</th>');
    expect(exportControl).not.toContain("主要加征方");
    expect(exportControl).not.toContain("暴露度来源");
    expect(exportControl).not.toContain("公式：");
  });

  test("renders a structural-zero tariff row without an invalid exposure label", () => {
    const html = renderToStaticMarkup(createElement(ShockPanelSuccessView, {
      panel: {
        total: 1, page: 2, page_size: 25, sort: "intensity_desc",
        rows: [{
          country: "ROW", sector: "C99", shock_intensity: 0, treated: 0,
          announced_date: null, effective_date: null, note: null,
          main_imposer: null, export_exposure: null, exposure_source: null,
        }],
      },
      shockType: "tariff", typeLabel: "关税冲击",
      definition: "双边行业平均加征税率乘以出口暴露度。", sort: "intensity_desc",
    }));
    expect(html).not.toContain("来源无效（停止解释）");
    expect(html).toContain("ROW");
    expect(html).toContain("—");
  });
});

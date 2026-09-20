import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IndicatorTrendChart } from "./indicator-charts";
import {
  changeReading,
  indicatorMaterial,
  indicatorRows,
  materialComplete,
} from "./indicator-model";
import { LENGTH_TOPIC } from "./length";
import { PRODUCTION_TOPIC } from "./production";
import { TRADE_TOPIC } from "./trade";

describe("indicator data contract", () => {
  test("derives each share from its declared numerator and denominator", () => {
    const [row] = indicatorRows(
      [
        {
          country: "CHN",
          FVA: 20,
          gross_exports: 80,
          "3b_VA_GVC_C": 12,
          "3_VA_GVC": 30,
          SVA: 60,
          FGY: 300,
        },
      ],
      PRODUCTION_TOPIC,
    );
    expect(row["3b_VA_GVC_C_share"]).toBe(0.2);
    expect(row["3_VA_GVC_share"]).toBe(0.5);
    // Production's forward shares must not accidentally use the unequal FGY total.
    expect(row["3b_VA_GVC_C_share"]).not.toBe(12 / 300);
    expect(
      indicatorRows(
        [{ country: "CHN", FVA: 20, gross_exports: 80 }],
        TRADE_TOPIC,
      )[0].FVA_share,
    ).toBe(0.25);
  });

  test("a non-positive denominator produces missing, while finite negative readings are valid", () => {
    expect(
      indicatorRows(
        [{ country: "CHN", FVA: -2, gross_exports: 10 }],
        TRADE_TOPIC,
      )[0].FVA_share,
    ).toBe(-0.2);
    for (const gross_exports of [0, -10]) {
      expect(
        indicatorRows(
          [{ country: "CHN", FVA: 2, gross_exports }],
          TRADE_TOPIC,
        )[0].FVA_share,
      ).toBeNull();
    }
  });

  test("material preserves country/industry/year identity and requires exactly paired countries", () => {
    const rows = [
      { country: "CHN", industry: "A", year: 2020, PLv_GVC: 2 },
      { country: "USA", industry: "A", year: 2020, PLv_GVC: 3 },
      { country: "CHN", industry: "A", year: 2021, PLv_GVC: -1 },
      { country: "USA", industry: "A", year: 2021, PLv_GVC: 4 },
    ];
    const material = indicatorMaterial(
      rows,
      ["CHN", "USA"],
      [2020, 2021],
      ["PLv_GVC"],
      LENGTH_TOPIC,
      "A",
      "explicit-indicator-trend",
      "release",
    );
    expect(material[0]).toMatchObject({
      entity: "CHN·A",
      country: "CHN",
      industry: "A",
      year: 2020,
      scope: "country-industry",
      value: 2,
    });
    expect(
      materialComplete(material, ["CHN", "USA"], ["PLv_GVC"], true),
    ).toBeTrue();
    expect(
      materialComplete(material.slice(1), ["CHN", "USA"], ["PLv_GVC"], true),
    ).toBeFalse();
    expect(materialComplete(material, ["CHN"], ["PLv_GVC"], true)).toBeFalse();
  });

  test("share changes are percentage-point differences", () => {
    expect(changeReading(0.12, 0.2, "%")).toBe("+8 个百分点");
  });
});

describe("trend rendering", () => {
  test("does not connect across a missing year and retains negative points", () => {
    const html = renderToStaticMarkup(
      createElement(IndicatorTrendChart, {
        rows: [
          { country: "CHN", year: 2019, PLv_GVC: -1 },
          { country: "CHN", year: 2021, PLv_GVC: 3 },
        ],
        countries: ["CHN"],
        years: [2019, 2020, 2021],
        metric: "PLv_GVC",
        label: "前向",
        unit: "生产阶段（账户比值）",
      }),
    );
    expect(html).toContain("-1");
    expect(html).not.toContain("data-series=");
  });

  test("length position draws the GVCPs=1 baseline", () => {
    const html = renderToStaticMarkup(
      createElement(IndicatorTrendChart, {
        rows: [{ country: "CHN", year: 2020, GVCPs: 0.8 }],
        countries: ["CHN"],
        years: [2020],
        metric: "GVCPs",
        label: "位置",
        unit: "无量纲",
      }),
    );
    expect(html).toContain("位置基准 = 1");
  });

  test("names the two-country trend conclusion as a semantic group", () => {
    const html = renderToStaticMarkup(
      createElement(IndicatorTrendChart, {
        rows: [
          { country: "CHN", year: 2019, value: 1 },
          { country: "CHN", year: 2020, value: 2 },
          { country: "USA", year: 2019, value: 2 },
          { country: "USA", year: 2020, value: 3 },
        ],
        countries: ["CHN", "USA"],
        years: [2019, 2020],
        metric: "value",
        label: "示例指标",
        unit: "单位",
      }),
    );
    expect(html).toContain('class="comparison-summary" role="group" aria-label="两国趋势结论"');
  });
});

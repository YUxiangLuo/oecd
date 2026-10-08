import { describe, expect, test } from "bun:test";
import { compositionCards, gapReading, positioningCards, segmentCards } from "./reading-cards";
import { textNumber } from "./indicator-charts";

describe("段长度对照 cards name an undefined GVC length (round 12)", () => {
  const segments = [{ key: "gvc", label: "GVC 段", forward: "PLv_GVC", backward: "PLy_GVC" }];
  const reasonFor = (country: string, key: string) =>
    key === "PLy_GVC" || country === "LUX" ? `该行业没有这类 GVC 生产，${key} 无法计算（不是缺少数据）` : null;

  test("MLT B09: forward defined, backward undefined; LUX B09: neither", () => {
    const rows = [
      { country: "MLT", year: 2020, industry: "B09", PLv_GVC: 5.622, PLy_GVC: null },
      { country: "LUX", year: 2020, industry: "B09", PLv_GVC: null, PLy_GVC: null },
    ];
    const cards = segmentCards({ rows, countries: ["MLT", "LUX"], year: 2020, industry: "B09", segments, reasonFor });
    expect(cards[1].big).toBe("无法计算");
    expect(cards[1].small).toBe("该行业没有这类 GVC 生产，PLy_GVC 无法计算（不是缺少数据）");
    expect(cards[2].big).toBe("对比国家无法计算");
    expect(JSON.stringify(cards)).not.toContain("缺失");
  });
});

describe("amounts below 10 in reading texts keep three decimals (round 12)", () => {
  test("step 6 产品税减补贴 B05_06: a gap of 3.832 is not read as 4", () => {
    expect(gapReading(3.832, 0, "百万美元")).toBe("比它高 3.832 百万美元");
    expect(gapReading(0, 5.2, "百万美元")).toBe("比它低 5.200 百万美元");
    expect(gapReading(25, 12.6, "百万美元")).toBe("比它高 12 百万美元");
  });

  test("readings in cards: 3.4 reads 3.400, larger amounts stay whole, shares unchanged", () => {
    expect(textNumber(3.4, "百万美元")).toBe("3.400");
    expect(textNumber(-1.268, "百万美元")).toBe("-1.268");
    expect(textNumber(4279.4, "百万美元")).toBe("4,279");
    expect(textNumber(0, "百万美元")).toBe("0");
    expect(textNumber(0.1234, "%")).toBe("12.340%");
  });

  test("step 7 MLT H51: a negative total reads -1.268, as step 3 does", () => {
    const rows = [
      { country: "CHN", year: 2020, industry: "H51", SVA: 10, a: 6, b: 4 },
      { country: "MLT", year: 2020, industry: "H51", SVA: -1.2681, a: -0.6, b: -0.6681 },
    ];
    const cards = compositionCards({
      rows, countries: ["CHN", "MLT"], year: 2020, industry: "H51", totalLabel: "总增加值",
      composition: { total: "SVA", segments: [{ key: "a", name: "甲", color: "#000" }, { key: "b", name: "乙", color: "#111" }], note: "" },
    });
    expect(cards.at(-1)!.small).toContain("总量为负（-1.268 百万美元）");
  });

  test("定位图: a small x amount is not read as a whole number", () => {
    const [card] = positioningCards({
      reference: [{ country: "LUX", x: 3.21, y: 0.5 }], countries: ["LUX"], xKey: "x", yKey: "y",
      xLabel: "总出口", yLabel: "份额", xFormat: "amount", yFormat: "pct",
    });
    expect(String(card.big)).toContain("横轴 3.210");
  });
});

const cards = (points: [string, number, number][], countries = ["CHN"]) => positioningCards({
  reference: points.map(([country, x, y]) => ({ country, x, y })),
  countries, xKey: "x", yKey: "y", xLabel: "横轴指标", yLabel: "纵轴指标", xFormat: "number", yFormat: "number",
});

describe("定位图 reading cards", () => {
  test("a country on the median reads 等于中位数 once", () => {
    // Five distinct economies: CHN is the middle one on both axes.
    const [card] = cards([["USA", 1, 1], ["DEU", 2, 2], ["CHN", 3, 3], ["JPN", 4, 4], ["KOR", 5, 5]]);
    expect(card.big).toBe("横轴指标等于中位数，纵轴指标等于中位数");
  });

  test("economies that all share one reading are not compared with a median", () => {
    const economies = ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"];
    const [card] = cards(economies.map((country) => [country, 0, 0]));
    expect(card.small).toBe("图上 6 个经济体的读数相同，不比较中位数");
    expect(String(card.big)).not.toContain("中位数");
  });

  test("too few distinct readings among many economies are named as such", () => {
    const [card] = cards(["CHN", "USA", "DEU", "JPN", "KOR", "FRA"].map((country, i) => [country, i % 2, 0]));
    expect(card.small).toBe("图上 6 个经济体只有 2 个不同位置，不比较中位数");
  });
});

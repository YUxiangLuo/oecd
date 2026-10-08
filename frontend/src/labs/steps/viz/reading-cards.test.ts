import { describe, expect, test } from "bun:test";
import { positioningCards } from "./reading-cards";

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

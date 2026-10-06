import { describe, expect, test } from "bun:test";
import { partnerConcentration, partnerYears, regionMatrix } from "./trade-partners";

const edges = [
  { source: "CHN", target: "USA", flow: 100 },
  { source: "USA", target: "CHN", flow: 40 },
  { source: "CHN", target: "JPN", flow: 30 },
  { source: "CHN", target: "DEU", flow: 20 },
  { source: "CHN", target: "ROW", flow: 500 },
  { source: "DEU", target: "FRA", flow: 10 },
  { source: "CHN", target: "KOR", flow: null },
];

describe("trade partners data layer", () => {
  test("partners per year are sorted by two-way flow and the concentration is the top partners' share", () => {
    const [year] = partnerYears([{ year: 2020, data: { nodes: [], edges } }]);
    expect(year.partners.CHN.map((partner) => partner.c)).toEqual(["ROW", "USA", "JPN", "DEU"]);
    expect(year.partners.CHN[1]).toMatchObject({ inflow: 40, outflow: 100, total: 140 });
    // Top-5 share of a four-partner list is 100%; the top-2 share is (500 + 140) / 690.
    expect(partnerConcentration(year.partners.CHN)).toBe(1);
    expect(partnerConcentration(year.partners.CHN, 2)).toBeCloseTo(640 / 690, 6);
    expect(partnerConcentration(undefined)).toBeNull();
    expect(partnerConcentration([])).toBeNull();
  });

  test("the region matrix sums seller→buyer flows by region and leaves ROW and invalid flows out", () => {
    const matrix = regionMatrix(edges);
    // East Asia (CHN, JPN) and the Americas (USA): CHN→USA 100 goes to row 0, column 3; USA→CHN 40 the other way.
    expect(matrix[0][3]).toBe(100);
    expect(matrix[3][0]).toBe(40);
    // CHN→JPN stays inside East Asia; Europe→Europe keeps DEU→FRA.
    expect(matrix[0][0]).toBe(30);
    expect(matrix[2][2]).toBe(10);
    expect(matrix.flat().reduce((sum, value) => sum + value, 0)).toBe(200);
  });
});

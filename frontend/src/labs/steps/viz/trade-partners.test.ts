import { describe, expect, test } from "bun:test";
import { partnerConcentration, partnerYears, regionMatrix, TradePartners } from "./trade-partners";
import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { api } from "../../../api";

test("partner diagram describes directional stroke widths in both its visible key and accessible label", async () => {
  const original = api.network;
  api.network = async () => ({ nodes: [], edges });
  try {
    const view = render(createElement(TradePartners, { meta: { years: [2020], countries: ["CHN"], sectors: [] }, countries: ["CHN"], year: 2020, onYear: () => {} }));
    await waitFor(() => expect(view.container.querySelector(".ego-network-key")?.textContent).toContain("线宽 = 各方向流量"));
    const diagram = view.getByRole("img", { name: /贸易伙伴的关系图/ });
    expect(diagram.getAttribute("aria-label")).toContain("线宽表示各方向流量");
    const strokes = diagram.querySelector('[data-partner="USA"]')!.querySelectorAll("line");
    expect(Number(strokes[0].getAttribute("stroke-width"))).toBe(10);
    expect(Number(strokes[1].getAttribute("stroke-width"))).toBeCloseTo(4.6);
    const oneWay = diagram.querySelector('[data-partner="JPN"]')!;
    expect(oneWay.querySelectorAll("line[marker-end]")).toHaveLength(1);
    expect(oneWay.querySelector("line")?.getAttribute("marker-end")).toBe("url(#ego-out-CHN)");
    expect(oneWay.getAttribute("aria-label")).toContain("流入 0");
  } finally {
    cleanup();
    api.network = original;
  }
});

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
    // ROW is left out before partners are ranked.
    expect(year.partners.CHN.map((partner) => partner.c)).toEqual(["USA", "JPN", "DEU"]);
    expect(year.partners.CHN[0]).toMatchObject({ inflow: 40, outflow: 100, total: 140 });
    // Top-5 share of a three-partner list is 100%; the top-2 share is (140 + 30) / 190.
    expect(partnerConcentration(year.partners.CHN)).toBe(1);
    expect(partnerConcentration(year.partners.CHN, 2)).toBeCloseTo(170 / 190, 6);
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

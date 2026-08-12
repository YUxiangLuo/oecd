import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShockPanel } from "./shock-panel";

describe("shock panel refresh accessibility", () => {
  test("keeps its live status outside the busy results container", () => {
    const markup = renderToStaticMarkup(createElement(ShockPanel, {
      meta: { years: [2020], countries: [], sectors: [] },
      filters: {
        year: 2020,
        shockType: "tariff",
        country: "",
        sector: "",
        onlyHit: false,
        page: 1,
      },
      onChange: () => {},
    }));
    const statusStart = markup.indexOf('role="status"');
    const statusEnd = markup.indexOf("</span>", statusStart);
    const busyStart = markup.indexOf('aria-busy="true"');

    expect(statusStart).toBeGreaterThanOrEqual(0);
    expect(statusEnd).toBeLessThan(busyStart);
    expect(markup).toContain("正在刷新冲击面板");
  });
});

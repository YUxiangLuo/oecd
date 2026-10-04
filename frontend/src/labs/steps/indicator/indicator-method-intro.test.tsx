import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IndicatorMethodIntro, type MethodTopic } from "./indicator-method-intro";
import { INDICATOR_READINGS } from "./indicator-reading-library";

const render = (topic: MethodTopic) => new DOMParser().parseFromString(
  renderToStaticMarkup(<IndicatorMethodIntro topic={topic} />), "text/html",
);

describe("indicator method intro", () => {
  test("each step explains the method in three linked steps and states the same headline formula as the decomposition", () => {
    const formulas: Record<MethodTopic, string> = {
      trade: "外国增加值项占比 = FVA ÷ 总出口",
      production: "复杂 GVC 生产份额 = 3b_VA_GVC_C ÷ SVA",
      length: "GVCPs = PLv_GVC ÷ PLy_GVC",
    };
    for (const topic of ["trade", "production", "length"] as MethodTopic[]) {
      const dom = render(topic);
      const steps = dom.querySelectorAll(".method-steps li");
      expect(steps).toHaveLength(3);
      // Every step cites a document shipped with the course, opened in a new tab.
      const files = INDICATOR_READINGS[topic].map((reading) => reading.file);
      for (const step of steps) {
        const link = step.querySelector("a");
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(files.some((file) => link?.getAttribute("href")?.endsWith(`readings/${file}`))).toBe(true);
      }
      expect(dom.querySelector(".method-formula")?.textContent).toContain(formulas[topic]);
      // The reading library is part of the method section rather than a separate block at the page end.
      expect(dom.querySelector(".method-intro .indicator-reading-library")).toBeTruthy();
    }
  });

  test("length method keeps the boundary that length is not the number of border crossings", () => {
    expect(render("length").body.textContent).toContain("长度不是跨境次数");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INDICATOR_READINGS, IndicatorReadingLibrary } from "./indicator-reading-library";

afterEach(cleanup);

describe("indicator PDF reading library", () => {
  test("provides at least one replaceable PDF for every indicator step and demonstrates multiple documents", () => {
    expect(Object.keys(INDICATOR_READINGS).sort()).toEqual(["length", "network", "production", "trade"]);
    expect(Object.values(INDICATOR_READINGS).every((readings) => readings.length > 0)).toBe(true);
    expect(INDICATOR_READINGS.trade.length).toBeGreaterThan(1);
    for (const reading of Object.values(INDICATOR_READINGS).flat()) {
      expect(reading.file.endsWith(".pdf")).toBe(true);
      expect(reading.authors).not.toBe("");
      expect(reading.year).toBeGreaterThan(1900);
      expect(reading.publication).not.toBe("");
      const header = readFileSync(resolve(import.meta.dir, "../../../../public/readings", reading.file), { encoding: "utf8", flag: "r" }).slice(0, 5);
      expect(header).toBe("%PDF-");
    }
  });

  test("does not load the embedded PDF until opened, then switches one preview without removing open-PDF access", () => {
    const view = render(<IndicatorReadingLibrary topic="trade" />);
    const details = view.container.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(view.queryByLabelText(/PDF 预览/)).toBeNull();
    expect(view.getByText("2 篇 PDF · 可选阅读，不影响本步完成")).toBeTruthy();

    act(() => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    expect(view.getByLabelText("总出口分解与外国增加值占比 PDF 预览").getAttribute("data"))
      .toContain("demo-trade-decomposition.pdf#view=FitH");
    expect(view.getByRole("link", { name: /新标签页打开 PDF/ }).getAttribute("target")).toBe("_blank");
    expect(view.getByText(/如果预览空白或加载失败/)).toBeTruthy();
    expect(view.getByText("当前浏览器无法内嵌显示这份 PDF。")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /占比指标的国家比较与解释边界/ }));
    expect(view.getByLabelText("占比指标的国家比较与解释边界 PDF 预览").getAttribute("data"))
      .toContain("demo-share-interpretation.pdf#view=FitH");
    expect(view.queryByLabelText("总出口分解与外国增加值占比 PDF 预览")).toBeNull();
    expect(view.getAllByText("课程项目组（示范） · 2026 · 界面占位材料").length).toBeGreaterThanOrEqual(2);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INDICATOR_READINGS, IndicatorReadingLibrary } from "./indicator-reading-library";

afterEach(cleanup);

describe("indicator PDF reading library", () => {
  test("provides the corrected guide and source materials for every indicator step", () => {
    expect(Object.keys(INDICATOR_READINGS).sort()).toEqual(["length", "network", "production", "trade"]);
    expect(INDICATOR_READINGS.trade.length).toBe(4);
    expect(INDICATOR_READINGS.production.length).toBe(3);
    expect(INDICATOR_READINGS.length.length).toBe(3);
    expect(INDICATOR_READINGS.network.length).toBe(4);
    for (const reading of Object.values(INDICATOR_READINGS).flat()) {
      expect(reading.file.endsWith(".pdf")).toBe(true);
      expect(reading.authors).not.toBe("");
      if (reading.year !== null) expect(reading.year).toBeGreaterThan(1900);
      expect(reading.publication).not.toBe("");
      const header = readFileSync(resolve(import.meta.dir, "../../../../public/readings", reading.file), { encoding: "utf8", flag: "r" }).slice(0, 5);
      expect(header).toBe("%PDF-");
    }
  });

  test("opens by default with one preview, unloads it when collapsed, and switches one preview without removing open-PDF access", () => {
    const view = render(<IndicatorReadingLibrary topic="trade" />);
    const details = view.container.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(true);
    expect(view.getByLabelText("总贸易流分解指标说明（课程校订版） PDF 预览")).toBeTruthy();
    act(() => {
      details.open = false;
      fireEvent(details, new Event("toggle"));
    });
    expect(view.queryByLabelText(/PDF 预览/)).toBeNull();
    expect(view.getByText("4 篇 PDF · 课程说明、原始方法资料与论文")).toBeTruthy();
    expect(view.getByText(/OECD ICIO 2023 版，2016–2020 年/)).toBeTruthy();
    expect(view.getByText(/原始资料里的年份和编号与本课程不同/)).toBeTruthy();

    act(() => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    expect(view.getByLabelText("总贸易流分解指标说明（课程校订版） PDF 预览").getAttribute("data"))
      .toContain("trade-decomposition-guide.pdf#view=FitH");
    expect(view.getByRole("link", { name: /新标签页打开 PDF/ }).getAttribute("target")).toBe("_blank");
    expect(view.getByText(/如果预览空白或加载失败/)).toBeTruthy();
    expect(view.getByText("当前浏览器无法内嵌显示这份 PDF。")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /双边总贸易流分解指标构建/ }));
    expect(view.getByLabelText("双边总贸易流分解指标构建 PDF 预览").getAttribute("data"))
      .toContain("source-trade-decomposition-note.pdf#view=FitH");
    expect(view.queryByLabelText("总贸易流分解指标说明（课程校订版） PDF 预览")).toBeNull();
    expect(view.getAllByText("原始资料 · 年份未标注 · 方法说明（历史资料）").length)
      .toBeGreaterThanOrEqual(2);
  });
});

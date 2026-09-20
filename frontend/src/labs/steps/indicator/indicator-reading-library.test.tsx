import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INDICATOR_DATA_ATTACHMENTS,
  INDICATOR_READINGS,
  IndicatorReadingLibrary,
} from "./indicator-reading-library";

afterEach(cleanup);

describe("indicator PDF reading library", () => {
  test("provides the corrected guide and employer materials for every indicator step", () => {
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
    expect(Object.keys(INDICATOR_DATA_ATTACHMENTS).sort()).toEqual(["length", "network", "production", "trade"]);
    for (const attachment of Object.values(INDICATOR_DATA_ATTACHMENTS)) {
      const file = Bun.file(resolve(import.meta.dir, "../../../../public/readings", attachment.file));
      expect(file.size).toBeGreaterThan(0);
    }
  });

  test("does not load the embedded PDF until opened, then switches one preview without removing open-PDF access", () => {
    const view = render(<IndicatorReadingLibrary topic="trade" />);
    const details = view.container.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(view.queryByLabelText(/PDF 预览/)).toBeNull();
    expect(view.getByText("4 篇 PDF · 可选阅读，不影响本步完成")).toBeTruthy();
    const dataLink = view.getByRole("link", { name: /下载双边总贸易流分解历史指标表/ });
    expect(dataLink.getAttribute("href")).toContain("trade-historical-indicators-1995-2018.xlsx");
    expect(dataLink.hasAttribute("download")).toBe(true);
    expect(view.getByText(/不替换本课程当前 OECD ICIO 2023 数据/)).toBeTruthy();

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
      .toContain("employer-trade-decomposition-note.pdf#view=FitH");
    expect(view.queryByLabelText("总贸易流分解指标说明（课程校订版） PDF 预览")).toBeNull();
    expect(view.getAllByText("委托方提供 · 年份未标注 · 原始说明（DOCX 转 PDF）").length)
      .toBeGreaterThanOrEqual(2);
  });
});

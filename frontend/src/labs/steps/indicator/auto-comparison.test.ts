import { describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta } from "../../../types";
import { autoMaterialCountry, materialMatches, useAutoMaterial } from "./auto-comparison";
import { indicatorMaterialPatch } from "./indicator-table";

const meta = { countries: ["ARG", "CHN", "DEU", "ROW", "USA"] } as unknown as Meta;

describe("steps 2–5 automatic report material", () => {
  test("records the country being viewed, or China before the student picks one", () => {
    expect(autoMaterialCountry(meta, "DEU")).toBe("DEU");
    expect(autoMaterialCountry(meta, "USA")).toBe("USA");
    // No explicit choice yet: the decomposition defaults to China.
    expect(autoMaterialCountry(meta, "")).toBe("CHN");
  });

  test("records one country's reading for the year, marked as automatic, with no comparison country", () => {
    const rows = [
      { country: "CHN", FVA_share: 0.1173 },
      { country: "USA", FVA_share: 0.0551 },
    ];
    const patch = indicatorMaterialPatch(rows, "CHN", 2020, "FVA_share", "%", "rel-1");
    expect(patch).toEqual({
      year: 2020,
      country: "CHN",
      compared: ["CHN"],
      metric: "FVA_share",
      observations: [{
        entity: "CHN", country: "CHN", industry: "", year: 2020, value: 0.1173,
        metric: "FVA_share", unit: "%", release: "rel-1", scope: "country", source: "auto-indicator-comparison",
      }],
    });
  });
});

describe("matching saved material to the current selection", () => {
  test("ignores key order from the server but notices a different country", () => {
    const rows = [{ country: "ARG", GVCPs: 0.953 }, { country: "PRT", GVCPs: 0.992 }, { country: "USA", GVCPs: 1.002 }];
    const patch = indicatorMaterialPatch(rows, "ARG", 2020, "GVCPs", "无量纲", "rel-1");
    const reordered = JSON.parse(JSON.stringify(patch), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value);
    expect(materialMatches(patch, reordered)).toBe(true);
    const usa = indicatorMaterialPatch(rows, "USA", 2020, "GVCPs", "无量纲", "rel-1");
    expect(materialMatches(patch, usa ?? undefined)).toBe(false);
    expect(materialMatches(null, reordered)).toBe(false);
  });
});

describe("automatic material status line", () => {
  const status = async (observations: unknown[], stateExtra: Record<string, unknown> = {}, propsExtra: Record<string, unknown> = {}) => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AutoMaterialStatus } = await import("./auto-comparison");
    const props = {
      state: { data: { observations }, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {}, ...stateExtra },
      schema: { groups: [], fields: { FVA_share: { label: "外国增加值项占比", format: "pct" } } },
      metric: "FVA_share", loadFailed: false, where: "上方所选国家", ...propsExtra,
    };
    return (current: boolean) => renderToStaticMarkup(createElement(AutoMaterialStatus, { ...props, current } as never));
  };
  const reading = (country: string, value: number) => ({
    entity: country, country, industry: "", year: 2020, value, metric: "FVA_share",
    unit: "%", release: "rel-1", scope: "country" as const, source: "auto-indicator-comparison" as const,
  });

  test("shows the one recorded reading and no comparison country", async () => {
    const render = await status([reading("CHN", 0.1173)]);
    const html = render(true);
    // The shared card: title, chip, one summary sentence and the how-line; no bespoke heading.
    expect(html).toContain('class="material-card material-card--recorded"');
    expect(html).toContain('<span class="material-chip material-chip--recorded">已记录</span>');
    expect(html).not.toContain("报告材料 · 自动记录");
    expect(html).toContain('<p class="material-card-summary" role="status">2020 年外国增加值项占比（国家整体）：CHN 中国 11.730%</p>');
    expect(html).toContain("记录上方所选国家同一年的外国增加值项占比（国家整体），随国家或年份的选择自动记录，无需另外保存。");
    expect(html).not.toContain("material-card-action");
    expect(html).not.toContain("对比国家");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("（默认）");
    // A saved record from an earlier selection is not shown as if it matched the current one.
    const stale = render(false);
    expect(stale).not.toContain("CHN 中国 11.730%");
    expect(stale).toContain('class="material-card material-card--missing"');
    expect(stale).toContain(">尚未记录</span>");
    expect(stale).toContain("正在记录当前选择…");
  });
});

test("after 改用当前选择 on a submitted report, the line says to update the report on step 15", async () => {
  const { AutoMaterialStatus } = await import("./auto-comparison");
  const { fireEvent, screen } = await import("@testing-library/react");
  const state = { data: { observations: [{ country: "CHN", year: 2020, metric: "FVA_share", value: 0.1173, unit: "%" }] }, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {}, materialLocked: true } as never;
  const props = (current: boolean, record?: () => void) => ({ state, schema: null, metric: "FVA_share", current, record, loadFailed: false, where: "上方所选国家" });
  const view = render(createElement(AutoMaterialStatus, props(false, () => {})));
  expect(view.container.textContent).not.toContain("请到步骤 15");
  fireEvent.click(screen.getByRole("button", { name: "改用当前选择作为报告材料（之后需在步骤 15 更新报告）" }));
  view.rerender(createElement(AutoMaterialStatus, props(true)));
  const how = view.container.querySelector(".material-card-how")!.textContent;
  expect(how).toContain("报告已提交：浏览不再自动改动报告材料。请到步骤 15 更新报告并重新提交给老师。");
  // Once the choice is recorded, the card offers no further button.
  expect(view.container.querySelector(".material-card-action")).toBeNull();
  cleanup();
});

test("a label that ends in a bracket takes 国家整体 inside it: one pair, not two back to back", async () => {
  const { countryScope } = await import("./auto-comparison");
  expect(countryScope("GVC 位置指数（前向 GVC 段／后向 GVC 段）")).toBe("GVC 位置指数（前向 GVC 段／后向 GVC 段，国家整体）");
  expect(countryScope("外国增加值项占比")).toBe("外国增加值项占比（国家整体）");
});

describe("recording under the report lock", () => {
  test("automatic saves clear the choice marker; a save on request after submission sets it", async () => {
    const rows = spyOn(api, "countryIndicators").mockResolvedValue([
      { country: "CHN", FVA_share: 0.1173 },
      { country: "USA", FVA_share: 0.0551 },
    ] as never);
    const metaWithRelease = { countries: ["CHN", "USA"], dataset: { release_id: "rel-1" } } as unknown as Meta;
    const run = async (materialLocked: boolean) => {
      const saves: Record<string, unknown>[] = [];
      let record: (() => void) | undefined;
      const Probe = () => {
        const auto = useAutoMaterial({
          topic: "trade", meta: metaWithRelease, country: "CHN", year: 2020,
          schema: { status: "success", data: { groups: [], fields: { FVA_share: { format: "pct" } } } as never },
          state: { data: undefined, save: (patch: Record<string, unknown>) => { saves.push(patch); }, complete: false, syncing: false, syncError: null, syncNow: () => {}, materialLocked } as never,
        });
        record = auto.record;
        return null;
      };
      render(createElement(Probe));
      await waitFor(() => expect(record).toBeDefined());
      return { saves, record: () => act(() => record!()) };
    };
    try {
      const open = await run(false);
      await waitFor(() => expect(open.saves).toHaveLength(1));
      expect("material_chosen" in open.saves[0] && open.saves[0].material_chosen === undefined).toBe(true);
      expect(open.saves[0].compared).toEqual(["CHN"]);
      // The sentence shown on the card travels with the record so step 15 repeats the same words.
      expect(open.saves[0].material_label).toBe("2020 年 FVA_share（国家整体）：CHN 中国 11.730%");
      cleanup();

      const locked = await run(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(locked.saves).toHaveLength(0);
      await locked.record();
      expect(locked.saves).toHaveLength(1);
      expect(locked.saves[0].material_chosen).toBe(true);
      expect(locked.saves[0].compared).toEqual(["CHN"]);
      expect(locked.saves[0].material_label).toBe("2020 年 FVA_share（国家整体）：CHN 中国 11.730%");
    } finally {
      cleanup();
      rows.mockRestore();
    }
  });
});

describe("step 5 “全部” browsing", () => {
  test("recording keeps the table's own country instead of replacing “全部” with the recorded one", async () => {
    const rows = spyOn(api, "countryIndicators").mockResolvedValue([
      { country: "CHN", "weighted degree": 12 },
      { country: "USA", "weighted degree": 9 },
    ] as never);
    const metaWithRelease = { countries: ["CHN", "USA"], dataset: { release_id: "rel-1" } } as unknown as Meta;
    const saves: Record<string, unknown>[] = [];
    const Probe = () => {
      useAutoMaterial({
        topic: "network", meta: metaWithRelease, country: "CHN", year: 2020, browseCountry: "",
        schema: { status: "success", data: { groups: [], fields: { "weighted degree": { format: "amount" } } } as never },
        state: { data: undefined, save: (patch: Record<string, unknown>) => { saves.push(patch); }, complete: false, syncing: false, syncError: null, syncNow: () => {} } as never,
      });
      return null;
    };
    try {
      render(createElement(Probe));
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0].country).toBe("");
      expect(saves[0].compared).toEqual(["CHN"]);
    } finally {
      cleanup();
      rows.mockRestore();
    }
  });
});

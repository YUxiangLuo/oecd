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
    // A two-country record saved by an earlier version is not the current one-country reading.
    const legacy = { ...patch, compared: ["ARG", "PRT"], observations: [...patch!.observations!, { ...patch!.observations![0], entity: "PRT", country: "PRT", value: 0.992 }] };
    expect(materialMatches(patch, legacy)).toBe(false);
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
    expect(html).toContain("报告材料 · 自动记录");
    expect(html).toContain("2020 年外国增加值项占比：CHN 中国 11.730%");
    expect(html).toContain("记录上方所选国家同一年的外国增加值项占比（国家整体），换国家或年份后自动更新");
    expect(html).not.toContain("对比国家");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("（默认）");
    // A saved record from an earlier selection is not shown as if it matched the current one.
    const stale = render(false);
    expect(stale).not.toContain("CHN 中国 11.730%");
    expect(stale).toContain("正在记录当前选择");
  });

  test("a locked two-country record from an earlier version is shown as recorded, with the way to replace it", async () => {
    const render = await status([reading("CHN", 0.1173), reading("USA", 0.0551)], { materialLocked: true }, { record: () => {} });
    const html = render(false);
    expect(html).toContain("报告材料 · 已记录");
    expect(html).toContain("2020 年外国增加值项占比：CHN 中国 11.730%；USA 美国 5.510%");
    expect(html).toContain("改用当前选择");
    expect(html).not.toContain("正在记录当前选择");
  });
});

test("after 改用当前选择 on a submitted report, the line says to update the report on step 15", async () => {
  const { AutoMaterialStatus } = await import("./auto-comparison");
  const { fireEvent, screen } = await import("@testing-library/react");
  const state = { data: { observations: [{ country: "CHN", year: 2020, metric: "FVA_share", value: 0.1173, unit: "%" }] }, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {}, materialLocked: true } as never;
  const props = (current: boolean, record?: () => void) => ({ state, schema: null, metric: "FVA_share", current, record, loadFailed: false, where: "上方所选国家" });
  const view = render(createElement(AutoMaterialStatus, props(false, () => {})));
  expect(view.container.textContent).not.toContain("请到步骤 15");
  fireEvent.click(screen.getByRole("button", { name: /改用当前选择/ }));
  view.rerender(createElement(AutoMaterialStatus, props(true)));
  expect(view.container.textContent).toContain("当前选择就是已记录的材料。请到步骤 15 更新报告并重新提交给老师。");
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
      cleanup();

      const locked = await run(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(locked.saves).toHaveLength(0);
      await locked.record();
      expect(locked.saves).toHaveLength(1);
      expect(locked.saves[0].material_chosen).toBe(true);
      expect(locked.saves[0].compared).toEqual(["CHN"]);
    } finally {
      cleanup();
      rows.mockRestore();
    }
  });

  test("an unlocked two-country record from an earlier version is replaced by the one-country reading", async () => {
    const rows = spyOn(api, "countryIndicators").mockResolvedValue([
      { country: "CHN", FVA_share: 0.1173 },
      { country: "USA", FVA_share: 0.0551 },
    ] as never);
    const metaWithRelease = { countries: ["CHN", "USA"], dataset: { release_id: "rel-1" } } as unknown as Meta;
    const legacy = {
      year: 2020, country: "CHN", compared: ["CHN", "USA"], metric: "FVA_share",
      observations: [["CHN", 0.1173], ["USA", 0.0551]].map(([country, value]) => ({
        entity: country, country, industry: "", year: 2020, value, metric: "FVA_share", unit: "%",
        release: "rel-1", scope: "country", source: "auto-indicator-comparison",
      })),
    };
    const saves: Record<string, unknown>[] = [];
    const Probe = () => {
      useAutoMaterial({
        topic: "trade", meta: metaWithRelease, country: "CHN", year: 2020,
        schema: { status: "success", data: { groups: [], fields: { FVA_share: { format: "pct" } } } as never },
        state: { data: legacy, save: (patch: Record<string, unknown>) => { saves.push(patch); }, complete: false, syncing: false, syncError: null, syncNow: () => {} } as never,
      });
      return null;
    };
    try {
      render(createElement(Probe));
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0].compared).toEqual(["CHN"]);
      expect((saves[0].observations as unknown[]).length).toBe(1);
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

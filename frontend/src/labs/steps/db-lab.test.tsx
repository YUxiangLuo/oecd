import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import type { DbMeta, DbSlice, Meta } from "../../types";
import { DatabaseGuide, DbLab } from "./db-lab";

afterEach(cleanup);

const DB_META: DbMeta = {
  years: [2020],
  default_year: 2020,
  countries: ["CHN", "USA"],
  sectors: ["D01T02"],
  final_demand_categories: ["HFCE"],
  account_rows: ["TLS", "VA", "OUT"],
  files: [],
  n_rows: 1,
  n_columns: 1,
};

const SLICE: DbSlice = {
  year: 2020,
  table: "z",
  total: 1,
  page: 1,
  page_size: 25,
  columns: ["USA_D01T02"],
  rows: [{ row: "CHN_D01T02", USA_D01T02: 228.0672 }],
  row_summaries: [],
};

describe("step 1 further-reading card", () => {
  test("distinguishes a synthetic loaded table from the database catalogue", () => {
    const releaseMeta: Meta = {
      years: [2020], countries: ["CHN", "USA"], sectors: ["D01T02"],
      dataset: { years: [2020], data_sources: { ci_synthetic_icio: { production_data: false } } },
    };
    const view = render(<DatabaseGuide meta={DB_META} releaseMeta={releaseMeta} />);
    const copy = view.container.textContent;
    expect(copy).toContain("模拟投入产出数据（教学用）");
    expect(copy).toContain("2 个具名经济体 · 1 行业");
    expect(view.container.querySelector("p.muted")?.textContent).not.toContain("+ ROW");
    expect(copy).not.toContain("本系统使用 OECD ICIO");
    const oecdRow = view.container.querySelector(".db-guide-default")?.textContent;
    expect(oecdRow).toContain("以所用发行版本为准");
    expect(oecdRow).not.toContain("2 个具名经济体");
    view.rerender(<DatabaseGuide meta={DB_META} releaseMeta={null} />);
    expect(view.container.textContent).toContain("来源待确认");
  });

  test("reveals its guide content without a second nested disclosure", async () => {
    spyOn(api, "dbMeta").mockResolvedValue(DB_META);
    spyOn(api, "dbSlice").mockResolvedValue(SLICE);
    const state = {
      data: undefined,
      save: () => {},
      complete: false,
      syncing: false,
      syncError: null,
      syncNow: () => {},
    };

    render(<DbLab state={state} releaseMeta={null as Meta | null} />);

    const summary = await screen.findByText("进一步理解 ICIO 表结构与账户项");
    const card = summary.closest("details") as HTMLDetailsElement;
    expect(card).toBeTruthy();
    // 早前这里是外层 details 里再套一个折叠 details，学生需点击两次才能看到正文。
    expect(card.querySelectorAll("details")).toHaveLength(0);
    expect(card.textContent).toContain("全球投入产出数据库一览");
    expect(card.querySelector(".db-guide-table")).toBeTruthy();
  });
});


describe("step 1 cell activation", () => {
  test("clicking a value cell records it and opens the fullscreen table", async () => {
    spyOn(api, "dbMeta").mockResolvedValue(DB_META);
    spyOn(api, "dbSlice").mockResolvedValue(SLICE);
    const saved: unknown[] = [];
    const state = {
      data: undefined,
      save: (patch: unknown) => { saved.push(patch); },
      complete: false,
      syncing: false,
      syncError: null,
      syncNow: () => {},
    };

    render(<DbLab state={state} releaseMeta={null as Meta | null} />);

    const cell = await screen.findByTitle(/ → .+ 百万美元 · 点击记录这个观察值$/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saved).toHaveLength(0);

    await act(async () => { fireEvent.click(cell); });

    // The observation is still recorded ...
    const recorded = saved.filter((patch) => (patch as { observation?: unknown }).observation);
    expect(recorded).toHaveLength(1);
    const patch = recorded[0] as { observation?: { row?: string; column?: string; value?: number } };
    expect(patch.observation?.row).toBe("CHN_D01T02");
    expect(patch.observation?.column).toBe("USA_D01T02");
    expect(patch.observation?.value).toBeCloseTo(228.0672, 6);

    // ... and the same interaction switches the table to its fullscreen workspace.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(document.querySelector(".fullscreen-panel--expanded")).toBeTruthy();
  });

  test("the accounts tab records without claiming a fullscreen view it cannot open", async () => {
    spyOn(api, "dbMeta").mockResolvedValue(DB_META);
    spyOn(api, "dbSlice").mockImplementation(async () => ({
      year: 2020,
      table: "accounts",
      total: 1,
      page: 1,
      page_size: 25,
      columns: ["TLS", "VA", "OUT"],
      rows: [{ row: "CHN_D01T02", TLS: 0, VA: 12.5, OUT: 30 }],
      row_summaries: [],
    }) as DbSlice);
    const saved: unknown[] = [];
    const state = {
      data: undefined,
      save: (patch: unknown) => { saved.push(patch); },
      complete: false,
      syncing: false,
      syncError: null,
      syncNow: () => {},
    };

    render(<DbLab state={state} releaseMeta={null as Meta | null} />);
    fireEvent.click(await screen.findByRole("button", { name: "账户项" }));

    const cells = await screen.findAllByTitle(/点击记录这个观察值$/);
    const cell = cells[0];
    expect(cell.getAttribute("title")).not.toContain("全屏");

    await act(async () => { fireEvent.click(cell); });

    const csaved = saved.filter((patch) => (patch as { observation?: unknown }).observation);
    expect(csaved).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".fullscreen-panel--expanded")).toBeNull();
  });
});

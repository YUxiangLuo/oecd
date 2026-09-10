import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import type { DbMeta, DbSlice, Meta } from "../../types";
import { DbLab } from "./db-lab";

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

    const cell = await screen.findByTitle(/点击记录这个观察值并进入全屏查看/);
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

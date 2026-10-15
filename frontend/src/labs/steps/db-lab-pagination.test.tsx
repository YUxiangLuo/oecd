import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import type { DbMeta, DbSlice } from "../../types";
import { DbLab, type DbStepState } from "./db-lab";

afterEach(() => { cleanup(); mock.restore(); });

const META: DbMeta = {
  years: [2019, 2020], default_year: 2020, countries: ["CHN", "USA"],
  sectors: ["A01_02", "C26"], final_demand_categories: ["HFCE"],
  account_rows: ["TLS", "VA", "OUT"], files: [], n_rows: 4, n_columns: 4,
};
const observation = { year: 2020, table: "z", row: "CHN_A01_02", column: "USA_C26", value: 4 };
type SliceRequest = Parameters<typeof api.dbSlice>[0];

function sliceFor(request: SliceRequest): DbSlice {
  return {
    year: request.year, table: request.table, total: request.rowSector ? 1 : 45,
    page: request.page ?? 1, page_size: 25, columns: ["row", "USA_C26"],
    rows: request.rowSector && (request.page ?? 1) > 1 ? [] : [{
      row: `${request.rowCountry}_${request.rowSector || "A01_02"}`,
      USA_C26: request.page ?? 1,
    }],
    row_summaries: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function mount() {
  const saved: Partial<DbStepState>[] = [];
  function Harness() {
    const [data, setData] = useState<DbStepState>({ observation });
    return <DbLab releaseMeta={null} state={{
      data, save: (patch) => { saved.push(patch); setData((current) => ({ ...current, ...patch })); },
      complete: false, syncing: false, syncError: null, syncNow: () => {},
    }} />;
  }
  render(<Harness />);
  return saved;
}

const waitCells = () => waitFor(() => expect(document.querySelectorAll(".db-observation-cell")).toHaveLength(1));
const nextPage = () => screen.queryByRole("button", { name: "下一页 →" });
const chooseSector = (value: string) => fireEvent.change(screen.getByLabelText("供给行业（行）"), { target: { value } });

test("RSTEP02 step 1 cannot page into a pending or failed one-row filter; retry preserves material", async () => {
  spyOn(api, "dbMeta").mockResolvedValue(META);
  const held = deferred<DbSlice>();
  let failures = true;
  const request = spyOn(api, "dbSlice").mockImplementation((params) => params.rowSector && failures
    ? held.promise : Promise.resolve(sliceFor(params)));
  const saved = mount();
  await waitCells();
  expect(nextPage()).not.toBeNull();
  chooseSector("C26");
  expect(nextPage()).toBeNull();
  expect(screen.queryByLabelText("跳转页码")).toBeNull();
  await act(async () => held.reject(new Error("Failed to fetch")));
  await screen.findByRole("alert");
  expect(nextPage()).toBeNull();
  failures = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitCells();
  expect(request.mock.calls.filter(([params]) => params.rowSector === "C26").map(([params]) => params.page)).toEqual([1, 1]);
  expect(document.querySelector(".pager")?.textContent).toBe("共 1 条");
  expect(document.querySelector(".material-card-summary")?.textContent).toContain("4 百万美元");
  expect(saved.filter((patch) => patch.observation || patch.material_label)).toHaveLength(0);
});

test("RSTEP02 step 1 keeps same-filter pager and focus while loading, including first/last/input navigation", async () => {
  spyOn(api, "dbMeta").mockResolvedValue(META);
  const held = deferred<DbSlice>();
  let pending = true;
  const request = spyOn(api, "dbSlice").mockImplementation((params) => params.page === 2 && pending
    ? held.promise : Promise.resolve(sliceFor(params)));
  mount();
  await waitCells();
  const next = nextPage()!;
  next.focus();
  fireEvent.click(next);
  expect(nextPage()).toBe(next);
  expect(document.activeElement).toBe(next);
  expect(screen.getByLabelText("跳转页码").getAttribute("value")).toBe("2");
  expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
  pending = false;
  await act(async () => held.resolve(sliceFor(request.mock.calls.at(-1)![0])));
  await waitCells();
  expect(nextPage()).toBe(next);
  fireEvent.click(screen.getByRole("button", { name: "« 首页" }));
  await waitFor(() => expect(request.mock.calls.at(-1)![0].page).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "末页 »" }));
  await waitFor(() => expect(request.mock.calls.at(-1)![0].page).toBe(2));
  const input = screen.getByLabelText("跳转页码");
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(request.mock.calls.at(-1)![0].page).toBe(1));
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(request.mock.calls.at(-1)![0].page).toBe(2));
  expect(request.mock.calls.every(([params]) => params.page === 1 || params.page === 2)).toBe(true);
});

test("RSTEP02 step 1 forgets the previous range even when switching away and back before either request settles", async () => {
  spyOn(api, "dbMeta").mockResolvedValue(META);
  const filtered = deferred<DbSlice>();
  const returned = deferred<DbSlice>();
  let initial = true;
  const request = spyOn(api, "dbSlice").mockImplementation((params) => {
    if (params.rowSector) return filtered.promise;
    if (!initial) return returned.promise;
    initial = false;
    return Promise.resolve(sliceFor(params));
  });
  mount();
  await waitCells();
  chooseSector("C26");
  chooseSector("");
  expect(nextPage()).toBeNull();
  await act(async () => filtered.resolve(sliceFor({ year: 2020, table: "z", rowCountry: "CHN", rowSector: "C26", page: 1 })));
  expect(nextPage()).toBeNull();
  expect(document.querySelectorAll(".db-observation-cell")).toHaveLength(0);
  await act(async () => returned.resolve(sliceFor(request.mock.calls.at(-1)![0])));
  await waitCells();
  expect(nextPage()).not.toBeNull();
  expect(request.mock.calls.every(([params]) => params.page === 1)).toBe(true);
});

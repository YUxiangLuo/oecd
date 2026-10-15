import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../../api";
import type { IndicatorSchema, IndustryPage, Meta, StepStateApi } from "../../../types";
import { IndicatorTable, useIndicatorControls, type IndicatorStepState } from "./indicator-table";

afterEach(() => { cleanup(); mock.restore(); });

const meta: Meta = { years: [2019, 2020], countries: ["CHN", "USA"], sectors: ["C26"] };
const schema: IndicatorSchema = { groups: [{ key: "network", label: "网络", fields: ["weighted degree"] }], fields: {} };
const material: IndicatorStepState = { country: "", year: 2020, material_label: "原来的国家读数", material_chosen: true };

function pageFor(year: number, country: string, page = 1): IndustryPage {
  return {
    total: country ? 45 : 3465, page, page_size: country ? 200 : 50,
    rows: country && page > 1 ? [] : [{ year, country: country || "ARG", industry: "C26", "weighted degree": page }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function mount() {
  const saved: Partial<IndicatorStepState>[] = [];
  function Harness() {
    const [data, setData] = useState(material);
    const state: StepStateApi<IndicatorStepState> = {
      data, save: (patch) => { saved.push(patch); setData((current) => ({ ...current, ...patch })); },
      complete: false, syncing: false, syncError: null, syncNow: () => {},
    };
    const controls = useIndicatorControls(meta, state);
    return <IndicatorTable meta={meta} groupKey="network" schema={schema} state={state}
      year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
      onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage} />;
  }
  render(<Harness />);
  return saved;
}

const waitRows = () => waitFor(() => expect(document.querySelectorAll(".indicator-row-header")).toHaveLength(1));
const nextPage = () => screen.queryByRole("button", { name: "下一页 →" });
const chooseCountry = (value: string) => fireEvent.change(screen.getByLabelText("国家"), { target: { value } });

test("RSTEP02 step 5 global-to-country loading/error cannot use the global page count; retry returns country rows", async () => {
  const held = deferred<IndustryPage>();
  let failures = true;
  const request = spyOn(api, "industryIndicators").mockImplementation((year, country, page) => country && failures
    ? held.promise : Promise.resolve(pageFor(year, country ?? "", page)));
  const saved = mount();
  await waitRows();
  expect(nextPage()).not.toBeNull();
  chooseCountry("CHN");
  expect(nextPage()).toBeNull();
  expect(screen.queryByLabelText("跳转页码")).toBeNull();
  await act(async () => held.reject(new Error("Failed to fetch")));
  await screen.findByRole("alert");
  expect(nextPage()).toBeNull();
  failures = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitRows();
  expect(request.mock.calls.filter(([, country]) => country === "CHN").map(([, , page]) => page)).toEqual([1, 1]);
  expect(document.querySelector(".pager")?.textContent).toBe("共 45 条");
  expect(screen.getByRole("table").textContent).toContain("CHN");
  expect(saved.some((patch) => patch.material_label || patch.observations || patch.material_chosen)).toBe(false);
});

test("RSTEP02 step 5 same-filter pending page retains pager and focus for first/last/input navigation", async () => {
  const held = deferred<IndustryPage>();
  let pending = true;
  const request = spyOn(api, "industryIndicators").mockImplementation((year, country, page) => page === 2 && pending
    ? held.promise : Promise.resolve(pageFor(year, country ?? "", page)));
  mount();
  await waitRows();
  const next = nextPage()!;
  next.focus();
  fireEvent.click(next);
  expect(nextPage()).toBe(next);
  expect(document.activeElement).toBe(next);
  expect(screen.getByText("第 2 / 70 页")).toBeTruthy();
  pending = false;
  await act(async () => held.resolve(pageFor(2020, "", 2)));
  await waitRows();
  expect(nextPage()).toBe(next);
  fireEvent.click(screen.getByRole("button", { name: "末页 »" }));
  await waitFor(() => expect(request.mock.calls.at(-1)![2]).toBe(70));
  fireEvent.click(screen.getByRole("button", { name: "« 首页" }));
  await waitFor(() => expect(request.mock.calls.at(-1)![2]).toBe(1));
  const input = screen.getByLabelText("跳转页码");
  fireEvent.change(input, { target: { value: "999" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(request.mock.calls.at(-1)![2]).toBe(70));
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(request.mock.calls.at(-1)![2]).toBe(1));
  expect(request.mock.calls.every(([, , page]) => page != null && page >= 1 && page <= 70)).toBe(true);
});

test("RSTEP02 step 5 forgets global range when returning from a pending country request and ignores its late response", async () => {
  const filtered = deferred<IndustryPage>();
  const returned = deferred<IndustryPage>();
  let initial = true;
  const request = spyOn(api, "industryIndicators").mockImplementation((year, country, page) => {
    if (country) return filtered.promise;
    if (!initial) return returned.promise;
    initial = false;
    return Promise.resolve(pageFor(year, country ?? "", page));
  });
  mount();
  await waitRows();
  chooseCountry("CHN");
  chooseCountry("");
  expect(nextPage()).toBeNull();
  await act(async () => filtered.resolve(pageFor(2020, "CHN")));
  expect(nextPage()).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  await act(async () => returned.resolve(pageFor(2020, "")));
  await waitRows();
  expect(nextPage()).not.toBeNull();
  expect(request.mock.calls.every(([, , page]) => page === 1)).toBe(true);
});

test("RSTEP02 step 5 year change resets page and cannot reuse the previous year's global range", async () => {
  const held = deferred<IndustryPage>();
  const request = spyOn(api, "industryIndicators").mockImplementation((year, country, page) => year === 2019
    ? held.promise : Promise.resolve(pageFor(year, country ?? "", page)));
  mount();
  await waitRows();
  fireEvent.click(nextPage()!);
  await waitFor(() => expect(request.mock.calls.at(-1)![2]).toBe(2));
  fireEvent.change(screen.getByLabelText("年份"), { target: { value: "2019" } });
  expect(nextPage()).toBeNull();
  await act(async () => held.resolve({ ...pageFor(2019, ""), total: 1 }));
  await waitRows();
  expect(document.querySelector(".pager")?.textContent).toBe("共 1 条");
  expect(request.mock.calls.filter(([year]) => year === 2019).map(([, , page]) => page)).toEqual([1]);
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  carriedComparisonFor,
  carriedComparisonSource,
  latestComparison,
  StudentWorkspaceSkipLink,
  focusStepMainContent,
  stepMainContentId,
  useRestoredEditsToast,
} from "./student-workspace";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { ToastHost } from "./toast";

describe("student workspace skip link", () => {
  test("is the first native Tab stop and has one unique current-main target", () => {
    const targetId = stepMainContentId(13);
    const html = renderToStaticMarkup(
      <div>
        <StudentWorkspaceSkipLink targetId={targetId} targetRef={{ current: null }} />
        <button type="button">顶部导航</button>
        <main id={targetId} tabIndex={-1}>本步内容</main>
      </div>,
    );
    expect(html.indexOf("跳到本步内容")).toBeLessThan(html.indexOf("顶部导航"));
    expect(html).toContain(`href="#${targetId}"`);
    expect(html.match(new RegExp(`id="${targetId}"`, "g"))).toHaveLength(1);
    expect(html).toContain('tabindex="-1"');
  });

  test("click or keyboard activation lands focus on the current main reliably", () => {
    let prevented = 0;
    let focused = 0;
    let scrolled = 0;
    focusStepMainContent(
      { preventDefault: () => { prevented += 1; } },
      {
        focus: (options) => {
          focused += 1;
          expect(options).toEqual({ preventScroll: true });
        },
        scrollTo: (options) => {
          scrolled += 1;
          expect(options).toEqual({ top: 0, left: 0, behavior: "auto" });
        },
      },
    );
    expect({ prevented, focused, scrolled }).toEqual({ prevented: 1, focused: 1, scrolled: 1 });
    expect(stepMainContentId(12)).not.toBe(stepMainContentId(13));
  });
});

test("a carried comparison keeps country A first: up to five economies for steps 6–9", () => {
  const saved: Record<number, unknown> = { 6: ["DEU", "CHN", "USA", "MEX", "IRL"] };
  const read = (prior: number) => saved[prior];
  expect(carriedComparisonFor(7, [], read)).toEqual(["DEU", "CHN", "USA", "MEX", "IRL"]);
  expect(carriedComparisonFor(9, ["DEU"], read)).toEqual(["DEU", "CHN", "USA", "MEX", "IRL"]);
  // The step's own comparison wins once it has one.
  expect(carriedComparisonFor(7, ["CHN", "USA"], read)).toEqual([]);
  expect(carriedComparisonFor(10, [], read)).toEqual([]);
});

describe("steps 2–5 record one country, which the later steps carry", () => {
  const countries = ["CHN", "DEU", "JPN", "USA", "ROW"];
  const from = (saved: Record<number, unknown>) => (prior: number) => saved[prior];

  test("steps 3–5 open at the country picked on an earlier step", () => {
    expect(carriedComparisonFor(3, [], from({ 2: ["DEU"] }), countries)).toEqual(["DEU"]);
    expect(carriedComparisonFor(5, [], from({ 2: ["JPN"], 3: ["DEU"] }), countries)).toEqual(["DEU"]);
    // Once the step records its own country, that one is used.
    expect(carriedComparisonFor(4, ["JPN"], from({ 3: ["DEU"] }), countries)).toEqual([]);
    expect(carriedComparisonFor(2, [], from({}), countries)).toEqual([]);
  });

  test("the carried country names the step it came from", () => {
    expect(carriedComparisonSource(3, [], from({ 2: ["DEU"] }), countries)).toEqual({ compared: ["DEU"], from: 2 });
    expect(carriedComparisonSource(5, [], from({ 2: ["JPN"], 3: ["DEU"] }), countries)).toEqual({ compared: ["DEU"], from: 3 });
    // Steps 3 and 4 recorded the carried DEU on opening: the note names step 2, where the student picked it.
    expect(carriedComparisonSource(5, [], from({ 2: ["DEU"], 3: ["DEU"], 4: ["DEU"] }), countries)).toEqual({ compared: ["DEU"], from: 2 });
    expect(carriedComparisonSource(5, [], from({ 2: ["DEU"], 3: ["JPN"], 4: ["JPN"] }), countries)).toEqual({ compared: ["JPN"], from: 3 });
    // Step 4 never visited: the country comes from step 3.
    expect(carriedComparisonSource(5, [], from({ 3: ["JPN"] }), countries)).toEqual({ compared: ["JPN"], from: 3 });
    expect(carriedComparisonSource(4, ["JPN"], from({ 3: ["DEU"] }), countries)).toBeNull();
    expect(carriedComparisonSource(2, [], from({}), countries)).toBeNull();
  });

  test("step 6 takes country A from steps 2–5 and the default comparison country B", () => {
    expect(carriedComparisonFor(6, [], from({ 3: ["DEU"] }), countries)).toEqual(["DEU", "USA"]);
    expect(carriedComparisonFor(6, [], from({ 5: ["USA"] }), countries)).toEqual(["USA", "CHN"]);
    expect(carriedComparisonFor(8, [], from({ 2: ["JPN"] }), countries)).toEqual(["JPN", "USA"]);
    // ROW is not an economy, neither as A nor as the default B.
    expect(carriedComparisonFor(6, [], from({ 4: ["ROW"], 3: ["DEU"] }), countries)).toEqual(["DEU", "USA"]);
    // Without the country list, A is still carried.
    expect(carriedComparisonFor(6, [], from({ 3: ["DEU"] }))).toEqual(["DEU"]);
  });

  test("steps 6–9 name the step where the carried set was chosen", () => {
    // Step 6 picked JPN · CHN; step 7 recorded that set on opening: step 8 names step 6.
    expect(carriedComparisonSource(8, [], from({ 6: ["JPN", "CHN"], 7: ["JPN", "CHN"] }), countries)).toEqual({ compared: ["JPN", "CHN"], from: 6 });
    // Step 7 changed the set: step 8 names step 7.
    expect(carriedComparisonSource(8, [], from({ 6: ["JPN", "CHN"], 7: ["JPN", "DEU"] }), countries)).toEqual({ compared: ["JPN", "DEU"], from: 7 });
    // Step 6 opened on the steps 2–5 country with its default B: the set was chosen where DEU was picked.
    expect(carriedComparisonSource(8, [], from({ 2: ["DEU"], 3: ["DEU"], 6: ["DEU", "USA"], 7: ["DEU", "USA"] }), countries)).toEqual({ compared: ["DEU", "USA"], from: 2 });
    expect(carriedComparisonSource(6, [], from({ 2: ["DEU"], 3: ["DEU"] }), countries)).toEqual({ compared: ["DEU", "USA"], from: 2 });
    // A B other than the default was picked on step 6.
    expect(carriedComparisonSource(7, [], from({ 3: ["DEU"], 6: ["DEU", "JPN"] }), countries)).toEqual({ compared: ["DEU", "JPN"], from: 6 });
  });

  test("the selection left on screen carries over even when its chart was not recorded", () => {
    // Step 6 picked BRN; step 7 recorded it on opening; step 8 switched to ISL but could not record the chart.
    const steps: Record<number, unknown> = {
      6: { compared: ["BRN", "USA"] },
      7: { compared: ["BRN", "USA"] },
      8: { compared: ["BRN", "USA"], browse_selection: { first: "ISL", second: "USA", others: ["USA"], industry: "B09" } },
    };
    const read = (prior: number) => latestComparison(steps[prior]);
    expect(carriedComparisonSource(9, [], read, [...countries, "BRN", "ISL"])).toEqual({ compared: ["ISL", "USA"], from: 8 });
    // Step 9's own browsing countries are what it leaves for later.
    expect(latestComparison({ compared: ["BRN", "USA"], network_browse: { countries: ["JPN", "CHN"] } })).toEqual(["JPN", "CHN"]);
    expect(latestComparison({ compared: ["BRN", "USA"] })).toEqual(["BRN", "USA"]);
  });

  test("a later steps 6–9 comparison wins over a steps 2–5 country", () => {
    expect(carriedComparisonFor(7, [], from({ 5: ["DEU"], 6: ["JPN", "CHN"] }), countries)).toEqual(["JPN", "CHN"]);
    // A one-country save on steps 6–9 is not a comparison: the steps 2–5 country is used.
    expect(carriedComparisonFor(7, [], from({ 5: ["DEU"], 6: ["JPN"] }), countries)).toEqual(["DEU", "USA"]);
  });
});

test("edits put back after a re-login are confirmed once with a toast", async () => {
  render(<ToastHost />);
  const hook = renderHook(({ count }) => useRestoredEditsToast(count), { initialProps: { count: 0 } });
  expect(screen.queryByText("已恢复上次未保存的修改")).toBeNull();
  hook.rerender({ count: 1 });
  expect(await screen.findByText("已恢复上次未保存的修改", { exact: false })).toBeTruthy();
  // A remounted workspace with the same count does not say it again.
  hook.unmount();
  const toasts = () => screen.queryAllByText("已恢复上次未保存的修改", { exact: false }).length;
  const before = toasts();
  renderHook(() => useRestoredEditsToast(1));
  expect(toasts()).toBe(before);
  cleanup();
});

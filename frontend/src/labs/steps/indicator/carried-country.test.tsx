import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step, StepStateApi } from "../../../types";
import { CalculationStep } from "./calculation-step";
import { type IndicatorStepState, IndicatorTable, carriedCountryNote, useIndicatorControls } from "./indicator-table";
import { NetworkIndicatorStep } from "./network";

const meta: Meta = { years: [2019, 2020], countries: ["CHN", "DEU", "JPN"], sectors: ["A"], dataset: null };
const step = { n: 4, topic: "length" } as Step;
const stateOf = (data: IndicatorStepState | undefined, extra: Partial<StepStateApi<IndicatorStepState>> = {}): StepStateApi<IndicatorStepState> =>
  ({ data, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {}, ...extra });
/** As the workspace hands a step that opened on step 2's DEU (see carriedComparisonSource). */
const carried = stateOf({ compared: ["DEU"], country: "DEU" }, { carriedFrom: 2 });
const NOTE = "沿用步骤 2 的国家，可以更换。";

afterEach(cleanup);

describe("steps 3–5 say where a carried country came from", () => {
  let controls: ReturnType<typeof useIndicatorControls>;
  function Probe({ state }: { state: StepStateApi<IndicatorStepState> }) {
    controls = useIndicatorControls(meta, state);
    return null;
  }

  test("the line stays after the step records the country, and goes once the student picks one here", () => {
    expect(carriedCountryNote(2)).toBe(NOTE);
    const view = render(<Probe state={carried} />);
    expect(controls.carriedNote).toBe(NOTE);
    // The step records DEU as its own right after it opens: the workspace no longer offers a carried country.
    view.rerender(<Probe state={stateOf({ compared: ["DEU"], country: "DEU", year: 2020 })} />);
    expect(controls.carriedNote).toBe(NOTE);
    // Another year is not another country.
    act(() => controls.setYear(2019));
    expect(controls.carriedNote).toBe(NOTE);
    act(() => controls.setPrimary(2019, "DEU"));
    expect(controls.carriedNote).toBe(NOTE);
    act(() => controls.setCountry("JPN"));
    expect(controls.carriedNote).toBeNull();
    // Picking the carried country again is still the student's own choice.
    act(() => controls.setCountry("DEU"));
    expect(controls.carriedNote).toBeNull();
  });

  test("no line without a carried country, or when the step shows another country of its own", () => {
    render(<Probe state={stateOf({ compared: ["DEU"], country: "DEU" })} />);
    expect(controls.carriedNote).toBeNull();
    cleanup();
    // Step 5 saved 全部 as its browsing choice: the table does not show the carried country.
    render(<Probe state={stateOf({ compared: ["DEU"], country: "" }, { carriedFrom: 2 })} />);
    expect(controls.carriedNote).toBeNull();
  });

  test("steps 3–4 show the line right above the country select; step 5 beside it", () => {
    const calculation = renderToStaticMarkup(<CalculationStep topic="length" meta={meta} step={step} state={carried} />);
    expect(calculation).toContain(`<p class="muted indicator-carried-note" role="note">${NOTE}</p>`);
    expect(calculation.indexOf(NOTE)).toBeLessThan(calculation.indexOf("demo-controls"));
    expect(renderToStaticMarkup(<CalculationStep topic="length" meta={meta} step={step} state={stateOf({ compared: ["DEU"], country: "DEU" })} />))
      .not.toContain("indicator-carried-note");
    const table = renderToStaticMarkup(
      <IndicatorTable meta={meta} groupKey="network" schema={null} state={carried} year={2020} country="DEU" page={1}
        interacted={false} countryNote={NOTE} onYear={() => {}} onCountry={() => {}} onPage={() => {}} />,
    );
    const controlsRow = table.slice(table.indexOf('class="controls"'), table.indexOf("network-table-sort"));
    expect(controlsRow).toContain(NOTE);
    expect(renderToStaticMarkup(<NetworkIndicatorStep meta={meta} step={{ ...step, n: 5, topic: "network" }} state={carried} />)).toContain(NOTE);
  });
});

describe("step 5 with 国家 = 全部 says which country the report material records", () => {
  test("the table shows every country; the material line names the recorded one", () => {
    const html = renderToStaticMarkup(
      <NetworkIndicatorStep meta={meta} step={{ ...step, n: 5, topic: "network" }} state={stateOf({ compared: ["DEU"], country: "" })} />,
    );
    expect(html).toContain("表格显示全部国家；报告材料记录最近选的国家 DEU 德国。记录的是同一年的");
    expect(html).not.toContain("记录上方表格所选国家");
    // With one country selected the line reads as before.
    const one = renderToStaticMarkup(
      <NetworkIndicatorStep meta={meta} step={{ ...step, n: 5, topic: "network" }} state={stateOf({ compared: ["DEU"], country: "DEU" })} />,
    );
    expect(one).toContain("记录上方表格所选国家同一年的");
    expect(one).not.toContain("表格显示全部国家");
  });
});

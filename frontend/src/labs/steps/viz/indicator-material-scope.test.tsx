import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { api } from "../../../api";
import { MATERIAL_CARD_TITLE } from "../../../material-card";
import { RECORD_CHART_ACTION, REPLACE_MATERIAL_ACTION } from "../../../step-task-card";
import type { Meta, Step, StepStateApi } from "../../../types";
import { TradeVizStep } from "./trade";
import { ProductionVizStep } from "./production";
import { LengthVizStep } from "./length";
import type { VizStepState } from "./scaffold";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { cleanup(); spies.splice(0).forEach((spy) => spy.mockRestore()); });
const meta: Meta = {
  years: [2019, 2020], countries: ["CHN", "USA"], sectors: ["C26", "C29"],
  dataset: { years: [2019, 2020], release_id: "a".repeat(32) },
};
const row = (country: string, industry?: string) => ({
  country, industry: industry ?? null, gross_exports: 100,
  FVA: 10, DVAex: 50, DVArt: 10, DDC: 10, FDC: 10, taxsub: 10,
  SVA: 100, "1_VA_D": 40, "2_VA_RT": 20, "3a_VA_GVC_S": 20, "3b_VA_GVC_C": 20, "3_VA_GVC": 40,
  PLv_GVC: 2, PLy_GVC: 3,
});

for (const [Component, stepNumber] of [[TradeVizStep, 6], [ProductionVizStep, 7], [LengthVizStep, 8]] as const) {
  for (const initialIndustry of ["", "C26"]) {
    test(`step ${stepNumber} records ranking scope and repairs locked legacy labels after ${initialIndustry || "country"} browsing`, async () => {
      spies.push(spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} }));
      spies.push(spyOn(api, "countryIndicators").mockImplementation(async () => ["CHN", "USA"].map((country) => row(country))));
      spies.push(spyOn(api, "industryIndicatorsAll").mockImplementation(async (_year, country) => ({ rows: ["C26", "C29"].map((industry) => row(country, industry)), total: 2, page: 1, page_size: 2 })));
      const saves: VizStepState[] = [];
      const state: StepStateApi<VizStepState> = { data: undefined, save: (data) => saves.push(data), complete: false, syncing: false, syncError: null, syncNow: () => {} };
      const step = { n: stepNumber } as Step;
      const view = render(<Component meta={meta} step={step} state={state} />);
      await view.findByRole("button", { name: RECORD_CHART_ACTION });
      fireEvent.click(view.getByRole("button", { name: "国家对比" }));
      if (initialIndustry) fireEvent.change(view.getByLabelText("比较范围"), { target: { value: initialIndustry } });
      const comparisonRecord = await view.findByRole("button", { name: RECORD_CHART_ACTION });
      await act(async () => fireEvent.click(comparisonRecord));
      const ordinary = saves.at(-1)!;
      const oldScope = initialIndustry ? "C26 计算机电子光学" : "国家整体";
      expect(ordinary.material_label).toContain(` · ${oldScope} · `);
      expect(ordinary.material_label).not.toContain("各行业");

      fireEvent.click(view.getByRole("button", { name: "行业排名" }));
      const rankingRecord = await view.findByRole("button", { name: RECORD_CHART_ACTION });
      await act(async () => fireEvent.click(rankingRecord));
      const ranking = saves.at(-1)!;
      expect(ranking.material_label).toContain(" · 所选国家各行业 · ");
      expect(ranking.observations).toHaveLength(4);
      expect([...new Set(ranking.observations!.map((item) => item.industry))].sort()).toEqual(["C26", "C29"]);
      expect(ranking.indicator_selection?.industry).toBe(initialIndustry);

      // A submitted older record keeps its values and selection. Only its displayed description changes.
      // Browsing a different view must not make the recorded ranking acquire that new chart's scope.
      const legacy = { ...ranking, material_label: (ranking.material_label as string).replace("所选国家各行业", oldScope), browse_selection: ordinary.indicator_selection };
      const before = JSON.stringify(legacy);
      saves.length = 0;
      view.unmount();
      const reopened = render(<Component meta={meta} step={step} state={{ ...state, data: legacy, materialLocked: true }} />);
      await reopened.findByRole("button", { name: REPLACE_MATERIAL_ACTION });
      const card = reopened.getByRole("region", { name: MATERIAL_CARD_TITLE });
      expect(card.textContent).toContain(ranking.material_label as string);
      expect(card.textContent).not.toContain(` · ${oldScope} · `);
      expect(saves).toHaveLength(0);
      expect(JSON.stringify(legacy)).toBe(before);
    });
  }
}

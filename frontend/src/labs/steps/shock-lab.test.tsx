import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step } from "../../types";
import { ShockLab } from "./shock-lab";
import { SHOCK_ARTIFACT_CONTRACT_VERSION } from "./shock/shock-contract";

const step: Step = {
  n: 10, stage: 4, lab: "shock", status: "done", title: "政策冲击", goal: "",
  tasks: ["", "", ""], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};

test("step 10 uses the dedicated teaching tariff panel independently of the old shock contract", () => {
  const meta: Meta = {
    years: [2016, 2020], countries: ["CHN", "USA"], sectors: ["C26"],
    dataset: { years: [2016, 2020], artifact_contract_version: SHOCK_ARTIFACT_CONTRACT_VERSION - 1 },
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  expect(html).toContain("教学关税暴露");
  expect(html).toContain("teaching_tariff_exposure");
  expect(html).toContain("正在读取教学关税面板");
  expect(html).not.toContain("政策事件");
});

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
  expect(html).toContain("拿来比较的因素（X）");
  expect(html).toContain("国家 A");
  expect(html).toContain("国家 B");
  expect(html).toContain("五年变化");
  expect(html).toContain("正在读取教学关税面板");
  expect(html).not.toContain("政策事件");
  expect(html).toContain("0.25 × 0.20 = 0.05，即 5%");
  expect(html).toContain("X 从 5% 变为 6%，增加的是 1 个百分点");
  expect(html).toContain("不是下方所选国家的实际读数");
});

test("step 10 prefers the configured two-country industry example", () => {
  const meta: Meta = {
    years: [2016, 2017, 2018, 2019, 2020],
    countries: ["CAN", "CHN", "KOR", "USA"],
    sectors: ["C26", "C29"],
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  expect(html).toContain('<option value="CAN" selected="">CAN 加拿大</option>');
  expect(html).toContain('<option value="KOR" selected="">KOR 韩国</option>');
  expect(html).toContain('<option value="C29" selected="">C29 汽车及零部件</option>');
});

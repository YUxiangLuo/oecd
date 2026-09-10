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

test("a rejected artifact never claims its disabled QC or source request is loading", () => {
  const meta: Meta = {
    years: [2016, 2020], countries: ["CHN", "USA"], sectors: ["C26"],
    dataset: { years: [2016, 2020], artifact_contract_version: SHOCK_ARTIFACT_CONTRACT_VERSION - 1 },
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  expect(html).toContain("不支持冲击产物版本");
  expect(html).toContain("未读取：产物契约无效");
  expect(html).toContain("产物契约校验失败，未读取来源披露");
  expect(html.match(/冲击数据质检[\s\S]*?<\/summary>/)?.[0]).not.toContain("加载中");
});

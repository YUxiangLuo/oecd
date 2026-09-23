import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { api } from "../../../api";
import { IcioExperiment, type TeachingScenario } from "./icio-experiment";

const chain: TeachingScenario = {
  id: "complex-gvc", title: "复杂全球价值链", description: "40元中间品跨境，加工增加60元，100元最终品再出口。",
  nodes: ["甲国·初级品", "乙国·加工品"], regions: ["甲国", "乙国", "丙国"],
  Z: [[0, 40], [0, 0]], Y: [[0, 0, 0], [0, 0, 100]], va: [40, 60], x: [40, 100],
  A: [[0, 0.4], [0, 0]], B: [[1, 0.4], [0, 1]],
  trade: [
    { gross_exports: 40, DVAex: 40, DVArt: 0, DDC: 0, FVA: 0, FDC: 0, taxsub: 0 },
    { gross_exports: 100, DVAex: 60, DVArt: 0, DDC: 0, FVA: 40, FDC: 0, taxsub: 0 },
  ],
  production: [
    { SVA: 40, "1_VA_D": 0, "2_VA_RT": 0, "3a_VA_GVC_S": 0, "3b_VA_GVC_C": 40 },
    { SVA: 60, "1_VA_D": 0, "2_VA_RT": 60, "3a_VA_GVC_S": 0, "3b_VA_GVC_C": 0 },
  ],
  length: [
    { PLv: 2, PLy: null, PLv_GVC: 2, PLy_GVC: null, GVCPs: null },
    { PLv: 1, PLy: 1.4, PLv_GVC: null, PLy_GVC: 2, GVCPs: null },
  ],
};
const direct: TeachingScenario = {
  ...chain, id: "direct", title: "直接生产", nodes: ["甲国·初级品", "甲国·加工品"],
  Z: [[0, 0], [0, 0]], Y: [[0, 0, 0], [100, 0, 0]], va: [0, 100], x: [0, 100],
  A: [[0, 0], [0, 0]], B: [[1, 0], [0, 1]],
  length: [{}, { PLv: 1, PLy: 1, PLv_GVC: null, PLy_GVC: null, GVCPs: null }],
};
const simple: TeachingScenario = {
  ...chain, id: "simple-gvc", title: "简单全球价值链", Y: [[0, 0, 0], [0, 100, 0]],
  production: [{ ...chain.production[0], "3a_VA_GVC_S": 40, "3b_VA_GVC_C": 0 }, { ...chain.production[1], "1_VA_D": 60, "2_VA_RT": 0 }],
};

afterEach(() => cleanup());
const setup = () => spyOn(api, "teachingIcio").mockResolvedValue({ scenarios: [chain, direct, simple, { ...direct, id: "domestic", title: "国内生产与吸收" }] });

test("trade links asymmetric input cells, source calculation and selected result; switching scenario clears the old node", async () => {
  const mock = setup();
  try {
    const view = render(<IcioExperiment topic="trade" />);
    await view.findByText("总出口 = 100");
    const results = view.getByRole("region", { name: "教学指标计算结果" });
    expect(within(results).getByText("外国增加值").parentElement?.textContent).toBe("外国增加值40元");
    expect(view.getByText(/1 × 0.4 × 100/).textContent).toContain("= 40 元");
    fireEvent.click(view.getByRole("button", { name: "甲国·初级品" }));
    expect(view.getByText("总出口 = 40")).toBeTruthy();
    expect(within(results).getByText("外国增加值").parentElement?.textContent).toBe("外国增加值0元");
    fireEvent.click(view.getByRole("button", { name: "简单全球价值链" }));
    expect(view.getByRole("heading", { name: "② 跟着数字算 · 乙国·加工品" })).toBeTruthy();
    expect(view.getByLabelText("生产与使用路径").textContent).toContain("乙国消费");
  } finally { mock.mockRestore(); }
});

test("production moves 40 between simple and complex while processor has a different classification", async () => {
  const mock = setup();
  try {
    const view = render(<IcioExperiment topic="production" />);
    await view.findByRole("button", { name: "简单全球价值链" });
    fireEvent.click(view.getByRole("button", { name: "简单全球价值链" }));
    expect(view.getByText("总增加值 40 = 0 + 0 + 40 + 0")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "复杂全球价值链" }));
    expect(view.getByText("总增加值 40 = 0 + 0 + 0 + 40")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "乙国·加工品" }));
    expect(view.getByText("总增加值 60 = 0 + 60 + 0 + 0")).toBeTruthy();
  } finally { mock.mockRestore(); }
});

test("length switches forward/backward with numeric workings and preserves undefined GVC, then compares direct production", async () => {
  const mock = setup();
  try {
    const view = render(<IcioExperiment topic="length" />);
    await view.findByRole("button", { name: "复杂全球价值链" });
    fireEvent.click(view.getByRole("button", { name: "复杂全球价值链" }));
    expect(view.getByText("(1 × 40 + 0.4 × 100) ÷ 40 = 2")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "后向：从最终产品回溯" }));
    expect(view.getByText("(40 × 2 + 60 × 1) ÷ 100 = 1.4")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "直接生产" }));
    expect(view.getByText("(100 × 1) ÷ 100 = 1")).toBeTruthy();
    expect(view.getByText("没有中间加工，全部增加值只经过一次生产。")).toBeTruthy();
    const results = view.getByRole("region", { name: "教学指标计算结果" });
    expect(within(results).getByText("GVC位置指数").parentElement?.textContent).toBe("GVC位置指数—无量纲");
    fireEvent.click(view.getByRole("button", { name: "复杂全球价值链" }));
    expect(view.getByText("(40 × 2 + 60 × 1) ÷ 100 = 1.4")).toBeTruthy();
  } finally { mock.mockRestore(); }
});

test("failed teaching request offers retry without invented results", async () => {
  const mock = spyOn(api, "teachingIcio").mockRejectedValueOnce(new Error("测试网络错误")).mockResolvedValue({ scenarios: [chain] });
  try {
    const view = render(<IcioExperiment topic="trade" />);
    await view.findByRole("alert");
    expect(view.queryByRole("region", { name: "教学指标计算结果" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(view.getByText("总出口 = 100")).toBeTruthy());
  } finally { mock.mockRestore(); }
});

test("backward reading treats zero final demand as undefined when selecting an intermediate producer", async () => {
  const mock = setup();
  try {
    const view = render(<IcioExperiment topic="length" />);
    await view.findByRole("button", { name: "复杂全球价值链" });
    fireEvent.click(view.getByRole("button", { name: "复杂全球价值链" }));
    fireEvent.click(view.getByRole("button", { name: "后向：从最终产品回溯" }));
    fireEvent.click(view.getByRole("button", { name: "甲国·初级品" }));
    expect(view.getByText("后向长度 = —")).toBeTruthy();
    expect(view.getByText("该行业没有实际最终需求，因此本场景后向长度未定义；请选择有最终需求的加工品行业。")).toBeTruthy();
    expect(view.queryByText(/此值是其技术结构对应的单位产品后向长度/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "乙国·加工品" }));
    expect(view.getByText("(40 × 2 + 60 × 1) ÷ 100 = 1.4")).toBeTruthy();
  } finally { mock.mockRestore(); }
});

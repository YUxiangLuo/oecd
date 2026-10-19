import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ReportOutro } from "./report-outro";
import type { ClassroomReport, ReportReviewEstimate } from "./types";

const estimate: ReportReviewEstimate = {
  step: 13, outcome: "length", y_label: "全球价值链位置指数", unit: "比值，无单位", x_span: "当期＋滞后合计",
  value: .002, interval: [-.001, .005], value_text: "+0.0020", interval_text: "[-0.0010, +0.0050]",
  inference: "uncertain", inference_note: "95% 置信区间包含 0，尚不能拒绝所估参数为 0 的原假设；不显著不等于不存在关联。", n_obs: 200, years: [2016, 2020],
};
function report(): ClassroomReport {
  return {
    markdown: "# full report", state: "pending", score: null, feedback: "", graded_by: null,
    generated_at: "2026-10-19T10:00:00+09:00", updated_at: "2026-10-19T10:01:00+09:00", submitted_at: "2026-10-19T10:01:00+09:00", graded_at: null,
    provenance: { session_version: "test", generated_at: "2026-10-19T10:00:00+09:00", years: [2016, 2020], session_fingerprint: "test", runs: [], custom_results: [],
      review: { research_question: "已提交的问题 <script>test</script>", evidence_interpretation: "先看范围，再解释区间。", limitations: "这不是现实政策的因果估计。", results: [estimate], custom_models: [], evidence: [
        { step: 6, title: "贸易图表", chart_titles: ["出口构成"], countries: ["CHN 中国", "USA 美国"], industry_scope: "国家整体", industries: [], years: [2020] },
        { step: 9, title: "网络图表", chart_titles: ["行业网络趋势"], countries: ["CAN 加拿大"], industry_scope: "C26 计算机电子光学", industries: ["C26 计算机电子光学"], years: [2016, 2020] },
      ] },
    },
  };
}
const actions = () => ({ onClose: mock(() => {}), onExport: mock(() => {}), onViewReport: mock(() => {}), onReturnStep: mock((_step: number) => {}) });
afterEach(cleanup);

test("review shows report snapshot evidence with independent scopes, literal prose and named result units", () => {
  const view = render(<ReportOutro report={report()} {...actions()} />);
  expect(view.getByText("已提交的问题 <script>test</script>")).toBeTruthy();
  expect(view.getByRole("dialog").querySelector("script")).toBeNull();
  expect(view.getByText("CHN 中国、USA 美国 · 国家整体 · 2020")).toBeTruthy();
  expect(view.getByText("CAN 加拿大 · C26 计算机电子光学 · 2016、2020")).toBeTruthy();
  expect(view.getByText("+0.0020")).toBeTruthy();
  expect(view.getByText("比值，无单位")).toBeTruthy();
  expect(view.getByText(/95% 置信区间：\[-0.0010, \+0.0050\]/)).toBeTruthy();
  expect(view.getByText(/尚不能拒绝所估参数为 0 的原假设；不显著不等于不存在关联/)).toBeTruthy();
  expect(view.queryByRole("heading", { name: "自主模型比较" })).toBeNull();
});

test("only recorded optional models appear and retain each model's X span and unavailable values", () => {
  const saved = report();
  saved.provenance.review.custom_models.push({ step: 13, name: "只用滞后一期", specification: "L1.X；无控制变量；无固定效应", reference: estimate,
    result: { ...estimate, x_span: "仅 L1.X", value: null, interval: null, value_text: "—", interval_text: "无法推断", inference: "unavailable", inference_note: "未获得可用估计值，原因见报告中的模型说明。", n_obs: null, years: [] } });
  const view = render(<ReportOutro report={saved} {...actions()} />);
  const models = view.getByRole("region", { name: "自主模型比较" });
  expect(within(models).getByText("仅 L1.X")).toBeTruthy();
  expect(within(models).getByText("—")).toBeTruthy();
  expect(within(models).getByText("95% 置信区间：无法推断")).toBeTruthy();
  expect(within(models).getByText(/有效样本量 N = —/)).toBeTruthy();
});

test("zero score, draft and outdated reports have truthful receipts and export behavior", () => {
  const graded = { ...report(), state: "graded" as const, score: 0, feedback: "请重新核对样本范围。", graded_at: "2026-10-19T11:00:00+09:00" };
  const a = actions();
  const view = render(<ReportOutro report={graded} {...a} reportOutdated />);
  expect(view.getByText("已评阅 · 0 分")).toBeTruthy();
  expect(view.getByRole("region", { name: "教师评语" }).textContent).toContain(graded.feedback);
  fireEvent.click(view.getByRole("button", { name: "导出 PDF 留存" }));
  expect(a.onExport).toHaveBeenCalledTimes(1);
  view.rerender(<ReportOutro report={report()} {...a} reportOutdated />);
  expect(view.getByRole("region", { name: "报告提交回执" }).firstElementChild?.textContent).toStartWith("报告需更新");
  expect((view.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<ReportOutro report={{ ...report(), state: "draft", submitted_at: null }} {...a} />);
  expect(view.getByRole("heading", { name: "报告草稿 · 尚未提交" })).toBeTruthy();
  expect(view.queryByText("已提交 · 等待教师评阅")).toBeNull();
});

test("view, export, return to evidence and close are separate actions", () => {
  const a = actions(); const view = render(<ReportOutro report={report()} {...a} />);
  fireEvent.click(view.getByRole("button", { name: "查看完整报告" }));
  expect(a.onViewReport).toHaveBeenCalledTimes(1); expect(a.onClose).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "返回步骤 6 →" }));
  expect(a.onReturnStep).toHaveBeenCalledWith(6);
  fireEvent.click(view.getByRole("button", { name: "关闭回执" }));
  expect(a.onClose).toHaveBeenCalledTimes(1);
});

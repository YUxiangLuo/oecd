import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { lazy, useState, type ReactNode } from "react";
import { api } from "../../api";
import { LazyView } from "../../lazy-view";
import { ToastHost, clearToasts } from "../../toast";
import { MaterialCard } from "../../material-card";
import { ReportOutro } from "../../report-outro";
import type { ClassroomReport, TeachingCountriesResponse } from "../../types";
import type { ReportActions } from "../../use-session";
import { GateCard, RecordedMaterials, ReportLab } from "./report-lab";
import {
  REFLECTION_MAX_LENGTH, reflectionCountLabel, reflectionLength, codePointLength,
  limitInsertion, reportConflictMessage, reportOutdatedAdvice, reportGenerateLabel,
  reportWaitLabel, reportGenerateButtonLabel, summarizeReportGate, revealWithOffset,
  activateReportGateDestination, focusReportGateDestination, gradedExportRefusal,
} from "./report-lab-logic";

afterEach(() => { cleanup(); mock.restore(); clearToasts(); });
function report(state: ClassroomReport["state"]): ClassroomReport {
  return {
    markdown: "# report", state, score: state === "graded" ? 93 : null,
    feedback: state === "graded" ? "证据链完整" : "", graded_by: state === "graded" ? "teacher" : null,
    generated_at: "2026-08-13T00:00:00Z", updated_at: "2026-08-13T00:00:00Z",
    submitted_at: state === "draft" ? null : "2026-08-13T00:01:00Z",
    graded_at: state === "graded" ? "2026-08-13T00:02:00Z" : null,
    provenance: { release_id: "a".repeat(32), session_version: "experiment-session-simple-v4",
      generated_at: "2026-08-13T00:00:00Z", years: [2020], session_fingerprint: "fingerprint", runs: [], custom_results: [] },
  };
}
const actions = (): ReportActions => ({ reportOperation: null,
  runReport: mock(async () => undefined), refreshReport: mock(async () => undefined) });
const props = () => ({
  state: { data: {}, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {} },
  report: null, reportCurrent: true, reportGate: [], sessionStatus: "ready" as const,
  sessionUnsynced: false, sessionSyncing: false, reportActions: actions(), onNavigateStep: () => {},
});
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

test.each(["draft", "pending", "graded"] as const)("%s report has distinct status and one action group", (state) => {
  const view = render(<ReportLab {...props()} report={report(state)} />);
  expect(view.container.querySelectorAll(".report-actions")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "报告正文" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "研究问题" }).getAttribute("rows")).toBe("3");
  expect(screen.getByRole("button", { name: "导出 PDF" })).toBeTruthy();
  if (state === "draft") {
    expect(screen.getByText("草稿 · 尚未提交")).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交报告给老师" })).toBeTruthy();
    expect(view.container.querySelector(".report-print-grade")).toBeNull();
  } else {
    expect(screen.getByText("报告已交给老师")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新生成并提交" })).toBeTruthy();
    expect(screen.getByText("导出 PDF 仅供个人留存，不能代替提交。")).toBeTruthy();
    if (state === "pending") expect(screen.getByText(/等待教师评阅/)).toBeTruthy();
    else {
      expect(screen.getByRole("region", { name: "教师评语" }).textContent).toContain("证据链完整");
      expect(view.container.querySelector(".report-print-grade")?.textContent).toContain("93 分");
    }
  }
});

test("silent grading promises only the score; the score precedes submission actions", () => {
  const view = render(<ReportLab {...props()} report={{ ...report("graded"), feedback: "" }} />);
  expect(screen.getByRole("link", { name: "已评阅，查看分数" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "教师评语" })).toBeNull();
  expect(view.container.innerHTML.indexOf("report-score-card")).toBeLessThan(view.container.innerHTML.indexOf("report-submit-panel"));
});

test.each([null, undefined, false])("unknown or outdated validity (%s) cannot export an ungraded report", (current) => {
  const view = render(<ReportLab {...props()} report={report("draft")} reportCurrent={current} />);
  expect((screen.getByRole("button", { name: "导出 PDF" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "提交报告给老师" })).toBeNull();
  expect(screen.getByText(current == null ? "报告状态待核对，请联网后重试" : "报告尚未包含最新修改")).toBeTruthy();
  view.rerender(<ReportLab {...props()} report={report("draft")} />);
  expect((screen.getByRole("button", { name: "导出 PDF" }) as HTMLButtonElement).disabled).toBe(false);
});

test.each(["sessionUnsynced", "sessionSyncing"] as const)("%s blocks stale draft submission/export", (flag) => {
  render(<ReportLab {...props()} report={report("draft")} {...{ [flag]: true }} />);
  expect(screen.getByText("报告尚未包含最新修改")).toBeTruthy();
  expect((screen.getByRole("button", { name: "导出 PDF" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "提交报告给老师" })).toBeNull();
});

test.each(["loading", "unavailable"] as const)("%s disables report actions and editing", (status) => {
  const view = render(<ReportLab {...props()} sessionStatus={status} />);
  for (const button of view.container.querySelectorAll<HTMLButtonElement>(".report-actions button")) expect(button.disabled).toBe(true);
  expect((screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement).disabled).toBe(true);
});

test.each(["generate", "generate-submit", "submit"] as const)("%s delegates the selected public operation and report version", async (operation) => {
  const p = props();
  const run = spyOn(p.reportActions, "runReport").mockResolvedValue(report(operation === "generate" ? "draft" : "pending"));
  const draft = operation === "submit" ? report("draft") : null;
  render(<><ReportLab {...p} report={draft} /><ToastHost /></>);
  fireEvent.click(screen.getByRole("button", { name: operation === "submit" ? "提交报告给老师" : operation === "generate" ? "只生成草稿（不提交）" : "生成并提交报告" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith(operation, draft?.updated_at ?? null));
  if (operation === "generate") {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("报告草稿已生成，请预览后提交");
  } else {
    const dialog = screen.getByRole("dialog", { name: "报告已提交" });
    for (const text of ["提交成功 · 等待教师评阅", "计算并理解指标", "看变化与全球位置", "汇总四项回归结果"]) expect(within(dialog).getByText(text)).toBeTruthy();
    expect(within(dialog).queryByText("比较与验证")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  }
});

test("success receipt and toast cleanup wait for acknowledgement; failure never shows success", async () => {
  const p = props();
  let resolve!: (r: ClassroomReport) => void;
  spyOn(p.reportActions, "runReport").mockResolvedValueOnce(report("draft"))
    .mockRejectedValueOnce(new Error("网络中断"))
    .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<><ReportLab {...p} /><ToastHost /></>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "只生成草稿（不提交）" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
  expect(screen.getByRole("alert").textContent).toContain("网络中断");
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
  expect(view.container.querySelector(".toast-host")?.textContent).toContain("报告草稿已生成");
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { resolve(report("pending")); });
  expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
  expect(view.container.querySelector(".toast-host")).toBeNull();
});

test.each([true, false])("graded regeneration requires confirmation (current: %s); cancellation and double clicks are safe", async (current) => {
  const p = props();
  const run = spyOn(p.reportActions, "runReport").mockRejectedValue(new Error("服务不可用"));
  render(<ReportLab {...p} report={report("graded")} reportCurrent={current} />);
  const button = screen.getByRole("button", { name: current ? "重新生成并提交" : "更新报告并提交给老师" });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  const dialog = screen.getByRole("dialog", { name: "重新生成已评阅的报告？" });
  expect(dialog.textContent).toContain("清除现有评分和评语");
  expect(dialog.textContent).toContain("导出的 PDF 含评分与评语");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
  expect(run).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(button); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("服务不可用");
  expect(screen.getByText(/已评阅 · 93 分/)).toBeTruthy();
});

test("a shared report operation disables controls even after this step is remounted", () => {
  const p = props();
  render(<ReportLab {...p} reportActions={{ ...p.reportActions, reportOperation: "generate-submit" }} />);
  for (const button of screen.getAllByRole("button", { name: "正在生成报告…" })) expect((button as HTMLButtonElement).disabled).toBe(true);
});

test("generation reveals only a newly generated preview, not a restored draft", async () => {
  const p = props();
  spyOn(p.reportActions, "runReport").mockResolvedValue(report("draft"));
  const view = render(<ReportLab {...p} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "只生成草稿（不提交）" })); });
  view.rerender(<ReportLab {...p} report={report("draft")} />);
  await settle();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("报告正文");
  view.unmount();
  render(<ReportLab {...props()} report={report("draft")} />);
  await settle();
  expect(document.activeElement?.getAttribute("aria-label")).not.toBe("报告正文");
});

test("receipt closure restores its opener; auto-opened receipt returns to padded status card", async () => {
  const p = props();
  spyOn(p.reportActions, "runReport").mockResolvedValue(report("pending"));
  const view = render(<ReportLab {...p} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
  view.rerender(<ReportLab {...p} report={report("pending")} />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await settle();
  expect(document.activeElement?.id).toBe("report-status-card");
  expect(document.activeElement?.className).toBe("submit-card submit-card-plain");
  const opener = screen.getByRole("button", { name: "查看提交回执与实验总结" });
  opener.focus(); fireEvent.click(opener);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await settle();
  expect(document.activeElement).toBe(opener);
});

test("graded export refreshes its version, refuses removed grades and keeps local answers", async () => {
  const p = props();
  const latest = report("pending");
  const refresh = spyOn(p.reportActions, "refreshReport").mockResolvedValue(latest);
  const print = spyOn(globalThis, "print").mockImplementation(() => {});
  render(<ReportLab {...p} report={report("graded")} reportCurrent={false} state={{ ...p.state, data: { limitations: "我的局限" } }} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导出已评阅版本 PDF" })); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(print).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe(gradedExportRefusal(latest));
  expect((screen.getByRole("textbox", { name: "局限与反思" }) as HTMLTextAreaElement).value).toBe("我的局限");
});

test.each(["current", "offline"])("graded PDF carries score, feedback and report title (%s)", async (mode) => {
  const p = props();
  const graded = { ...report("graded"), markdown: "# 报告\n\n学生：演示学生 05\n\n正文", generated_at: "2026-10-09T03:05:00" };
  const refresh = spyOn(p.reportActions, "refreshReport");
  if (mode === "current") refresh.mockResolvedValue(graded); else refresh.mockRejectedValue(new Error("offline"));
  const titles: string[] = [];
  spyOn(globalThis, "print").mockImplementation(() => { titles.push(document.title); });
  document.title = "步骤 15";
  const view = render(<ReportLab {...p} report={graded} />);
  expect(view.container.querySelector(".report-print-grade")?.textContent).toContain("教师评语：证据链完整");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "导出 PDF" })); });
  await waitFor(() => expect(titles).toEqual(["实验报告 · 演示学生 05 · 2026-10-09"]));
  act(() => { window.dispatchEvent(new Event("afterprint")); });
  expect(document.title).toBe("步骤 15");
});

test("appendices fold on screen, open for printing and restore; submitted results panel folds", async () => {
  const p = props();
  const sectioned = { ...report("draft"), markdown: "# 报告\n\n## 结论\n\n结论段\n\n## 理解题答题记录\n\n答题\n\n## 报告溯源\n\n溯源" };
  const view = render(<ReportLab {...p} report={sectioned} />);
  await waitFor(() => expect(view.container.querySelectorAll(".report-body details.report-section")).toHaveLength(3));
  const open = () => [...view.container.querySelectorAll<HTMLDetailsElement>(".report-body details.report-section")].map((item) => item.open);
  expect(open()).toEqual([true, false, false]);
  act(() => { window.dispatchEvent(new Event("beforeprint")); }); expect(open()).toEqual([true, true, true]);
  act(() => { window.dispatchEvent(new Event("afterprint")); }); expect(open()).toEqual([true, false, false]);
  expect(view.container.querySelector<HTMLDetailsElement>("details.report-reference")?.open).toBe(true);
  view.rerender(<ReportLab {...p} report={{ ...sectioned, state: "pending" }} />);
  expect(view.container.querySelector<HTMLDetailsElement>("details.report-reference")?.open).toBe(false);
});

test("gate blocks locally, marks short fields, navigates and clears on acknowledged metadata", async () => {
  const p = props();
  const blocked = [{ step: 15, title: "原创分析", missing: ["填写研究问题"] }];
  const view = render(<ReportLab {...p} reportGate={blocked} />);
  const draft = screen.getByRole("button", { name: "只生成草稿（不提交）" });
  expect(draft.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(draft);
  expect(p.reportActions.runReport).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "研究问题" }).getAttribute("aria-invalid")).toBe("true");
  expect(view.container.querySelector(".report-gate-flash")).toBeTruthy();
  expect(screen.getByText(/还有 1 项没完成，现在还不能生成报告/)).toBeTruthy();
  view.rerender(<ReportLab {...p} reportGate={[]} />);
  expect(screen.queryByText("还不能生成报告")).toBeNull();
  spyOn(p.reportActions, "runReport").mockRejectedValue(Object.assign(new Error("缺项"), { blocked: [{ step: 9, title: "网络图表材料", missing: ["记录两个国家"] }] }));
  await act(async () => { fireEvent.click(draft); });
  expect(screen.getByRole("button", { name: "继续步骤 9" })).toBeTruthy();
  expect(view.container.innerHTML.indexOf("report-gate-panel")).toBeLessThan(view.container.innerHTML.indexOf('class="report-reflection"'));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("gate summary groups missing items and destination respects quiz-only and reflection focus", () => {
  const blocked = [{ step: 11, title: "回归实验", missing: ["完成理解题", "保存有效回归"] }, { step: 1, title: "数据浏览", missing: ["记录单元格"] }, { step: 15, title: "原创分析", missing: ["填写研究问题"] }];
  expect(summarizeReportGate(blocked).summary).toBe("步骤 1–14 中 2 个步骤还有 3 项待补齐；本步还有 1 项待完成");
  render(<GateCard blocked={blocked} onNavigateStep={() => {}} />);
  expect(screen.getByRole("button", { name: "继续步骤 1" })).toBeTruthy();
  expect(screen.getByText("查看全部缺项（4）")).toBeTruthy();
  const focused: string[] = [];
  const root = { getElementById: (id: string) => ({ focus: () => focused.push(id), scrollIntoView: () => {} }) };
  const frames: (() => void)[] = [];
  const scheduler = {
    requestAnimationFrame: (cb: FrameRequestCallback) => { frames.push(() => cb(0)); return 1; },
    cancelAnimationFrame: () => {},
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
  };
  activateReportGateDestination(7, () => {}, root, scheduler, true);
  activateReportGateDestination(8, () => {}, root, scheduler, false);
  frames.forEach((frame) => frame());
  expect(focused).toEqual(["quiz-title-7", "step-task-title-8"]);
  expect(focusReportGateDestination(9, { getElementById: () => null })).toBe(false);
});

test.each([11, 12, 13, 14])("quiz-only navigation waits for the cold step %s module", async (step) => {
  let loaded!: () => void;
  const Quiz = lazy(() => new Promise<{ default: () => ReactNode }>((resolve) => {
    loaded = () => resolve({ default: () => <h3 id={`quiz-title-${step}`} tabIndex={-1}>理解题</h3> });
  }));
  const revealed: HTMLElement[] = [];
  spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { revealed.push(this); });
  function Harness() {
    const [current, setCurrent] = useState(15);
    return current === 15
      ? <GateCard blocked={[{ step, title: "回归", missing: ["完成理解题"], quiz_only: true }]} onNavigateStep={setCurrent} />
      : <><h3 id={`step-task-title-${step}`} tabIndex={-1}>任务</h3><LazyView><Quiz /></LazyView></>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: `继续步骤 ${step}` }));
  await settle();
  expect(document.getElementById(`quiz-title-${step}`)).toBeNull();
  await act(async () => { loaded(); });
  await waitFor(() => expect(document.activeElement?.id).toBe(`quiz-title-${step}`));
  expect(revealed).toContain(document.getElementById(`quiz-title-${step}`)!);
});

test.each(["input", "navigation"])("pending quiz navigation yields to subsequent %s", async (reason) => {
  let loaded!: () => void;
  const Quiz = lazy(() => new Promise<{ default: () => ReactNode }>((resolve) => {
    loaded = () => resolve({ default: () => <h3 id="quiz-title-11" tabIndex={-1}>理解题</h3> });
  }));
  function Harness() {
    const [step, setStep] = useState(15);
    return <>
      <button onClick={() => setStep(step === 12 ? 11 : 12)}>其他导航</button>
      {step === 15 ? <GateCard blocked={[{ step: 11, title: "回归", missing: ["完成理解题"], quiz_only: true }]} onNavigateStep={setStep} />
        : <><h3 id={`step-task-title-${step}`} tabIndex={-1}>任务</h3>{step === 11 && <LazyView><Quiz /></LazyView>}</>}
    </>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "继续步骤 11" }));
  await settle();
  const other = screen.getByRole("button", { name: "其他导航" });
  if (reason === "input") fireEvent.keyDown(window, { key: "Tab" });
  else {
    // Programmatic navigation also cancels, without relying on a pointer/key event.
    fireEvent.click(other);
    await settle();
    fireEvent.click(other);
  }
  other.focus();
  await act(async () => { loaded(); });
  await screen.findByRole("heading", { name: "理解题" });
  await settle();
  expect(document.activeElement).toBe(other);
});

test.each([false, true])("lazy material navigation honors cancellation: %s", async (cancel) => {
  const revealed: HTMLElement[] = [];
  spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { revealed.push(this); });
  function Harness() {
    const [step, setStep] = useState(15); const [loaded, setLoaded] = useState(false);
    return step === 15 ? <RecordedMaterials steps={[{ n: 6, title: "图表", lab: "viz" }]} blocked={[]} onNavigateStep={setStep} />
      : <><h3 id="step-task-title-6" tabIndex={-1}>任务</h3><button onClick={() => setLoaded(true)}>加载完成</button>{loaded && <MaterialCard state="missing" summary="等待记录" />}</>;
  }
  render(<Harness />); fireEvent.click(screen.getByRole("button", { name: "步骤 6 · 图表" })); await settle();
  if (cancel) fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "加载完成" }));
  await settle();
  if (cancel) { expect(document.activeElement?.id).not.toBe("step-material-action"); expect(revealed).toHaveLength(0); }
  else await waitFor(() => expect(document.activeElement?.id).toBe("step-material-action"));
});

test("reflection editing preserves text, counts code points, clips only insertions and warns about wide emoji", () => {
  const base = "甲".repeat(REFLECTION_MAX_LENGTH - 3);
  const limited = limitInsertion(base, `${base}👨‍👩‍👧`, base.length + 8);
  expect([limited.value, limited.cut, limited.wide]).toEqual([base, true, true]);
  expect(codePointLength("😀")).toBe(1);
  expect(reflectionLength(" \n\u200b")).toBe(0);
  function Harness() {
    const p = props(); const [data, setData] = useState<Record<string, unknown>>({ limitations: base });
    return <ReportLab {...p} state={{ ...p.state, data, save: (patch) => setData((old) => ({ ...old, ...patch })) }} />;
  }
  render(<Harness />);
  fireEvent.change(screen.getByRole("textbox", { name: "局限与反思" }), { target: { value: `${base}👨‍👩‍👧` } });
  expect(screen.getByText(/这个表情按实际字符计算占多个字，剩余字数不够/)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "局限与反思" }) as HTMLTextAreaElement).value).toBe(base);
  fireEvent.change(screen.getByRole("textbox", { name: "研究问题" }), { target: { value: "# **原样文字**" } });
  expect(screen.queryByText(/这个表情按实际字符计算占多个字/)).toBeNull();
  expect((screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement).value).toBe("# **原样文字**");
});

test("writing hints distinguish default regression from optional experiments and show save conflicts", () => {
  const p = props();
  const view = render(<ReportLab {...p} />);
  expect(screen.getByText(/文字按原样写进报告/)).toBeTruthy();
  expect(screen.queryByText(/你还把模型实验记入了报告/)).toBeNull();
  spyOn(api, "regressionOptions").mockImplementation(() => new Promise(() => {}));
  const experiment = { spec: { x_lags: [0, 1] }, snapshot: { depvar_label: "外国增加值项占比", depvar_kind: "share", result: { n_obs: 16000, years: [2016, 2020], cumulative: null, coefs: [] } } };
  view.rerender(<ReportLab {...p} getStep={(n) => n === 11 ? { experiment } as never : undefined} />);
  expect(screen.getByText(/你还把模型实验记入了报告/)).toBeTruthy();
  expect(screen.getByText(/你还把模型实验记入了报告/).textContent).toContain("不要一律写两年累计");
  expect(screen.getByRole("textbox", { name: "结果解释" }).getAttribute("placeholder")).toContain("模型实验“……”的 X 各项合计");
  view.rerender(<ReportLab {...p} sessionUnsynced state={{ ...p.state, syncConflict: true, syncError: "版本变化" }} />);
  expect(screen.getByRole("region", { name: "报告完成清单" }).textContent).toContain("请先复制需要保留的内容");
  expect(screen.getByRole("button", { name: "请先处理保存异常" })).toBeTruthy();
});

test("material table uses saved labels, fallback summaries, missing links and optional experiment note", () => {
  const navigated: number[] = [];
  const data: Record<number, Record<string, unknown>> = { 1: { observation: {}, material_label: "保存的读数" }, 3: { observations: [{}] }, 11: { run: {}, experiment: { spec: {} }, material_label: "默认模型" } };
  render(<RecordedMaterials steps={[1, 3, 6, 11, 15].map((n) => ({ n, title: `步骤名${n}`, lab: "viz" }))} getStep={(n) => data[n] as never} blocked={[{ step: 6, title: "图表", missing: ["记录图表"] }]} onNavigateStep={(n) => navigated.push(n)} />);
  const rows = [...document.querySelectorAll(".report-materials tbody tr")].map((row) => row.textContent);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toContain("保存的读数"); expect(rows[1]).toContain("材料已保存，暂无摘要");
  expect(rows[2]).toContain("未记录记录图表"); expect(rows[3]).toContain("另记入报告的模型实验：1 个（选做）");
  fireEvent.click(screen.getByRole("button", { name: "步骤 6 · 步骤名6" })); expect(navigated).toEqual([6]);
});

test("country-list retry enriches submitted service material without changing report or saving", async () => {
  const saved = { compared: ["CHN", "AUS"], teaching_industry: "D", material_label: "例子：CHN 中国 对 AUS 澳大利亚 · D 电力燃气", teaching_observation: { country: "CHN", industry: "D", year: 2020, teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0 } };
  const submitted = report("pending"); const before = JSON.stringify({ saved, submitted });
  spyOn(api, "teachingCountries").mockRejectedValueOnce(new Error("network unavailable"))
    .mockResolvedValue({ countries: [{ country: "CHN", taxed: true }, { country: "AUS", taxed: false }], taxed_rule: { scope: "goods industries (ICIO sectors A-C)" } } as TeachingCountriesResponse);
  const p = props(); const save = spyOn(p.state, "save");
  render(<ReportLab {...p} report={submitted} steps={[{ n: 10, title: "政策冲击", lab: "shock" }]} getStep={(n) => n === 10 ? saved as never : undefined} />);
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("材料已保留，暂不显示国家税况");
  fireEvent.click(screen.getByRole("button", { name: "重试国家税况" }));
  await waitFor(() => expect(document.querySelector(".report-materials tbody tr td:last-child")?.textContent).toBe("例子：CHN 中国（被加税） 对 AUS 澳大利亚（未被加税） · D 电力燃气（非货物行业，不加税）"));
  expect(save).not.toHaveBeenCalled(); expect(p.reportActions.runReport).not.toHaveBeenCalled();
  expect(JSON.stringify({ saved, submitted })).toBe(before);
  expect((screen.getByRole("button", { name: "导出 PDF" }) as HTMLButtonElement).disabled).toBe(false);
});

test("report labels retain minimum, maximum, save and resubmission semantics", () => {
  expect(reflectionCountLabel(0, 40)).toBe("已写 0 / 2400 字 · 最低 40 字");
  expect(reflectionCountLabel(83, 40)).toContain("已达最低 40 字");
  expect(reflectionCountLabel(2400, 40)).toContain("已达上限");
  expect(reflectionCountLabel(2380, 40, 2400, true)).toContain("空格、换行和表情符号按实际字符计");
  expect(reportWaitLabel("loading", false, false)).toBe("正在恢复实验记录…");
  expect(reportGenerateButtonLabel(null, false, "ready", true, false, "offline")).toBe("重试保存后才能生成草稿");
  expect(reportGenerateLabel(report("pending"))).toBe("重新生成并提交");
  expect(reportOutdatedAdvice("graded")).toContain("清除原评分和评语");
  expect(reportConflictMessage(report("pending"), report("graded"))).toContain("老师刚刚评阅");
  expect(reportConflictMessage(report("draft"), report("pending"))).toContain("已在别处提交");
});

test("revealing a conflict leaves space above it in the course scroller", () => {
  const calls: ScrollToOptions[] = [];
  const scroller = { scrollTop: 10, getBoundingClientRect: () => ({ top: 20 }), scrollTo: (o: ScrollToOptions) => calls.push(o) };
  revealWithOffset({ closest: () => scroller, getBoundingClientRect: () => ({ top: 500 }) } as unknown as HTMLElement);
  expect(calls).toEqual([{ top: 474, left: 0, behavior: "smooth" }]);
});

test("receipt distinguishes outdated content from busy export and keeps pending status", () => {
  const p = { report: report("pending"), onClose: () => {}, onExport: () => {} };
  const view = render(<ReportOutro {...p} exportDisabled />);
  const disabled = () => (screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled;
  expect(screen.queryByText(/后续修改尚未纳入/)).toBeNull(); expect(disabled()).toBe(true);
  view.rerender(<ReportOutro {...p} reportOutdated />);
  const receipt = screen.getByRole("region", { name: "报告提交回执" });
  expect(receipt.firstElementChild?.textContent).toStartWith("报告需更新");
  expect(receipt.textContent).not.toContain("提交成功");
  expect(screen.queryByText(/清除当前评分/)).toBeNull(); expect(disabled()).toBe(true);
  expect(screen.getByText("已提交的版本 · 等待教师评阅")).toBeTruthy();
  view.rerender(<ReportOutro {...p} />);
  expect(screen.getByText(/你可以离开页面/)).toBeTruthy(); expect(disabled()).toBe(false);
  view.rerender(<ReportOutro {...p} report={report("graded")} />);
  expect(screen.queryByText(/查看报告与老师的评阅/)).toBeNull();
  expect(screen.getByText("报告与评阅已保存在服务器上，可随时回到步骤 15 查看。")).toBeTruthy();
  expect(screen.getByText(/^评阅时间：/)).toBeTruthy();
  view.unmount();
  const lab = props();
  render(<ReportLab {...lab} report={report("graded")} sessionUnsynced />);
  fireEvent.click(screen.getByRole("button", { name: "查看提交回执与实验总结" }));
  const dialog = screen.getByRole("dialog", { name: "报告已评阅" });
  expect(within(dialog).getByRole("region", { name: "教师评语" }).textContent).toBe("教师评语：证据链完整");
  expect(within(dialog).getByText(/重新生成会清除当前评分与评语/)).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(false);
  expect(lab.reportActions.runReport).not.toHaveBeenCalled();
});

test("action groups and graded warnings name only the current or outdated action", () => {
  const p = props(); const view = render(<ReportLab {...p} />);
  const names = () => [...view.container.querySelectorAll(".report-actions button")].map((b) => b.textContent);
  expect(names()).toEqual(["生成并提交报告", "只生成草稿（不提交）"]);
  view.rerender(<ReportLab {...p} report={report("graded")} reportCurrent={false} />);
  expect(names()).toEqual(["更新报告并提交给老师", "查看提交回执与实验总结", "导出已评阅版本 PDF"]);
  expect(view.container.querySelector(".reg-rerun-warning")?.textContent).toBe("注意“更新报告并提交给老师”会替换已评阅报告，并清除原评分和评语。");
  view.rerender(<ReportLab {...p} report={report("graded")} />);
  expect(names()).toEqual(["查看提交回执与实验总结", "导出 PDF", "重新生成并提交"]);
  expect(view.container.querySelector(".reg-rerun-warning")?.textContent).toBe("注意“重新生成并提交”会替换已评阅报告，并清除原评分和评语。");
});

test("autosave, offline actions and keyboard shortcut destinations remain actionable", () => {
  const p = props(); const view = render(<ReportLab {...p} />);
  expect(screen.getByText("已保存")).toBeTruthy();
  for (const name of ["写分析", "提交与导出"]) {
    const target = screen.getByRole("link", { name }).getAttribute("href")!;
    expect(document.querySelector(target)?.getAttribute("tabindex")).toBe("-1");
  }
  view.rerender(<ReportLab {...p} sessionSyncing />); expect(screen.getByText("保存中…")).toBeTruthy();
  view.rerender(<ReportLab {...p} sessionUnsynced state={{ ...p.state, syncError: "网络连接中断" }} />);
  expect([...view.container.querySelectorAll(".report-actions button")].map((b) => b.textContent)).toEqual(["保存失败，请先重试", "重试保存后才能生成草稿"]);
  expect(screen.getByText("未保存")).toBeTruthy();
  view.rerender(<ReportLab {...p} sessionStatus="loading" />); expect(screen.queryByText("已保存")).toBeNull();
});

test("reflection visible length agrees with server Unicode and whitespace rules", () => {
  for (const [value, count] of [["  贸易 😀\n\n分析  ", 7], ["😀😀", 2], ["👨‍👩‍👧", 3], ["🇨🇳", 2], ["e\u0301", 1], ["\u200b".repeat(40), 0], ["\u202e结果\u202c", 2], ["甲\u001f乙", 3]] as const) expect(reflectionLength(value)).toBe(count);
});

test("length limiting preserves both sides, selections, whole emoji and deletions of overlong restored text", () => {
  const original = "甲".repeat(REFLECTION_MAX_LENGTH - 1);
  const start = limitInsertion(original, "插".repeat(18) + original, 18);
  expect(start).toMatchObject({ value: "插" + original, caret: 1, cut: true });
  const middle = limitInsertion(original, original.slice(0, 100) + "中间插入" + original.slice(100), 104);
  expect(middle).toMatchObject({ value: original.slice(0, 100) + "中" + original.slice(100), caret: 101 });
  const replaced = limitInsertion(original, original.slice(0, 10) + "替".repeat(30) + original.slice(20), 40);
  expect(replaced.value).toBe(original.slice(0, 10) + "替".repeat(11) + original.slice(20));
  const base = "甲".repeat(REFLECTION_MAX_LENGTH - 3);
  const next = base + "😀👨‍👩‍👧乙";
  expect(limitInsertion(base, next, next.length).value).toBe(base + "😀");
  expect(limitInsertion(original, "新新" + original, null).value).toBe("新" + original);
  const over = "超".repeat(REFLECTION_MAX_LENGTH + 5);
  expect(limitInsertion(over, over.slice(1), 0)).toEqual({ value: over.slice(1), caret: 0, cut: false });
  expect(limitInsertion("abc", "abXc", 3)).toEqual({ value: "abXc", caret: 3, cut: false });
});

test("clipped paste keeps the ending and caret, exposes the warning accessibly then clears it on another edit", () => {
  const ending = "结尾十个字很重要啊";
  const original = "甲".repeat(REFLECTION_MAX_LENGTH - 1 - ending.length) + ending;
  function Harness() {
    const p = props(); const [data, setData] = useState<Record<string, unknown>>({ limitations: original });
    return <ReportLab {...p} state={{ ...p.state, data, save: (patch) => setData((old) => ({ ...old, ...patch })) }} />;
  }
  render(<Harness />);
  const field = screen.getByRole("textbox", { name: "局限与反思" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "粘贴".repeat(9) + original } });
  expect(field.value).toBe("粘" + original); expect(field.value.endsWith(ending)).toBe(true); expect(field.selectionStart).toBe(1);
  expect(screen.getByText(/刚粘贴或输入的文字有一部分没有保留，原有文字没有改动/)).toBeTruthy();
  expect(screen.getByText(/已写 2400 \/ 2400 字 · 已达上限/)).toBeTruthy();
  expect(field.getAttribute("aria-describedby")).toContain("report-paste-");
  fireEvent.change(screen.getByRole("textbox", { name: "研究问题" }), { target: { value: "我比较了中国和美国" } });
  expect(screen.queryByText(/超过 2400 字上限/)).toBeNull();
  expect(field.getAttribute("aria-describedby")).not.toContain("report-paste-");
});

test("step 15 gate focuses only the unfinished reflection locally, not another step", () => {
  const p = props(); const navigate = mock(() => {});
  render(<ReportLab {...p} onNavigateStep={navigate} reportGate={[{ step: 15, title: "原创分析", missing: ["填写证据解释"] }]}
    state={{ ...p.state, data: { research_question: "123456789012", evidence_interpretation: "不足", limitations: "甲".repeat(30) } }} />);
  expect(document.querySelectorAll('[data-report-reflection-incomplete="true"]')).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "去写你的分析" }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "结果解释" }));
  expect(navigate).not.toHaveBeenCalled();
});

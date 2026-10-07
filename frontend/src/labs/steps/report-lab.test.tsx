import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { api, ApiError } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastHost } from "../../toast";
import { ReportOutro } from "../../report-outro";
import type { ClassroomReport, ReportMutationResponse } from "../../types";
import {
  GateCard,
  REPORT_REFLECTION_INCOMPLETE_SELECTOR,
  ReportLab,
  ReportStatus,
  activateReportGateDestination,
  focusReportGateDestination,
  reflectionCountLabel,
  reportGenerateButtonLabel,
  reportGenerateLabel,
  reportWaitLabel,
  summarizeReportGate,
} from "./report-lab";

afterEach(cleanup);

function report(state: ClassroomReport["state"]): ClassroomReport {
  return {
    markdown: "# report",
    provenance: {
      release_id: "a".repeat(32),
      session_version: "experiment-session-simple-v3",
      generated_at: "2026-08-13T00:00:00Z",
      years: [2020],
      session_fingerprint: "fingerprint",
      runs: [],
    },
    state,
    score: state === "graded" ? 93 : null,
    feedback: state === "graded" ? "证据链完整" : "",
    graded_by: state === "graded" ? "teacher" : null,
    generated_at: "2026-08-13T00:00:00Z",
    updated_at: "2026-08-13T00:00:00Z",
    submitted_at: state === "draft" ? null : "2026-08-13T00:01:00Z",
    graded_at: state === "graded" ? "2026-08-13T00:02:00Z" : null,
  };
}

describe("step 15 report states", () => {
  test("discards an old generation gate when a newer saved session has no missing materials", async () => {
    const blocked = [{ step: 15, title: "原创分析", missing: ["填写研究问题"] }];
    const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(Object.assign(new Error("缺少材料"), { blocked }));
    const props = {
      state: { data: {}, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {} },
      report: null,
      reportGate: blocked,
      sessionStatus: "ready" as const,
      sessionUnsynced: false,
      sessionSyncing: false,
      onFlushSession: async () => {},
      onNavigateStep: () => {},
      onReportChanged: () => {},
    };
    try {
      const view = render(<ReportLab {...props} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "根据实验记录生成报告" })); });
      expect(screen.getByText("还不能生成报告")).toBeDefined();
      view.rerender(<ReportLab {...props} reportGate={[]} state={{ ...props.state, data: { research_question: "已保存的新分析" } }} />);
      expect(screen.queryByText("还不能生成报告")).toBeNull();
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      generate.mockRestore();
    }
  });

  test("a second click while the regenerate confirmation is open neither opens another nor strands the first", async () => {
    const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new Error("服务不可用"));
    const props = {
      state: { data: {}, save: () => {}, complete: true, syncing: false, syncError: null, syncNow: () => {} },
      report: report("graded"),
      reportGate: [],
      sessionStatus: "ready" as const,
      sessionUnsynced: false,
      sessionSyncing: false,
      onFlushSession: async () => {},
      onNavigateStep: () => {},
      onReportChanged: () => {},
    };
    try {
      render(<ReportLab {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" }));
        fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" }));
      });
      expect(screen.getAllByRole("button", { name: "确定重新生成" })).toHaveLength(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "确定重新生成" })).toBeNull();
      // The guard is released again: cancelling and retrying still reaches the server.
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消" })); });
      expect(generate).toHaveBeenCalledTimes(1);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generate.mockRestore();
    }
  });

  test("does not generate or replace an existing report when flushing session edits fails", async () => {
    const generate = spyOn(api.classroom, "generateReport");
    const confirm = spyOn(window, "confirm").mockReturnValue(true);
    const changed: unknown[] = [];
    try {
      render(<ReportLab
        state={{ data: {}, save: () => {}, complete: true, syncing: false, syncError: "保存失败", syncNow: () => {} }}
        report={report("graded")} reportGate={[]} sessionStatus="ready" sessionUnsynced={true} sessionSyncing={false}
        onFlushSession={async () => { throw new Error("保存失败，请重试"); }} onNavigateStep={() => {}}
        onReportChanged={(response) => changed.push(response)}
      />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存失败，请先重试" })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
      expect(generate).not.toHaveBeenCalled();
      expect(changed).toEqual([]);
      expect(screen.getByText(/已评阅 · 93 分/)).toBeDefined();
    } finally {
      generate.mockRestore();
      confirm.mockRestore();
    }
  });

  test("renders draft, pending, and graded feedback distinctly", () => {
    expect(renderToStaticMarkup(<ReportStatus report={report("draft")} />)).toContain("尚未提交");
    expect(renderToStaticMarkup(<ReportStatus report={report("pending")} />)).toContain("等待教师评阅");
    const graded = renderToStaticMarkup(<ReportStatus report={report("graded")} />);
    expect(graded).toContain("93 分");
    expect(graded).toContain("证据链完整");
  });

  test("shows progress against both the minimum and the hard maximum", () => {
    expect(reflectionCountLabel(0, 40)).toBe("已写 0 / 2400 字 · 最低 40 字");
    expect(reflectionCountLabel(30, 40)).toBe("已写 30 / 2400 字 · 最低 40 字");
    expect(reflectionCountLabel(83, 40)).toBe("已写 83 / 2400 字 · 已达最低 40 字");
    expect(reflectionCountLabel(2400, 40)).toBe("已写 2400 / 2400 字 · 已达上限");
  });

  test("uses resubmission semantics after submission or grading", () => {
    expect(reportGenerateLabel(null)).toBe("根据实验记录生成报告");
    expect(reportGenerateLabel(report("draft"))).toBe("重新生成报告");
    expect(reportGenerateLabel(report("pending"))).toBe("重新生成并提交");
    expect(reportGenerateLabel(report("graded"))).toBe("重新生成并提交");
  });

  test("keeps the generate action distinguishable from the step title", () => {
    const stepTitle = "生成实验报告";
    const first = reportGenerateLabel(null);
    expect(first).toBe("根据实验记录生成报告");
    expect(first.includes(stepTitle)).toBe(false);
    const html = renderToStaticMarkup(<ReportLab
      state={{
        data: {},
        save: () => {},
        complete: true,
        syncing: false,
        syncError: null,
        syncNow: () => {},
      }}
      report={null}
      reportGate={[]}
      sessionStatus="ready"
      sessionUnsynced={false}
      sessionSyncing={false}
      onFlushSession={async () => {}}
      onNavigateStep={() => {}}
      onReportChanged={() => {}}
    />);
    expect(html).toContain(">根据实验记录生成报告<");
    const generateButton = html.match(/<button[^>]*class="secondary"[^>]*>根据实验记录生成报告<\/button>/)?.[0];
    expect(generateButton).toBeDefined();
    expect(generateButton).not.toContain("aria-label=");
  });

  test("puts restore and save status on the generate button itself", () => {
    expect(reportWaitLabel("loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportWaitLabel("ready", true, false)).toBe("正在保存实验记录…");
    expect(reportWaitLabel("ready", false, false)).toBeNull();
    expect(reportWaitLabel("ready", true, false, "session changed")).toBe("保存失败，请先重试");
    expect(reportGenerateButtonLabel(null, false, "ready", true, false, "offline")).toBe("保存失败，请先重试");
    expect(reportGenerateButtonLabel(null, false, "loading", false, false)).toBe("正在恢复实验记录…");
    expect(reportGenerateButtonLabel(null, true, "loading", false, false)).toBe("服务端生成中…");
  });

  test("renders actionable report-gate links", () => {
    const html = renderToStaticMarkup(<GateCard
      blocked={[{ step: 11, title: "回归实验", missing: ["保存有效回归"] }]}
      onNavigateStep={() => {}}
    />);
    expect(html).toContain("步骤 11");
    expect(html).toContain("保存有效回归");
    expect(html).toContain("gate-link");
    expect(html).toContain("继续步骤 11");
    expect(html).toContain("查看全部缺项（1）");
  });

  test("keeps the step-15 action local and focuses the first unfinished reflection field", () => {
    const html = renderToStaticMarkup(<GateCard
      blocked={[{ step: 15, title: "原创分析与反思", missing: ["填写证据解释"] }]}
      onNavigateStep={() => {}}
    />);
    expect(html).toContain("继续填写原创分析");
    expect(html).not.toContain("继续步骤 15");

    const navigated: number[] = [];
    const focused: string[] = [];
    let scheduled = 0;
    const activated = activateReportGateDestination(
      15,
      (step) => navigated.push(step),
      {
        getElementById: () => null,
        querySelector: (selector) => {
          expect(selector).toBe(REPORT_REFLECTION_INCOMPLETE_SELECTOR);
          return { focus: () => focused.push("unfinished-field") } as unknown as Element;
        },
      },
      {
        requestAnimationFrame: () => {
          scheduled += 1;
          return 1;
        },
      },
    );
    expect(activated).toBe(true);
    expect(navigated).toEqual([]);
    expect(scheduled).toBe(0);
    expect(focused).toEqual(["unfinished-field"]);
  });

  test("marks only below-minimum reflection fields as local focus candidates", () => {
    const html = renderToStaticMarkup(<ReportLab
      state={{
        data: {
          research_question: "123456789012",
          evidence_interpretation: "不足",
          limitations: "123456789012345678901234567890",
        },
        save: () => {},
        complete: true,
        syncing: false,
        syncError: null,
        syncNow: () => {},
      }}
      report={null}
      reportGate={[{ step: 15, title: "原创分析与反思", missing: ["填写证据解释"] }]}
      sessionStatus="ready"
      sessionUnsynced={false}
      sessionSyncing={false}
      onFlushSession={async () => {}}
      onNavigateStep={() => {}}
      onReportChanged={() => {}}
    />);
    expect(html.match(/data-report-reflection-incomplete="true"/g)).toHaveLength(1);
  });

  test("summarizes and groups a long gate before revealing every item", () => {
    const overview = summarizeReportGate([
      { step: 11, title: "贸易流回归", missing: ["完成理解题", "保存有效回归"] },
      { step: 1, title: "数据浏览", missing: ["记录单元格"] },
      { step: 15, title: "原创分析", missing: ["填写研究问题"] },
      { step: 2, title: "贸易流指标", missing: ["记录两个国家"] },
    ]);
    expect(overview.summary).toBe("第 1–14 步中 3 个步骤还有 4 项待补齐；本步还有 1 项待完成");
    expect(overview.next?.step).toBe(1);
    expect(overview.groups.map((group) => group.label)).toEqual([
      "数据接入", "指标计算", "关税回归", "实验报告",
    ]);
  });

  test("focuses the destination task heading after a report-gate navigation", () => {
    const calls: unknown[] = [];
    const found = focusReportGateDestination(11, {
      getElementById: (id) => id === "step-task-title-11"
        ? { focus: (options) => calls.push(options) }
        : null,
    });
    expect(found).toBe(true);
    expect(calls).toEqual([{ preventScroll: true }]);
    expect(focusReportGateDestination(9, { getElementById: () => null })).toBe(false);
  });

  test("offers PDF export after a report has been generated", () => {
    const html = renderToStaticMarkup(<ReportLab
      state={{
        data: {},
        save: () => {},
        complete: true,
        syncing: false,
        syncError: null,
        syncNow: () => {},
      }}
      report={report("graded")}
      reportGate={[]}
      sessionStatus="ready"
      sessionUnsynced={false}
      sessionSyncing={false}
      onFlushSession={async () => {}}
      onNavigateStep={() => {}}
      onReportChanged={() => {}}
    />);
    expect(html).toContain("导出 PDF");
  });
});


test("blocks stale snapshot export and submission after edits, saves and reloads until regeneration", () => {
  const original = report("draft");
  const props = {
    state: { data: {}, save: () => {}, complete: true, syncing: false, syncError: null, syncNow: () => {} },
    report: original, reportGate: [], sessionStatus: "ready" as const,
    sessionUnsynced: false, sessionSyncing: false, sessionUpdatedAt: "2026-08-12T23:59:00Z",
    onFlushSession: async () => {}, onNavigateStep: () => {}, onReportChanged: () => {},
  };
  const view = render(<ReportLab {...props} />);
  const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
  expect(disabled("导出 PDF")).toBe(false);
  view.rerender(<ReportLab {...props} sessionUnsynced />);
  expect(screen.getByText("报告尚未包含最新修改")).toBeDefined();
  expect(disabled("导出 PDF")).toBe(true);
  // A stale draft offers “更新报告并提交给老师” instead of submitting the outdated snapshot.
  expect([...view.container.querySelectorAll(".report-actions button")].some((button) => button.textContent === "提交报告给老师")).toBe(false);
  view.unmount();
  const saved = { ...props, sessionUpdatedAt: "2026-08-13T00:05:00Z" };
  const restored = render(<ReportLab {...saved} report={{ ...original, updated_at: "2026-08-13T00:10:00Z" }} />);
  expect(disabled("导出 PDF")).toBe(true);
  restored.rerender(<ReportLab {...saved} report={{ ...original, generated_at: "2026-08-13T00:06:00Z" }} />);
  expect(disabled("导出 PDF")).toBe(false);
  expect(disabled("提交报告给老师")).toBe(false);
});

const mutation = (state: ClassroomReport["state"]): ReportMutationResponse => ({
  report: report(state), report_gate: [], material_gate: [],
  completion: { steps: [], completed: [], completed_count: 0, total: 15 },
});
const finishProps = {
  state: { data: {}, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {} },
  report: null, reportGate: [], sessionStatus: "ready" as const, sessionUnsynced: false, sessionSyncing: false,
  onFlushSession: async () => {}, onNavigateStep: () => {}, onReportChanged: (_response: ReportMutationResponse) => {},
};

test("one-click finish flushes then generates then submits; outro appears only after acknowledged submission", async () => {
  const order: string[] = [];
  let acknowledge!: (value: ReportMutationResponse) => void;
  const generate = spyOn(api.classroom, "generateReport").mockImplementation(async () => { order.push("generate"); return mutation("draft"); });
  const submit = spyOn(api.classroom, "submitReport").mockImplementation(() => { order.push("submit"); return new Promise((resolve) => { acknowledge = resolve; }); });
  try {
    render(<><ReportLab {...finishProps} onFlushSession={async () => { order.push("flush"); }} onReportChanged={(r) => order.push(r.report.state)} /><ToastHost /></>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(order).toEqual(["flush", "generate", "draft", "submit"]);
    expect(generate).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { acknowledge(mutation("pending")); });
    const dialog = screen.getByRole("dialog", { name: "报告已提交" });
    expect(within(dialog).getByText("提交成功 · 等待教师评阅")).toBeTruthy();
    expect(within(dialog).getByText("计算并理解指标")).toBeTruthy();
    expect(within(dialog).getByText("看变化与全球位置")).toBeTruthy();
    expect(within(dialog).getByText("汇总四项回归结果")).toBeTruthy();
    expect(within(dialog).queryByText("比较与验证")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement?.textContent).toBe("报告已提交");
    expect(order).toEqual(["flush", "generate", "draft", "submit", "pending"]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); }
});

test("a 409 because the teacher just graded shows the current report, not a phantom draft", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new ApiError(409, "报告或评分已更新，请刷新页面核对后再确认重新生成", "Conflict"));
  const latest = mutation("graded");
  const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: "a".repeat(32), session: { version: "experiment-session-simple-v3", steps: {}, shared: {} }, updated_at: null, ...latest });
  const changed: string[] = [];
  try {
    render(<ReportLab {...finishProps} report={report("pending")} onReportChanged={(r) => changed.push(r.report.state)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /重新生成|更新报告/ })); });
    expect(changed).toEqual(["graded"]);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("刚刚有了新的评阅");
    expect(alert).not.toContain("草稿会保留");
  } finally { generate.mockRestore(); session.mockRestore(); }
});

test("draft generation keeps toast feedback when no outro is shown", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  try {
    render(<><ReportLab {...finishProps} /><ToastHost /></>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "根据实验记录生成报告" })); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("报告草稿已生成，请预览后提交");
  } finally { generate.mockRestore(); }
});

test("failed submission retains generated draft and never opens a success outro", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
  const submit = spyOn(api.classroom, "submitReport").mockRejectedValue(new Error("网络中断"));
  const changed: string[] = [];
  try {
    render(<ReportLab {...finishProps} onReportChanged={(r) => changed.push(r.report.state)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(changed).toEqual(["draft"]);
    expect(screen.getByRole("alert").textContent).toContain("网络中断");
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); }
});

for (const action of ["提交报告给老师", "生成并提交报告"]) {
  test(`${action} removes earlier draft feedback only after submission succeeds`, async () => {
    const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("draft"));
    let acknowledge!: (value: ReportMutationResponse) => void;
    const submit = spyOn(api.classroom, "submitReport").mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    try {
      const view = render(<><ReportLab {...finishProps} /><ToastHost /></>);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "根据实验记录生成报告" })); });
      if (action === "提交报告给老师") {
        view.rerender(<><ReportLab {...finishProps} report={report("draft")} /><ToastHost /></>);
      }
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: action })); });
      expect(view.container.querySelector(".toast-host")?.textContent).toContain("报告草稿已生成");
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => { acknowledge(mutation("pending")); });
      expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
      expect(view.container.querySelector(".toast-host")).toBeNull();
    } finally { generate.mockRestore(); submit.mockRestore(); }
  });
}

test("material gate stops one-click submission and stays above the writing fields", async () => {
  const blocked = [{ step: 9, title: "网络图表材料", missing: ["记录两个国家"] }];
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(Object.assign(new Error("缺项"), { blocked }));
  const submit = spyOn(api.classroom, "submitReport");
  try {
    const view = render(<ReportLab {...finishProps} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "生成并提交报告" })); });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "继续步骤 9" })).toBeTruthy();
    const html = view.container.innerHTML;
    expect(html.indexOf("report-gate-panel")).toBeLessThan(html.indexOf('class="report-reflection"'));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); }
});

for (const button of ["重新生成并提交", "更新报告并提交给老师"]) {
  test(`graded report requires confirmation through ${button}, and cancelling does not mutate it`, async () => {
    const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("pending"));
    const submit = spyOn(api.classroom, "submitReport");
    let flushes = 0;
    let mutations = 0;
    const gradedReport = { ...report("graded"), updated_at: "2026-08-13T00:02:00.123456Z" };
    try {
      // “更新…” is offered for an outdated report, “重新生成并提交” only for a current one.
      render(<ReportLab {...finishProps} report={gradedReport}
        sessionUpdatedAt={button === "更新报告并提交给老师" ? "2026-08-14T00:00:00Z" : "2026-08-12T00:00:00Z"}
        onFlushSession={async () => { flushes++; }} onReportChanged={() => { mutations++; }} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: button })); });
      const dialog = screen.getByRole("dialog", { name: "重新生成已评阅的报告？" });
      expect(dialog.textContent).toContain("清除现有评分和评语");
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
      expect(screen.queryByRole("dialog", { name: "重新生成已评阅的报告？" })).toBeNull();
      expect(generate).not.toHaveBeenCalled();
      expect(flushes).toBe(0);
      expect(mutations).toBe(0);
      expect(screen.getByText(/已评阅 · 93 分/)).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: button })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确定重新生成" })); });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith(gradedReport.updated_at);
      expect(flushes).toBe(1);
      expect(mutations).toBe(1);
      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
    } finally { generate.mockRestore(); submit.mockRestore(); }
  });
}

test("a stale report conflict does not retry, submit, or replace the displayed report", async () => {
  const message = "报告或评分已更新，请刷新页面核对后再确认重新生成";
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new Error(message));
  const submit = spyOn(api.classroom, "submitReport");
  const changed = spyOn(finishProps, "onReportChanged");
  const pending = { ...report("pending"), updated_at: "2026-08-13T00:01:00.654321Z" };
  try {
    render(<ReportLab {...finishProps} report={pending} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(pending.updated_at);
    expect(submit).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText(message, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { generate.mockRestore(); submit.mockRestore(); changed.mockRestore(); }
});

test("regenerating a submitted report uses server resubmission directly without a second submit", async () => {
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(mutation("pending"));
  const submit = spyOn(api.classroom, "submitReport");
  const confirm = spyOn(window, "confirm");
  try {
    render(<ReportLab {...finishProps} report={report("pending")} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新生成并提交" })); });
    expect(confirm).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "报告已提交" })).toBeTruthy();
  } finally { generate.mockRestore(); submit.mockRestore(); confirm.mockRestore(); }
});

test("restored graded receipt is available without submitting again; outdated export remains disabled", () => {
  const submit = spyOn(api.classroom, "submitReport");
  try {
    render(<ReportLab {...finishProps} report={report("graded")} sessionUnsynced />);
    fireEvent.click(screen.getByRole("button", { name: "查看提交回执与实验总结" }));
    const dialog = screen.getByRole("dialog", { name: "报告已评阅" });
    expect(within(dialog).getByText("已评阅 · 93 分")).toBeTruthy();
    expect(within(dialog).getByText("教师评语：证据链完整")).toBeTruthy();
    const receipt = within(dialog).getByRole("region", { name: "报告提交回执" });
    expect(within(receipt).getByText(/后续修改尚未纳入这份报告/)).toBeTruthy();
    expect(within(receipt).getByText(/重新生成会清除当前评分与评语/)).toBeTruthy();
    expect(within(dialog).queryByText(/你可以离开页面/)).toBeNull();
    expect((within(dialog).getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  } finally { submit.mockRestore(); }
});

test("receipt distinguishes busy export from outdated content and preserves pending state", () => {
  const props = { report: report("pending"), onClose: () => {}, onExport: () => {} };
  const { rerender } = render(<ReportOutro {...props} exportDisabled />);
  expect(screen.queryByText(/后续修改尚未纳入/)).toBeNull();
  expect((screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ReportOutro {...props} reportOutdated />);
  expect(screen.getByText(/后续修改尚未纳入/)).toBeTruthy();
  expect(screen.queryByText(/清除当前评分/)).toBeNull();
  expect(screen.getByText("提交成功 · 等待教师评阅")).toBeTruthy();
  expect((screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<ReportOutro {...props} />);
  expect(screen.getByText(/你可以离开页面/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "导出 PDF 留存" }) as HTMLButtonElement).disabled).toBe(false);
});

test("each report state shows one action group in the submit panel, without duplicate update buttons", () => {
  const names = (view: ReturnType<typeof render>) =>
    [...view.container.querySelectorAll(".report-submit-panel .report-actions button")].map((button) => button.textContent);
  const none = render(<ReportLab {...finishProps} />);
  expect(names(none)).toEqual(["生成并提交报告", "根据实验记录生成报告"]);
  none.unmount();
  const outdated = render(<ReportLab {...finishProps} report={report("graded")} sessionUpdatedAt="2026-08-14T00:00:00Z" />);
  expect(names(outdated)).toEqual(["更新报告并提交给老师", "查看提交回执与实验总结", "导出 PDF"]);
  outdated.unmount();
  const current = render(<ReportLab {...finishProps} report={report("graded")} sessionUpdatedAt="2026-08-12T00:00:00Z" />);
  expect(names(current)).toEqual(["查看提交回执与实验总结", "导出 PDF", "重新生成并提交"]);
  current.unmount();
});

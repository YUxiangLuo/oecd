import { describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { TeacherReport } from "../types";
import { GradeView } from "./reports";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const report: TeacherReport = {
  account_id: 7,
  username: "student",
  display_name: "学生",
  student_no: "S-1",
  markdown: "# report",
  provenance: {
    release_id: "a".repeat(32),
    session_version: "experiment-session-simple-v2",
    generated_at: "2026-08-13T00:00:00Z",
    years: [2020],
    session_fingerprint: "fingerprint",
    runs: [],
  },
  state: "graded",
  score: 90,
  feedback: "旧评语",
  graded_by: "teacher",
  generated_at: "2026-08-13T00:00:00Z",
  updated_at: "2026-08-13T00:00:00Z",
  submitted_at: "2026-08-13T00:01:00Z",
  graded_at: "2026-08-13T00:02:00Z",
};

describe("stale teacher report recovery", () => {
  test("announces a 409 and offers an explicit latest-report reload", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "报告内容已更新，请重新加载后评阅" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    let reloads = 0;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<GradeView data={report} grader="teacher" onBack={() => {}} onReload={() => { reloads += 1; }} />);
      });
      const update = renderer!.root.findAllByType("button").find((node) => node.children.join("") === "更新评阅")!;
      await act(async () => update.props.onClick());

      expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("报告内容已更新");
      const reload = renderer!.root.findAllByType("button").find((node) => node.children.join("") === "加载最新报告")!;
      expect(update.props.disabled).toBe(true);
      await act(async () => reload.props.onClick());
      expect(reloads).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (renderer) await act(async () => renderer?.unmount());
    }
  });
});

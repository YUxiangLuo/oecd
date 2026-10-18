import { spyOn } from "bun:test";
import { api } from "../api";
import type { TeacherReportPage, TeacherReportSummary } from "../types";
import { matchesAcademicFilter } from "./academic-filter";
import { searchKey } from "./text";

/** A small paged test server for UI flows; production filtering is tested against PostgreSQL. */
export function mockReports(initial: TeacherReportSummary[] = []) {
  let rows = initial;
  let failure: Error | null = null;
  const count = (items: TeacherReportSummary[]) => ({
    pending: items.filter((r) => r.state === "pending").length,
    graded: items.filter((r) => r.state === "graded").length,
  });
  const summary = spyOn(api.classroom, "reportSummary").mockImplementation(async () => count(rows));
  const list = spyOn(api.classroom, "reports").mockImplementation(async (query = {}): Promise<TeacherReportPage> => {
    if (failure) throw failure;
    const needle = searchKey(query.q ?? "");
    const narrowed = rows.filter((r) => matchesAcademicFilter(r.enrollments, query.term_id ?? null, query.class_id ?? null))
      .filter((r) => !needle || [r.username, r.display_name, r.student_no].some((v) => searchKey(v).includes(needle)));
    const selected = narrowed.filter((r) => !query.state || query.state === "all" || r.state === query.state);
    const size = query.page_size ?? 25;
    const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(selected.length / size)));
    return {
      reports: selected.slice((page - 1) * size, page * size), total: selected.length, page, page_size: size,
      counts: count(narrowed), overall: count(rows),
    };
  });
  return {
    list, summary,
    setRows(next: TeacherReportSummary[]) { rows = next; failure = null; },
    fail(error: Error) { failure = error; },
    mockRestore() { list.mockRestore(); summary.mockRestore(); },
  };
}

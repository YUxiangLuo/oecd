import type { Assignment, EnrollmentRow } from "../types";

export interface AssignmentDraft {
  slug: string;
  title: string;
  releaseTag: string;
  opensAt: string;
  dueAt: string;
}

function toApiDateTime(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildAssignmentPayload(draft: AssignmentDraft, courseRunId: number, manifestId: string) {
  return {
    course_run_id: courseRunId,
    slug: draft.slug.trim(),
    title: draft.title.trim(),
    manifest_id: manifestId,
    release_tag: draft.releaseTag.trim(),
    opens_at: toApiDateTime(draft.opensAt),
    due_at: toApiDateTime(draft.dueAt),
  };
}

export function assignmentMatchesManifest(assignment: Assignment, currentManifest: string | null | undefined): boolean {
  return Boolean(currentManifest) && assignment.manifest_id === currentManifest;
}

export function activeEnrollmentAccountIds(rows: EnrollmentRow[]): Set<number> {
  return new Set(rows.filter((row) => row.active).map((row) => row.account_id));
}

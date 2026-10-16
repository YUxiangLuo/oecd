import type { AcademicSemester, ClassEnrollment } from "../types";

export const UNASSIGNED_CLASS = -1;

/** "2026 秋 · 一班", with "（已归档）" when the class or its semester is archived (as the filter lists them). */
export function enrollmentLabel(item: ClassEnrollment, semesters: readonly AcademicSemester[]): string {
  const semester = semesters.find((candidate) => candidate.id === item.term_id);
  const group = semester?.classes.find((candidate) => candidate.id === item.class_id);
  const archived = semester != null && (!semester.is_active || group?.is_active === false);
  return `${item.term_name} · ${item.class_name}${archived ? "（已归档）" : ""}`;
}

export function matchesAcademicFilter(
  enrollments: ClassEnrollment[],
  semesterId: number | null,
  classId: number | null,
): boolean {
  if (semesterId == null) return true;
  const inSemester = enrollments.find((item) => item.term_id === semesterId);
  if (classId == null) return Boolean(inSemester);
  if (classId === UNASSIGNED_CLASS) return !inSemester;
  return inSemester?.class_id === classId;
}

/** Semesters (or classes) in use first, archived ones after, each group in its own order: the one a teacher filters
 *  by is near the top however many old semesters there are. */
export function activeFirst<T extends { is_active: boolean }>(items: readonly T[]): T[] {
  return [...items.filter((item) => item.is_active), ...items.filter((item) => !item.is_active)];
}

export function AcademicFilters({
  semesters,
  semesterId,
  classId,
  onSemesterChange,
  onClassChange,
}: {
  semesters: AcademicSemester[];
  semesterId: number | null;
  classId: number | null;
  onSemesterChange: (value: number | null) => void;
  onClassChange: (value: number | null) => void;
}) {
  const semester = semesters.find((item) => item.id === semesterId);
  return (
    <div className="academic-filters" aria-label="学期和班级筛选">
      <select
        aria-label="筛选学期"
        value={semesterId ?? ""}
        onChange={(event) => {
          onSemesterChange(event.target.value ? Number(event.target.value) : null);
          onClassChange(null);
        }}
      >
        <option value="">全部学生</option>
        {activeFirst(semesters).map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? "" : "（已归档）"}</option>)}
      </select>
      {semester && (
        <select aria-label="筛选班级" value={classId ?? ""} onChange={(event) => onClassChange(event.target.value ? Number(event.target.value) : null)}>
          <option value="">该学期全部已分班学生</option>
          <option value={UNASSIGNED_CLASS}>该学期未分班</option>
          {activeFirst(semester.classes).map((group) => <option key={group.id} value={group.id}>{group.name}{group.is_active ? "" : "（已归档）"}</option>)}
        </select>
      )}
    </div>
  );
}

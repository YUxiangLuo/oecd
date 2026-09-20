import type { AcademicSemester, ClassEnrollment } from "../types";

export const UNASSIGNED_CLASS = -1;

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
        <option value="">全部学期与未分班</option>
        {semesters.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? "" : "（已归档）"}</option>)}
      </select>
      {semester && (
        <select aria-label="筛选班级" value={classId ?? ""} onChange={(event) => onClassChange(event.target.value ? Number(event.target.value) : null)}>
          <option value="">该学期全部已分班学生</option>
          <option value={UNASSIGNED_CLASS}>该学期未分班</option>
          {semester.classes.map((group) => <option key={group.id} value={group.id}>{group.name}{group.is_active ? "" : "（已归档）"}</option>)}
        </select>
      )}
    </div>
  );
}

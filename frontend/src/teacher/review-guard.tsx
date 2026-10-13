import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

const LEAVE_MESSAGE = "当前评阅尚未保存，离开将丢失分数或评语。确定离开吗？";

type ReviewState = { dirty: boolean; saving: boolean; message?: string };
type ReviewGuard = {
  publish: (state: ReviewState) => void;
  clear: () => void;
  attempt: (leave: () => void) => boolean;
};

const emptyGuard: ReviewGuard = {
  publish: () => {},
  clear: () => {},
  attempt: (leave) => { leave(); return true; },
};

const ReviewGuardContext = createContext<ReviewGuard>(emptyGuard);

export function TeacherReviewGuardProvider({ children }: { children: ReactNode }) {
  const state = useRef<ReviewState>({ dirty: false, saving: false });
  const publish = useCallback((next: ReviewState) => { state.current = next; }, []);
  const clear = useCallback(() => { state.current = { dirty: false, saving: false }; }, []);
  const attempt = useCallback((leave: () => void) => {
    if (state.current.saving) return false;
    if (state.current.dirty && !window.confirm(state.current.message ?? LEAVE_MESSAGE)) return false;
    leave();
    return true;
  }, []);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!state.current.dirty && !state.current.saving) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);

  const guard = useMemo(() => ({ publish, clear, attempt }), [publish, clear, attempt]);
  return <ReviewGuardContext.Provider value={guard}>{children}</ReviewGuardContext.Provider>;
}

export const useTeacherReviewGuard = () => useContext(ReviewGuardContext);
export { LEAVE_MESSAGE };

/** Running a step's regression: one request at a time, aborted on leaving, retried after a 429 countdown. */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { RegressionOutcome, RegressionResponse } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { TEACHING_MODEL_VERSION, type SavedRegressionRun } from "./saved-run";

/** Steps whose run was still in flight when the student left the step (the request is aborted then). */
const interruptedRuns = new Set<RegressionOutcome>();
export const INTERRUPTED_RUN_NOTE = "上次计算没有完成，请重新计算。";

export function useRegressionRun({ outcome, runName, onStart, onSaved }: {
  outcome: RegressionOutcome;
  /** "贸易流回归": names the failure ("贸易流回归未完成"). */
  runName: string;
  /** Called as a run starts (the page clears its preview and asks for the bars). */
  onStart?: () => void;
  /** Called with the run to save as the step's material. */
  onSaved: (run: SavedRegressionRun) => void;
}) {
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // A run cut off by leaving the step earlier: said once, until the next run starts.
  const [interrupted, setInterrupted] = useState(() => interruptedRuns.has(outcome));
  // A 429 carries Retry-After: the retry button waits it out with a visible countdown.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt == null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) setRetryAt(null);
    }, 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const retryWait = retryAt == null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const runController = useRef<AbortController | null>(null);
  // Set by a run started from the button: the page scrolls to the verdict once the result is in.
  const scrollToVerdictAfterRun = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    // Said once: the note is in state now, and a later visit starts clean.
    interruptedRuns.delete(outcome);
    return () => {
      mountedRef.current = false;
      // Leaving the step aborts the run and nothing is saved: the step says so when the student comes back.
      if (runningRef.current) interruptedRuns.add(outcome);
      runController.current?.abort();
    };
  }, []);

  /** Run the step's model (the default Y); the response is the step's result and its report material. */
  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    runController.current = controller;
    setRunning(true);
    setError(null);
    setInterrupted(false);
    onStart?.();
    try {
      const response = await api.runRegression(outcome, controller.signal, null);
      if (!mountedRef.current) return;
      if (response.model_snapshot?.version !== TEACHING_MODEL_VERSION || !response.variable_catalog) {
        throw new Error(`页面版本已更新，结果没有保存。请刷新页面后再点“计算${runName}”`);
      }
      onSaved({
        design: response.design, result: response.result,
        disclaimer: response.disclaimer,
        model_snapshot: response.model_snapshot, variable_catalog: response.variable_catalog,
      });
      scrollToVerdictAfterRun.current = true;
      setResult(response);
    } catch (cause) {
      if (mountedRef.current) {
        setError(userFacingRequestError(cause, `${runName}未完成`));
        if (cause instanceof ApiError && cause.status === 429 && cause.retryAfter) {
          setNow(Date.now());
          setRetryAt(Date.now() + cause.retryAfter * 1000);
        }
      }
    } finally {
      if (runController.current === controller) runController.current = null;
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  return { result, setResult, error, running, runningRef, interrupted, retryWait, run, scrollToVerdictAfterRun };
}

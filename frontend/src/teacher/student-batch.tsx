import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api, ApiError } from "../api";
import type { AcademicSemester } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { normalizeLabel, stripInvisibleEdges } from "./text";
import { Modal, StatusPill, useModalErrorFocus } from "./ui";

export const ROSTER_MAX_ROWS = 200;

export type RosterSeparator = "tab" | "comma" | "spaces" | "space";

const SEPARATOR_PATTERNS: Record<RosterSeparator, RegExp> = {
  tab: /\t/,
  // Half- and full-width commas (a roster typed with a Chinese input method).
  comma: /[,，]/,
  // Two or more spaces between the columns; a single space may sit inside a name.
  spaces: /[ 　]{2,}/,
  // A single space, only when every line is exactly two words ("0012 张三").
  space: /[ 　]+/,
};

/**
 * The column separator of a pasted roster, decided for the whole text first: tab (copied from Excel), then
 * comma (CSV, half- or full-width), then two or more spaces, then a single space when every line is exactly
 * two words. Null otherwise. `parseRoster` asks again for a single line the shared separator does not split.
 */
export function detectRosterSeparator(lines: readonly string[]): RosterSeparator | null {
  const trimmed = lines.map(stripInvisibleEdges);
  if (trimmed.some((line) => line.includes("\t"))) return "tab";
  if (trimmed.some((line) => SEPARATOR_PATTERNS.comma.test(line))) return "comma";
  if (trimmed.some((line) => /\S[ 　]{2,}\S/.test(line))) return "spaces";
  const filled = trimmed.filter(Boolean);
  if (filled.length && filled.every((line) => /^\S+[ 　]+\S+$/.test(line))) return "space";
  return null;
}

/** A header row, wherever it is: a line naming both columns and holding no digits (so no actual 学号). */
function isRosterHeader(line: string) {
  return line.includes("学号") && line.includes("姓名") && !/[0-9０-９]/.test(line);
}

/** CSV exports may quote their cells: "0012","张三". */
function unquote(cell: string) {
  const value = stripInvisibleEdges(cell);
  return value.length >= 2 && value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

/** One line's cells; empty cells after the name (Excel copied one column too many) are dropped. */
function splitRosterLine(line: string, separator: RosterSeparator | null) {
  const cells = (separator ? stripInvisibleEdges(line).split(SEPARATOR_PATTERNS[separator]) : [line]).map(unquote);
  while (cells.length > 2 && !cells[cells.length - 1]) cells.pop();
  if (cells.length === 2 && !normalizeLabel(cells[1])) cells.pop();
  return cells;
}

export const ROSTER_COLUMNS_MISSING = "没有识别出学号、姓名两列。请从 Excel 直接复制这两列，或每行写成“学号,姓名”。";

/**
 * Parse a pasted two-column roster. Line numbers refer to the text as pasted (header and blank
 * lines included), and every problem is reported at once so the teacher can fix them in one pass.
 * Cells are cleaned as the server cleans them: 学号 loses surrounding spaces and zero-width characters,
 * 姓名 is normalized (full-width letters, zero-width characters, repeated spaces).
 */
export function parseRoster(text: string) {
  const lines = text.split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => stripInvisibleEdges(line));
  const header = lines.find(({ line }) => isRosterHeader(line));
  // A header written 姓名 first ("姓名,学号") swaps the columns.
  const swapped = header != null && header.line.indexOf("姓名") < header.line.indexOf("学号");
  const rows = lines.filter(({ line }) => !isRosterHeader(line));
  if (!rows.length) throw new Error(`请先粘贴学生名单（每次最多 ${ROSTER_MAX_ROWS} 人）`);
  if (rows.length > ROSTER_MAX_ROWS) {
    throw new Error(`每次最多 ${ROSTER_MAX_ROWS} 名学生，当前粘贴了 ${rows.length} 行；请分批导入`);
  }
  const separator = detectRosterSeparator(rows.map(({ line }) => line));
  const seen = new Map<string, number>();
  const errors: string[] = [];
  let columnErrors = 0;
  const accounts: { username: string; display_name: string }[] = [];
  for (const { line, number } of rows) {
    let cells = splitRosterLine(line, separator);
    // A roster pasted from several sources mixes separators (line 1 copied from Excel with a tab, line 2 typed
    // with spaces): a line the shared separator does not split in two is read on its own.
    if (cells.length !== 2) {
      const own = detectRosterSeparator([line]);
      if (own && own !== separator) {
        const retried = splitRosterLine(line, own);
        if (retried.length === 2) cells = retried;
      }
    }
    const [first, second] = swapped ? [cells[1], cells[0]] : [cells[0], cells[1]];
    const username = stripInvisibleEdges(first ?? "");
    const display_name = normalizeLabel(second ?? "");
    if (cells.length !== 2) {
      columnErrors++;
      // Three or more words: most likely a name with a space ("Li Si"), which only a tab or comma can keep whole.
      const words = stripInvisibleEdges(line).split(/\s+/).filter(Boolean).length;
      errors.push(`第 ${number} 行：需要学号和姓名两列${words > 2 ? "（姓名含空格时，请用制表符或逗号分隔学号和姓名）" : ""}`);
    } else if (display_name.length > 60) {
      errors.push(`第 ${number} 行：姓名不能超过 60 字`);
    } else if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username)) {
      errors.push(`第 ${number} 行：学号须为 2–40 位字母、数字、下划线、点或连字符`);
    } else if (seen.has(username)) {
      errors.push(`第 ${number} 行：学号 ${username} 与第 ${seen.get(username)} 行重复`);
    } else {
      seen.set(username, number);
      accounts.push({ username, display_name });
    }
  }
  // Every line lacking its two columns is one problem (an unrecognized separator), not N copies of it.
  if (rows.length > 1 && columnErrors === rows.length) throw new Error(ROSTER_COLUMNS_MISSING);
  if (errors.length) {
    const shown = errors.slice(0, 10);
    if (errors.length > 10) shown.push(`另有 ${errors.length - 10} 处问题`);
    throw new Error(shown.join("\n"));
  }
  return accounts;
}

/** Characters Windows and macOS refuse in a file name. */
const UNSAFE_FILE_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** "<学期>-<班级>-学生账号清单-<YYYYMMDD>.txt", so lists from several classes and days stay apart. */
export function rosterFileName(semester: string, className: string, date: Date): string {
  const safe = (value: string) => value.replace(UNSAFE_FILE_CHARACTERS, "_").trim() || "未命名";
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
  return `${safe(semester)}-${safe(className)}-学生账号清单-${day}.txt`;
}

/** The downloaded list, tab-separated, with the class on every row (the list may be printed or cut up). */
export function rosterFileContent(
  accounts: readonly { username: string; display_name: string; password: string }[],
  classLabel: string,
): string {
  return "学号（用户名）\t姓名\t初始密码\t班级\n"
    + accounts.map((row) => `${row.username}\t${row.display_name}\t${row.password}\t${classLabel}`).join("\n");
}

/** The active classes a roster can go to, labelled "学期 · 班级" (several semesters may have a 一班). */
export function batchClassOptions(semesters: readonly AcademicSemester[]) {
  return semesters.filter((semester) => semester.is_active).flatMap((semester) => semester.classes
    .filter((group) => group.is_active)
    .map((group) => ({ id: group.id, semester: semester.name, name: group.name, label: `${semester.name} · ${group.name}` })));
}

type Account = ReturnType<typeof parseRoster>[number] & { password: string };

/** A request the server answered and refused (validation, conflict): nothing was created, the roster can be edited. */
function refusedByServer(cause: unknown) {
  return cause instanceof ApiError && cause.status < 500;
}

/** "（2026001、2026002 等）": the conflicting 学号 named in the summary line, at most five. */
function conflictList(existing: readonly string[]) {
  return `（${existing.slice(0, 5).join("、")}${existing.length > 5 ? " 等" : ""}）`;
}

export function StudentBatchModal({ semesters, initialClassId, onClose, onCreated }: {
  semesters: AcademicSemester[]; initialClassId: number | null; onClose: () => void; onCreated: () => void;
}) {
  const [classId, setClassId] = useState(initialClassId ?? "");
  const [text, setText] = useState("");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [done, setDone] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // The server refused the creation: nothing was created and the downloaded list is void.
  const [refused, setRefused] = useState(false);
  const errorRef = useModalErrorFocus(error || null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const classOptions = batchClassOptions(semesters);
  const chosen = classOptions.find((option) => option.id === classId);
  // Where focus goes once the view switches (preview ⇄ edit); the old focused control is unmounted.
  const focusAfterSwitch = useRef<"status" | "text" | null>(null);
  useEffect(() => {
    const target = focusAfterSwitch.current === "status" ? statusRef.current : focusAfterSwitch.current === "text" ? textRef.current : null;
    focusAfterSwitch.current = null;
    target?.focus();
  }, [accounts]);
  const close = () => {
    if (!busy && (!attempted || done || window.confirm("创建结果还没确认。关闭后请到“学生与进度”核对。确定关闭？"))) onClose();
  };
  const preview = async () => {
    setError("");
    if (!classId) return setError("请先选择班级；还没有班级时，请到“学期与班级”新建");
    let students: Account[];
    try {
      students = parseRoster(text).map((row) => ({ ...row,
        password: Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) => v.toString(16).padStart(2, "0")).join(""),
      }));
    } catch (cause) {
      return setError((cause as Error).message);
    }
    setBusy(true);
    try {
      const result = await api.classroom.createStudentBatch({ class_id: Number(classId), students, preview: true });
      focusAfterSwitch.current = "status";
      setAccounts(students); setExisting(result.existing); setDownloaded(false);
    } catch (cause) { setError(userFacingRequestError(cause, "预览失败")); }
    finally { setBusy(false); }
  };
  const backToEdit = () => {
    focusAfterSwitch.current = "text";
    setAccounts(null); setError(""); setRefused(false);
  };
  const download = () => {
    if (!accounts) return;
    const content = rosterFileContent(accounts, chosen?.label ?? "");
    const url = URL.createObjectURL(new Blob(["﻿", content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = rosterFileName(chosen?.semester ?? "", chosen?.name ?? "", new Date()); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
  };
  const createLabel = `创建 ${accounts?.length ?? 0} 个账号`;
  // The list is created all at once or not at all: with a used 学号 nothing can be created, so the disabled
  // button says why instead of promising accounts.
  const blockedLabel = refused ? "没有创建，请返回修改" : existing.length ? `${existing.length} 个学号已被使用，无法创建` : null;
  const submit = async () => {
    if (!accounts || busy) return;
    setBusy(true); setError(""); setAttempted(true);
    try {
      await api.classroom.createStudentBatch({ class_id: Number(classId), students: accounts, preview: false });
      setDone(true); onCreated();
      // The create button is gone; the status line says what happened next.
      window.requestAnimationFrame(() => statusRef.current?.focus());
    } catch (cause) {
      const message = userFacingRequestError(cause, "创建失败");
      const end = /[。！？.!?]$/.test(message) ? "" : "。";
      if (refusedByServer(cause)) {
        // The server answered: nothing was created, so the roster can be fixed and previewed again.
        setAttempted(false);
        setRefused(true);
        setError(`${message}${end}\n刚下载的清单已作废。请点“返回修改”，重新预览后再下载新清单。`);
      } else {
        setError(`${message}${end}无法确认是否已创建。可以再点一次“${createLabel}”（清单和密码不变），或关闭后到“学生与进度”查看这些学生是否已出现。`);
      }
    }
    finally { setBusy(false); }
  };
  const rowStatus = (username: string) => done ? <StatusPill tone="ok">已创建</StatusPill>
    : refused ? <StatusPill tone="muted">未创建</StatusPill>
      : existing.includes(username) ? <StatusPill tone="warn">学号已被使用</StatusPill>
        : <StatusPill tone="info">待创建</StatusPill>;
  // With the class already chosen (opened from a class row or a class filter), start where the roster is pasted.
  return <Modal title="批量导入学生" width={620} onClose={close} initialFocusRef={initialClassId ? textRef : undefined}>
    <div className="modal-form batch-form">
      <LabeledControl label="所属班级">{(id) => <select id={id} disabled={busy || !!accounts} value={classId} onChange={(e) => setClassId(Number(e.target.value) || "")}>
        <option value="">请选择班级</option>
        {classOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>}</LabeledControl>
      {!accounts ? <>
        <p>从 Excel 选中“学号、姓名”两列，复制后粘贴到下面（每次最多 {ROSTER_MAX_ROWS} 人）；也可以每行写成“学号,姓名”。学号就是学生的登录用户名，开头的 0 要保留。</p>
        <LabeledControl label="学生名单">{(id) => <textarea ref={textRef} id={id} rows={8} disabled={busy} value={text} onChange={(e) => setText(e.target.value)} placeholder={"学号\t姓名\n2026001\t张三\n2026002\t李四"} />}</LabeledControl>
      </> : <>
        <p ref={statusRef} role="status" tabIndex={-1}>{done
          ? `已添加 ${accounts.length} 名学生。请按最后一次下载的账号清单逐人发放账号，并提醒学生登录后修改密码。`
          : refused ? `共 ${accounts.length} 人，都没有创建；请返回修改。`
          : existing.length ? `共 ${accounts.length} 人，其中 ${existing.length} 个学号已有账号${conflictList(existing)}，请返回修改名单。`
            : `共 ${accounts.length} 人，可以创建。`}</p>
        <ScrollableRegion label="学生名单预览" className="table-wrap batch-preview">
          <table className="data-table"><thead><tr><th>状态</th><th>学号（用户名）</th><th>姓名</th></tr></thead>
            <tbody>{accounts.map((row) => <tr key={row.username} className={!done && !refused && existing.includes(row.username) ? "batch-row-conflict" : undefined}>
              <td>{rowStatus(row.username)}</td><td className="mono">{row.username}</td>
              <td className="batch-name-cell" title={row.display_name}>{row.display_name}</td>
            </tr>)}</tbody>
          </table>
        </ScrollableRegion>
        {!existing.length && !refused && <>
          {!done && <p>清单含初始密码，请先下载保存。逐人发放账号，不要将整份清单发到群里。</p>}
          <button disabled={busy} onClick={download}>{done ? "再次下载账号清单" : "下载账号清单"}</button>
          <p className="muted batch-download-hint">可以用记事本打开。用 Excel 打开时，请把学号列设为“文本”，否则开头的 0 会被删除。</p>
          {downloaded && !done && <p>请确认文件已保存，再创建账号。</p>}</>}
      </>}
      {error && <div ref={errorRef} className="error-box" role="alert" tabIndex={-1} style={{ whiteSpace: "pre-line" }}>{error}</div>}
      <div className="modal-actions">
        <button disabled={busy} onClick={close}>{done ? "完成" : "取消"}</button>
        {accounts && !done && !attempted && <button disabled={busy} onClick={backToEdit}>返回修改</button>}
        {!accounts ? <button className="primary" disabled={busy} onClick={() => void preview()}>{busy ? "正在预览…" : "预览名单"}</button>
          : !done && <button className="primary" disabled={busy || !!existing.length || !downloaded || refused} onClick={() => void submit()}>{busy ? "创建中…" : blockedLabel ?? createLabel}</button>}
      </div>
    </div>
  </Modal>;
}

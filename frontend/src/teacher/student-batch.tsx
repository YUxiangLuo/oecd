import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api, ApiError } from "../api";
import type { AcademicSemester } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { normalizeLabel, stripInvisibleEdges } from "./text";
import { Modal, useModalErrorFocus } from "./ui";

export const ROSTER_MAX_ROWS = 200;

/**
 * Parse a pasted two-column roster. Line numbers refer to the text as pasted (header and blank
 * lines included), and every problem is reported at once so the teacher can fix them in one pass.
 * Cells are cleaned as the server cleans them: 学号 loses surrounding spaces and zero-width characters,
 * 姓名 is normalized (full-width letters, zero-width characters, repeated spaces).
 */
export function parseRoster(text: string) {
  const rows = text.split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => stripInvisibleEdges(line));
  if (rows[0] && stripInvisibleEdges(rows[0].line).split("\t").map(stripInvisibleEdges).join("\t") === "学号\t姓名") rows.shift();
  if (!rows.length) throw new Error(`每次请粘贴 1–${ROSTER_MAX_ROWS} 名学生`);
  if (rows.length > ROSTER_MAX_ROWS) {
    throw new Error(`每次最多 ${ROSTER_MAX_ROWS} 名学生，当前粘贴了 ${rows.length} 行；请分批导入`);
  }
  const seen = new Map<string, number>();
  const errors: string[] = [];
  const accounts: { username: string; display_name: string }[] = [];
  for (const { line, number } of rows) {
    const cells = line.split("\t");
    const username = stripInvisibleEdges(cells[0] ?? "");
    const display_name = normalizeLabel(cells[1] ?? "");
    if (cells.length !== 2 || !display_name || display_name.length > 60) {
      errors.push(`第 ${number} 行：请保留学号、姓名两列（用制表符分隔，从 Excel 直接复制即可），姓名为 1–60 字`);
    } else if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username)) {
      errors.push(`第 ${number} 行：学号须为 2–40 位字母、数字、下划线、点或连字符`);
    } else if (seen.has(username)) {
      errors.push(`第 ${number} 行：学号 ${username} 与第 ${seen.get(username)} 行重复`);
    } else {
      seen.set(username, number);
      accounts.push({ username, display_name });
    }
  }
  if (errors.length) {
    const shown = errors.slice(0, 10);
    if (errors.length > 10) shown.push(`另有 ${errors.length - 10} 处问题`);
    throw new Error(shown.join("\n"));
  }
  return accounts;
}

type Account = ReturnType<typeof parseRoster>[number] & { password: string };

/** A request the server answered and refused (validation, conflict): nothing was created, the roster can be edited. */
function refusedByServer(cause: unknown) {
  return cause instanceof ApiError && cause.status < 500;
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
  // Where focus goes once the view switches (preview ⇄ edit); the old focused control is unmounted.
  const focusAfterSwitch = useRef<"status" | "text" | null>(null);
  useEffect(() => {
    const target = focusAfterSwitch.current === "status" ? statusRef.current : focusAfterSwitch.current === "text" ? textRef.current : null;
    focusAfterSwitch.current = null;
    target?.focus();
  }, [accounts]);
  const close = () => {
    if (!busy && (!attempted || done || window.confirm("若刚才提交时断网，请先用已下载的清单核对学生列表。确定关闭？"))) onClose();
  };
  const preview = async () => {
    setError("");
    if (!classId) return setError("请先选择班级；没有班级时请到“学期与班级”创建");
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
    } catch (cause) { setError(userFacingRequestError(cause, "校验名单失败")); }
    finally { setBusy(false); }
  };
  const backToEdit = () => {
    focusAfterSwitch.current = "text";
    setAccounts(null); setError(""); setRefused(false);
  };
  const download = () => {
    if (!accounts) return;
    const content = "学号（用户名）\t姓名\t初始密码\n" + accounts.map((row) => `${row.username}\t${row.display_name}\t${row.password}`).join("\n");
    const url = URL.createObjectURL(new Blob(["﻿", content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "学生账号清单.txt"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
  };
  const submit = async () => {
    if (!accounts || busy) return;
    setBusy(true); setError(""); setAttempted(true);
    try {
      await api.classroom.createStudentBatch({ class_id: Number(classId), students: accounts, preview: false });
      setDone(true); onCreated();
      // The 确认创建 button is gone; the status line says what happened next.
      window.requestAnimationFrame(() => statusRef.current?.focus());
    } catch (cause) {
      if (refusedByServer(cause)) {
        // The server answered: nothing was created, so the roster can be fixed and previewed again.
        setAttempted(false);
        setRefused(true);
        const message = userFacingRequestError(cause, "创建失败");
        const end = /[。！？.!?]$/.test(message) ? "" : "。";
        setError(`${message}${end}\n刚才下载的账号清单作废；返回修改后重新预览会标出冲突的学号，并生成新的初始密码，请重新下载。`);
      } else {
        const message = userFacingRequestError(cause, "创建失败");
        const end = /[。！？.!?]$/.test(message) ? "" : "。";
        setError(`${message}${end}若提交时断网，请用已下载的清单核对学生列表，勿直接重新生成密码。`);
      }
    }
    finally { setBusy(false); }
  };
  // With the class already chosen (opened from a class row), start where the roster is pasted.
  return <Modal title="批量添加学生" width={620} onClose={close} initialFocusRef={initialClassId ? textRef : undefined}>
    <div className="modal-form" style={{ maxHeight: "calc(100vh - 160px)", overflowY: "auto" }}>
      <LabeledControl label="所属班级">{(id) => <select id={id} disabled={busy || !!accounts} value={classId} onChange={(e) => setClassId(Number(e.target.value) || "")}>
        <option value="">请选择班级</option>
        {semesters.filter((s) => s.is_active).map((s) => <optgroup key={s.id} label={s.name}>
          {s.classes.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>)}
      </select>}</LabeledControl>
      {!accounts ? <>
        <p>从 Excel 复制“学号、姓名”两列粘贴到下方（两列之间是制表符），每次最多 {ROSTER_MAX_ROWS} 人。学号用作登录用户名，请保留前导零。</p>
        <LabeledControl label="学生名单">{(id) => <textarea ref={textRef} id={id} rows={8} disabled={busy} value={text} onChange={(e) => setText(e.target.value)} placeholder={"学号\t姓名\n2026001\t张三\n2026002\t李四"} />}</LabeledControl>
      </> : <>
        <p ref={statusRef} role="status" tabIndex={-1}>{done
          ? `已添加 ${accounts.length} 名学生。请按最后一次下载的账号清单逐人发放账号，并提醒学生登录后修改密码。`
          : refused ? `共 ${accounts.length} 人，均未创建；请返回修改。`
          : `共 ${accounts.length} 人${existing.length ? `，${existing.length} 个学号已被使用（作为账号或其他学生的学号），请返回修改名单` : "，可以创建"}。已有账号不会被修改或重新分班。`}</p>
        <ScrollableRegion label="学生名单预览" className="table-wrap" style={{ maxHeight: 240, flexShrink: 0 }}>
          <table className="data-table"><thead><tr><th>学号 / 用户名</th><th>姓名</th><th>状态</th></tr></thead>
            <tbody>{accounts.map((row) => <tr key={row.username}><td>{row.username}</td><td>{row.display_name}</td><td>{done ? "已创建" : refused ? "未创建" : existing.includes(row.username) ? "学号已被使用" : "待创建"}</td></tr>)}</tbody>
          </table>
        </ScrollableRegion>
        {!existing.length && !refused && <>
          {!done && <p>清单含初始密码，请先下载保存。逐人发放账号，不要将整份清单发到群里。</p>}
          <button disabled={busy} onClick={download}>{done ? "再次下载账号清单" : "下载账号清单"}</button>
          <p className="muted batch-download-hint">清单是用制表符分隔的文本文件，可用记事本直接打开；若用 Excel 打开，请在导入时把学号列设为“文本”，否则学号开头的 0 可能被去掉。</p>
          {downloaded && !done && <p>请确认文件已保存，再创建账号。</p>}</>}
      </>}
      {error && <div ref={errorRef} className="error-box" role="alert" tabIndex={-1} style={{ whiteSpace: "pre-line" }}>{error}</div>}
      <div className="modal-actions">
        <button disabled={busy} onClick={close}>{done ? "完成" : "取消"}</button>
        {accounts && !done && !attempted && <button disabled={busy} onClick={backToEdit}>返回修改</button>}
        {!accounts ? <button className="primary" disabled={busy} onClick={() => void preview()}>{busy ? "校验中…" : "预览名单"}</button>
          : !done && <button className="primary" disabled={busy || !!existing.length || !downloaded || refused} onClick={() => void submit()}>{busy ? "创建中…" : "确认创建"}</button>}
      </div>
    </div>
  </Modal>;
}

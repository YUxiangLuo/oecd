import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { Announcement, ClassInfo } from "../types";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

/** 课堂公告:发布(全体或指定班级)、列表、删除 */
export function AnnouncementsTab() {
  const [refresh, setRefresh] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", body: "", class_id: "" });
  const { data: cls } = useAsync<{ classes: ClassInfo[] }>(() => api.classroom.classes(), []);
  const { data, error } = useAsync<{ announcements: Announcement[] }>(
    () => api.classroom.announcements(),
    [refresh],
  );

  const publish = () => {
    if (!form.title) { setActionError("标题必填"); return; }
    api.classroom
      .createAnnouncement({ title: form.title, body: form.body, class_id: form.class_id ? Number(form.class_id) : null })
      .then(
        () => { setActionError(null); setForm({ title: "", body: "", class_id: "" }); setRefresh((n) => n + 1); },
        (e) => setActionError(String(e.message ?? e)),
      );
  };

  if (error) return <div className="error-box">{error}</div>;
  return (
    <div>
      <div className="section-head"><span className="section-head-icon">📢</span>发布公告<span className="section-head-line" /></div>
      <div className="announce-form">
        <div className="controls inline-form">
          <input placeholder="公告标题(如:第 13-16 步实验报告本周五截止)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ minWidth: 320 }} />
          <label>可见范围</label>
          <select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })}>
            <option value="">全部班级</option>
            {(cls?.classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <textarea placeholder="正文(可空)" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={3} />
        <div className="controls">
          <button className="primary" onClick={publish}>发布</button>
          <span className="muted">学生登录后在顶栏下方看到最新公告</span>
        </div>
        {actionError && <div className="error-box">{actionError}</div>}
      </div>

      <div className="section-head"><span className="section-head-icon">🗂️</span>已发布({data?.announcements.length ?? 0})<span className="section-head-line" /></div>
      {(data?.announcements ?? []).map((a) => (
        <div key={a.id} className="card announce-card">
          <div className="announce-head">
            <b>{a.title}</b>
            <span className="stage-chip">{a.class_name ?? "全部班级"}</span>
            <span className="muted">{fmtTime(a.created_at)} · {a.author}</span>
            <button
              className="announce-del"
              onClick={() => {
                if (window.confirm(`删除公告「${a.title}」?`))
                  api.classroom.deleteAnnouncement(a.id).then(() => setRefresh((n) => n + 1), (e) => setActionError(String(e.message ?? e)));
              }}
            >
              删除
            </button>
          </div>
          {a.body && <p>{a.body}</p>}
        </div>
      ))}
      {data && data.announcements.length === 0 && <p className="muted">暂无公告。</p>}
    </div>
  );
}

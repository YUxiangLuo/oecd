import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { Announcement, ClassInfo } from "../types";
import { ConfirmModal, EmptyState, StatusPill } from "./ui";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");
const initial = (name: string) => (name ? name[0].toUpperCase() : "?");

/** 课堂公告:撰写面板 + 已发布卡片列表(模态确认删除) */
export function AnnouncementsTab() {
  const [refresh, setRefresh] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", body: "", class_id: "" });
  const [pendingDelete, setPendingDelete] = useState<Announcement | null>(null);
  const { data: cls } = useAsync<{ classes: ClassInfo[] }>(() => api.classroom.classes(), []);
  const { data, error } = useAsync<{ announcements: Announcement[] }>(
    () => api.classroom.announcements(),
    [refresh],
  );

  const publish = () => {
    if (!form.title) {
      setActionError("标题必填");
      return;
    }
    api.classroom
      .createAnnouncement({ title: form.title, body: form.body, class_id: form.class_id ? Number(form.class_id) : null })
      .then(
        () => {
          setActionError(null);
          setForm({ title: "", body: "", class_id: "" });
          setRefresh((n) => n + 1);
        },
        (e) => setActionError(String(e.message ?? e)),
      );
  };

  if (error) return <div className="error-box">{error}</div>;
  const list = data?.announcements ?? [];

  return (
    <div className="announce-cols">
      <section className="panel compose-panel">
        <div className="panel-head">
          <span className="panel-ic">✏️</span>撰写公告
        </div>
        <div className="modal-form">
          <label>标题</label>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="如：第 12–15 步回归练习本周五截止"
          />
          <label>可见范围</label>
          <select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })}>
            <option value="">全部班级</option>
            {(cls?.classes ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label>正文(可空)</label>
          <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={5} />
          {actionError && <div className="error-box">{actionError}</div>}
          <button className="primary block" onClick={publish}>
            发布公告
          </button>
          <p className="muted">学生登录后在顶栏下方看到最新公告。</p>
        </div>
      </section>

      <section className="announce-list">
        <div className="panel-head plain">
          <span className="panel-ic">🗂️</span>已发布
          <span className="panel-tag">{list.length} 条</span>
        </div>
        {list.map((a) => (
          <div key={a.id} className="announce-card">
            <div className="announce-avatar">{initial(a.author)}</div>
            <div className="announce-main">
              <div className="announce-top">
                <b>{a.title}</b>
                <StatusPill tone="info">{a.class_name ?? "全部班级"}</StatusPill>
              </div>
              {a.body && <p>{a.body}</p>}
              <div className="announce-meta">
                {a.author} · {fmtTime(a.created_at)}
              </div>
            </div>
            <button className="icon-btn danger" onClick={() => setPendingDelete(a)} aria-label="删除">
              🗑
            </button>
          </div>
        ))}
        {list.length === 0 && <EmptyState icon="📢" title="暂无公告" hint="用左侧表单发布第一条公告" />}
      </section>

      {pendingDelete && (
        <ConfirmModal
          title="删除公告"
          message={`确定删除公告「${pendingDelete.title}」吗?`}
          confirmLabel="删除"
          danger
          onConfirm={() =>
            api.classroom.deleteAnnouncement(pendingDelete.id).then(
              () => setRefresh((n) => n + 1),
              (e) => setActionError(String(e.message ?? e)),
            )
          }
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

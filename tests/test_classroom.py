"""教学面板(班级/学生/进度/评阅/公告)测试。

使用独立测试库 gvclab_test(GVCSIM_PG_DSN_TEST 可覆盖),本地 PostgreSQL
不可用时整模块跳过,与仓库其它数据依赖测试的 skipif 约定一致。
每个用例结束后清空全部教学表,下个用例自动重新播种。
"""

import os
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest
from fastapi.testclient import TestClient

from gvcsim import artifacts, config
from gvcsim import session as session_model
from gvcsim.api import app
from gvcsim.classroom import db
from gvcsim.config import PROCESSED_DIR

# 会话绑定当前产物清单,因此这些用例需要 gvcsim compute 的产出。
needs_artifacts = pytest.mark.skipif(
    not (PROCESSED_DIR / "artifact_manifest.json").exists(),
    reason="需要 gvcsim compute 产出的 artifact_manifest.json",
)

TEST_DSN = os.environ.get("GVCSIM_PG_DSN_TEST", "postgresql://alice:111111@127.0.0.1:5432/gvclab_test")
DEAD_DSN = "postgresql://alice:111111@127.0.0.1:59999/gvclab"

try:
    _info = psycopg.conninfo.conninfo_to_dict(TEST_DSN)
    with psycopg.connect(**{**_info, "dbname": "postgres"}, autocommit=True, connect_timeout=3) as _c:
        if not _c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (_info["dbname"],)).fetchone():
            _c.execute(f'CREATE DATABASE "{_info["dbname"]}"')
except psycopg.OperationalError:
    pytest.skip("本地 PostgreSQL 不可用,跳过教学面板测试", allow_module_level=True)

client = TestClient(app)


@pytest.fixture(autouse=True)
def classroom_test_db(monkeypatch):
    monkeypatch.setattr(config, "PG_DSN", TEST_DSN)
    # 在**用例开始前**重建整个 schema:
    #   - 用例之间完全隔离,不依赖上一个用例是否正常结束;
    #   - 测试库停留在任何旧版本时也能自愈,不必要求开发者手工 reset;
    #   - 重建整个 schema 而不是删写死的表名单——名单会漏掉新表或废弃版本的
    #     遗留表,让它们跨用例存活(线上正是这样留下了一整套孤儿表)。
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE")
        c.execute("CREATE SCHEMA public")
    db._schema_ready = False
    yield
    db._schema_ready = False


def _login(username: str, password: str = "gvclab2026") -> dict:
    resp = client.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_seeded_accounts_login_via_db():
    headers = _login("student")
    me = client.get("/api/auth/me", headers=headers).json()
    assert me == {"username": "student", "name": "同学", "role": "student"}
    # 播种数据落在测试库
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT count(*) FROM accounts").fetchone()[0] == 2


def test_teacher_creates_student_who_can_login():
    t = _login("teacher")
    resp = client.post(
        "/api/classroom/students",
        headers=t,
        json={
            "username": "s001",
            "display_name": "王小明",
            "password": "abc12345",
            "student_no": "2026002",
            "class_id": 1,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["username"] == "s001"
    # 新账号立即可登录
    s = _login("s001", "abc12345")
    assert client.get("/api/auth/me", headers=s).json()["name"] == "王小明"
    # 重名 409;非法用户名 400
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "s001", "display_name": "x", "password": "abc12345"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "空 格", "display_name": "x", "password": "abc12345"},
        ).status_code
        == 400
    )


def test_disabled_student_rejected():
    t = _login("teacher")
    sid = client.get("/api/classroom/students", headers=t).json()["students"][0]["id"]
    resp = client.post(f"/api/classroom/students/{sid}", headers=t, json={"active": False})
    assert resp.status_code == 200 and resp.json()["active"] is False
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 401
    # 重新启用后恢复
    client.post(f"/api/classroom/students/{sid}", headers=t, json={"active": True})
    _login("student")


@needs_artifacts
def test_submit_review_roundtrip_and_resubmit_resets():
    s, t = _login("student"), _login("teacher")
    _put_complete_session(s)
    report = client.post("/api/classroom/report/generate", headers=s).json()
    body = {"title": "我的实验报告", "report_key": report["report_key"]}
    sub = client.post("/api/classroom/report/submit", headers=s, json=body).json()
    assert sub["state"] == "pending"

    listed = client.get("/api/classroom/submissions", headers=t).json()["submissions"]
    assert len(listed) == 1 and listed[0]["username"] == "student"
    detail = client.get(f"/api/classroom/submissions/{sub['id']}", headers=t).json()
    assert detail["markdown"] == report["markdown"]

    graded = client.post(
        f"/api/classroom/submissions/{sub['id']}/grade", headers=t, json={"score": 92, "feedback": "很好"}
    ).json()
    assert graded["state"] == "graded" and graded["score"] == 92

    mine = client.get("/api/classroom/report/mine", headers=s).json()
    assert mine["score"] == 92 and mine["feedback"] == "很好" and mine["graded_by"] == "teacher"

    # 重交:覆盖内容并重置评阅
    client.post("/api/classroom/report/submit", headers=s, json={**body, "title": "修订版"})
    mine = client.get("/api/classroom/report/mine", headers=s).json()
    assert mine["state"] == "pending" and mine["score"] is None and mine["title"] == "修订版"

    # 越界分数被 Pydantic 拒绝
    assert (
        client.post(
            f"/api/classroom/submissions/{sub['id']}/grade", headers=t, json={"score": 101, "feedback": ""}
        ).status_code
        == 422
    )


def _stamp_version(version: str) -> None:
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("UPDATE schema_meta SET version = %s WHERE singleton", (version,))


def test_schema_version_mismatch_fails_loudly_instead_of_stacking_tables():
    """版本不符必须明确失败,绝不能继续 CREATE TABLE IF NOT EXISTS。

    真实事故:旧代码在 v2 库上懒建表,于是新旧两套表并存,而 schema_meta
    仍写着 v2——数据库从此对自己的身份说谎,且没有任何一层会报错。
    """
    _login("student")  # 触发建表
    _stamp_version("gvcsim-teaching-db-v2")
    db._schema_ready = False

    with pytest.raises(db.SchemaVersionMismatch) as excinfo:
        db.initialize_schema()
    assert "v2" in str(excinfo.value)
    assert "--reset" in str(excinfo.value)  # 必须给出可执行的出路

    # 关键:失败后没有留下任何新表,版本戳也没有被偷偷改写。
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT version FROM schema_meta WHERE singleton").fetchone()[0] == "gvcsim-teaching-db-v2"


def test_legacy_schema_without_version_stamp_is_rejected():
    """没有版本戳的更早 schema 也必须要求 reset,不能被当成空库直接建表。"""
    _login("student")
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP TABLE schema_meta")
    db._schema_ready = False

    with pytest.raises(db.SchemaVersionMismatch):
        db.initialize_schema()


def test_concurrent_initialize_is_safe_and_idempotent():
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE")
        c.execute("CREATE SCHEMA public")
    db._schema_ready = False

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: db.initialize_schema(), range(2)))

    # 只有一个线程报告“创建 schema”,另一个看到已就绪;账号不会被播种两次。
    assert sorted(len(r) for r in results) == [0, 1]
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT count(*) FROM schema_meta").fetchone()[0] == 1
        assert c.execute("SELECT count(*) FROM accounts WHERE username = 'student'").fetchone()[0] == 1


# ---------------------------------------------------------------- 实验会话


def _session_body(steps: dict, manifest_id: str) -> dict:
    return {"version": session_model.SESSION_VERSION, "manifest_id": manifest_id, "steps": steps}


def _manifest_id() -> str:
    return artifacts.manifest_id()


@needs_artifacts
def test_session_round_trips_and_survives_relogin():
    """会话必须能跨刷新/重新登录恢复——这正是 HEAD 丢失学生实验的地方。"""
    s = _login("student")
    empty = client.get("/api/classroom/session", headers=s).json()
    assert empty["revision"] == 0 and empty["session"]["steps"] == {}

    body = _session_body({"4": session_model.make_record({"country": "CHN", "year": 2020})}, _manifest_id())
    saved = client.put("/api/classroom/session", headers=s, json={"base_revision": 0, "session": body})
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1

    # 重新登录 = 新令牌、新客户端状态;服务端仍应还原实验。
    again = client.get("/api/classroom/session", headers=_login("student")).json()
    assert again["revision"] == 1
    assert again["session"]["steps"]["4"]["data"] == {"country": "CHN", "year": 2020}
    assert again["stale"] is False


@needs_artifacts
def test_concurrent_session_writes_merge_per_step_instead_of_clobbering():
    """两个标签页各做一步,不能有一边被整份覆盖掉。"""
    s = _login("student")
    mid = _manifest_id()
    first = client.put(
        "/api/classroom/session",
        headers=s,
        json={"base_revision": 0, "session": _session_body({"4": session_model.make_record({"country": "CHN"})}, mid)},
    ).json()
    assert first["revision"] == 1

    # 第二个标签页仍拿着 revision=0,只改了第 12 步。
    second = client.put(
        "/api/classroom/session",
        headers=s,
        json={
            "base_revision": 0,
            "session": _session_body({"12": session_model.make_record({"shock": "tariff"})}, mid),
        },
    )
    assert second.status_code == 200
    merged = second.json()
    assert merged["merged_from"] == 1
    # 两步都在:第 4 步没有因为第二次写入而消失。
    assert merged["session"]["steps"]["4"]["data"] == {"country": "CHN"}
    assert merged["session"]["steps"]["12"]["data"] == {"shock": "tariff"}


@needs_artifacts
def test_session_from_other_artifacts_is_rejected():
    """产物变了就不能再往当前会话里写旧结果。"""
    s = _login("student")
    body = _session_body({"4": session_model.make_record({"country": "CHN"})}, "0000000000000000")
    resp = client.put("/api/classroom/session", headers=s, json={"base_revision": 0, "session": body})
    assert resp.status_code == 409
    assert "产物" in resp.json()["detail"]


@needs_artifacts
def test_stale_session_is_flagged_not_silently_served():
    """产物换代后,旧会话必须被标记为过期,而不是被当成当前结果。"""
    s = _login("student")
    client.put(
        "/api/classroom/session",
        headers=s,
        json={"base_revision": 0, "session": _session_body({"4": session_model.make_record({"a": 1})}, _manifest_id())},
    )
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("UPDATE experiment_sessions SET session = jsonb_set(session, '{manifest_id}', '\"deadbeef\"')")
    assert client.get("/api/classroom/session", headers=s).json()["stale"] is True


@needs_artifacts
def test_malformed_session_is_rejected():
    s = _login("student")
    mid = _manifest_id()
    bad_bodies = [
        _session_body({"99": session_model.make_record({})}, mid),  # 步骤越界
        _session_body({"4": {"data": {}}}, mid),  # 缺 updated_at
        {"version": "experiment-session-v0", "manifest_id": mid, "steps": {}},  # 旧版本不做兼容
    ]
    for body in bad_bodies:
        resp = client.put("/api/classroom/session", headers=s, json={"base_revision": 0, "session": body})
        assert resp.status_code == 422, body


# ------------------------------------------------------- 第 16 步:报告闭环


def _put_complete_session(headers: dict) -> None:
    from gvcsim import evidence

    mid = _manifest_id()
    payload = {
        "db": {"slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"}},
        "shock": {"viewed_shock_types": list(evidence.REQUIRED_SHOCK_TYPES)},
        "qc": {"disposition": "disclose", "judgment": "质检警告不影响本课结论,披露后继续"},
        "ind": {"compared": ["CHN", "USA"]},
        "viz": {"chart": "quadrant", "compared": ["CHN", "USA"]},
        "reg": {
            "run": {"depvar": "FVA_share", "settings": {"shockType": "export_control"}},
            "judgment": "只有一个处理聚类,推断被抑制,不能作因果解释",
        },
    }
    steps = {
        str(step): session_model.make_record(payload[lab]) for step, lab in evidence.STEP_LABS.items() if lab != "rep"
    }
    resp = client.put(
        "/api/classroom/session", headers=headers, json={"base_revision": 0, "session": _session_body(steps, mid)}
    )
    assert resp.status_code == 200, resp.text


@needs_artifacts
def test_report_generation_is_blocked_until_the_first_15_steps_have_evidence():
    s = _login("student")
    resp = client.post("/api/classroom/report/generate", headers=s)
    assert resp.status_code == 409
    blocked = resp.json()["detail"]["blocked"]
    assert [item["step"] for item in blocked] == list(range(1, 16))
    # 门槛状态也可单独查询,便于第 16 步界面直接告诉学生还差什么。
    assert client.get("/api/classroom/report/gate", headers=s).json()["blocked"]


@needs_artifacts
def test_submit_rejects_fabricated_markdown_because_it_no_longer_accepts_any():
    """HEAD 的原始事故:提交接口收下客户端任意 Markdown 并落库待批改。"""
    s = _login("student")
    fabricated = {
        "year": 2020,
        "title": "完全伪造的报告",
        "design": {"never": "ran any regression"},
        "markdown": "# 我没有做任何实验",
    }
    # 旧契约的字段被 Pydantic 直接拒绝:接口已经没有 markdown 入口。
    assert client.post("/api/classroom/report/submit", headers=s, json=fabricated).status_code == 422
    # 编造一个 report_key 也没用:服务端只认自己生成过的报告。
    resp = client.post("/api/classroom/report/submit", headers=s, json={"title": "x", "report_key": "deadbeef"})
    assert resp.status_code == 409
    assert client.get("/api/classroom/report/mine", headers=s).json()["state"] == "none"


@needs_artifacts
def test_generated_report_completes_step_16_and_can_be_reopened():
    s = _login("student")
    _put_complete_session(s)
    assert client.get("/api/classroom/session", headers=s).json()["completion"]["completed_count"] == 15

    generated = client.post("/api/classroom/report/generate", headers=s)
    assert generated.status_code == 200, generated.text
    report_key = generated.json()["report_key"]

    # 第 16 步的证据由服务端写入会话 → 完成度变成 16/16。
    completion = client.get("/api/classroom/session", headers=s).json()["completion"]
    assert completion["completed_count"] == 16

    # 刷新/重新登录后仍能重新打开报告全文。
    reopened = client.get("/api/classroom/report/generated", headers=_login("student")).json()
    assert reopened["report_key"] == report_key
    assert reopened["markdown"] == generated.json()["markdown"]
    assert reopened["provenance"]["manifest_id"] == _manifest_id()


@needs_artifacts
def test_submitted_report_carries_server_generated_text_and_provenance():
    s, t = _login("student"), _login("teacher")
    _put_complete_session(s)
    report = client.post("/api/classroom/report/generate", headers=s).json()

    submitted = client.post(
        "/api/classroom/report/submit", headers=s, json={"title": "我的实验报告", "report_key": report["report_key"]}
    )
    assert submitted.status_code == 200, submitted.text

    detail = client.get(f"/api/classroom/submissions/{submitted.json()['id']}", headers=t).json()
    # 教师看到的正文与服务端生成的一字不差,且带着溯源。
    assert detail["markdown"] == report["markdown"]
    assert detail["design"]["report_key"] == report["report_key"]
    assert detail["design"]["manifest_id"] == _manifest_id()


def test_step_reach_counts_reaching_not_completing():
    """`step_reach` 是到达统计,不是完成统计。

    深链(?step=12)或一次跳转即可把 max_step 推到 12,前 11 步一次都没打开过。
    这条用例把该语义钉死:在有真实学习证据之前,任何一层都不得把它当作完成度——
    字段名、SQL、前端文案都必须说“到达”。
    """
    s, t = _login("student"), _login("teacher")
    # 一次跳到第 12 步,没有做任何实验。
    assert client.post("/api/classroom/progress", headers=s, json={"step": 12}).status_code == 200
    reached = {r["step"]: r["reached"] for r in client.get("/api/classroom/overview", headers=t).json()["step_reach"]}
    # 1–12 全部计入“到达”,尽管学生只打开过第 12 步。
    assert all(reached[n] == 1 for n in range(1, 13))
    assert all(reached[n] == 0 for n in range(13, 17))


def test_progress_keeps_max_step():
    s, t = _login("student"), _login("teacher")
    assert client.get("/api/classroom/progress", headers=s).json() == {
        "current_step": None,
        "max_step": None,
        "updated_at": None,
    }
    for step in (5, 9, 3):
        assert client.post("/api/classroom/progress", headers=s, json={"step": step}).status_code == 200
    mine = client.get("/api/classroom/progress", headers=s)
    assert mine.status_code == 200
    assert mine.json()["current_step"] == 3
    assert mine.json()["max_step"] == 9
    assert mine.json()["updated_at"] is not None
    row = client.get("/api/classroom/students", headers=t).json()["students"][0]
    assert row["current_step"] == 3 and row["max_step"] == 9
    overview = client.get("/api/classroom/overview", headers=t).json()
    reached = {r["step"]: r["reached"] for r in overview["step_reach"]}
    assert reached[9] == 1 and reached[10] == 0
    # 概览新增聚合字段:近 7 天活跃(刚上报过进度)、14 天趋势、班级对比
    assert overview["active_7d"] == 1
    assert len(overview["submission_trend"]) == 14
    assert all({"date", "submitted", "graded"} <= r.keys() for r in overview["submission_trend"])
    assert any(c["name"] == "GVC 实验演示班" for c in overview["class_breakdown"])


@needs_artifacts
def test_overview_trend_and_class_breakdown():
    s, t = _login("student"), _login("teacher")
    _put_complete_session(s)
    report = client.post("/api/classroom/report/generate", headers=s).json()
    client.post("/api/classroom/report/submit", headers=s, json={"title": "报告", "report_key": report["report_key"]})
    ov = client.get("/api/classroom/overview", headers=t).json()
    # 今天提交 1 份、未评阅:趋势最后一天 submitted=1/graded=0,班级对比累计一致
    assert ov["submission_trend"][-1]["submitted"] == 1
    assert ov["submission_trend"][-1]["graded"] == 0
    demo = next(c for c in ov["class_breakdown"] if c["name"] == "GVC 实验演示班")
    assert demo["student_count"] == 1 and demo["submitted"] == 1 and demo["graded"] == 0
    assert demo["avg_score"] is None


def test_announcements_scoped_by_class():
    s, t = _login("student"), _login("teacher")
    # 种子里已有一条全局公告;再发一条仅其它班级可见的
    other = client.post("/api/classroom/classes", headers=t, json={"name": "另一个班", "code": "GVC-B"}).json()
    client.post("/api/classroom/announcements", headers=t, json={"title": "只给B班", "class_id": other["id"]})
    client.post("/api/classroom/announcements", headers=t, json={"title": "全体注意"})

    titles = [a["title"] for a in client.get("/api/classroom/announcements", headers=s).json()["announcements"]]
    assert "全体注意" in titles and "只给B班" not in titles
    teacher_titles = [a["title"] for a in client.get("/api/classroom/announcements", headers=t).json()["announcements"]]
    assert "只给B班" in teacher_titles

    # 删除
    aid = client.get("/api/classroom/announcements", headers=t).json()["announcements"][0]["id"]
    assert client.delete(f"/api/classroom/announcements/{aid}", headers=t).status_code == 200
    # 班级代码重复 409
    assert client.post("/api/classroom/classes", headers=t, json={"name": "x", "code": "GVC-B"}).status_code == 409


def test_student_forbidden_from_teacher_endpoints():
    s = _login("student")
    for path in ("/api/classroom/overview", "/api/classroom/students", "/api/classroom/submissions"):
        assert client.get(path, headers=s).status_code == 403
    assert client.post("/api/classroom/announcements", headers=s, json={"title": "x"}).status_code == 403


def test_teacher_cannot_write_student_progress_or_report():
    # 教师令牌不得上报进度/提交报告,否则会被计入待评阅提交,破坏教师/学生分离
    t = _login("teacher")
    assert client.get("/api/classroom/progress", headers=t).status_code == 403
    assert client.post("/api/classroom/progress", headers=t, json={"step": 3}).status_code == 403
    body = {"year": 2020, "title": "x", "design": {}, "markdown": "x"}
    assert client.post("/api/classroom/report/submit", headers=t, json=body).status_code == 403
    # 教师账号不会因此出现在提交列表里
    assert client.get("/api/classroom/submissions", headers=t).json()["submissions"] == []


def test_db_down_degrades_gracefully(monkeypatch):
    # 先在可用库拿到令牌,再把 DSN 指向死端口
    s = _login("student")
    monkeypatch.setattr(config, "PG_DSN", DEAD_DSN)
    db._schema_ready = False
    # 核心接口不受影响;教学接口 503;演示账号回退登录可用
    assert client.get("/api/meta", headers=s).status_code == 200
    assert client.get("/api/classroom/announcements", headers=s).status_code == 503
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 200
    bad = client.post("/api/auth/login", json={"username": "teacher", "password": "wrong"})
    assert bad.status_code == 503
    assert "请使用演示账号" in bad.json()["detail"]


@needs_artifacts
def test_first_concurrent_session_writes_do_not_clobber_each_other():
    """首写竞态:两个标签页都还没有会话行时并发写入,不能互相整份覆盖。

    SELECT ... FOR UPDATE 锁不住不存在的行,因此两个事务会双双读到 current=None、
    跳过 merge、都算出 revision=1,后到者用 ON CONFLICT DO UPDATE 覆盖先到者。
    save_session 改用按账号的事务级 advisory 锁串行化后,两步实验都必须留存。
    """
    s = _login("student")
    mid = _manifest_id()

    def put(step: str, data: dict):
        return client.put(
            "/api/classroom/session",
            headers=s,
            json={"base_revision": 0, "session": _session_body({step: session_model.make_record(data)}, mid)},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [
            f.result()
            for f in [pool.submit(put, "4", {"compared": ["CHN", "USA"]}), pool.submit(put, "12", {"judgment": "x"})]
        ]
    assert all(r.status_code == 200 for r in results), [r.text for r in results]

    steps = client.get("/api/classroom/session", headers=s).json()["session"]["steps"]
    # 两边的实验都必须还在:任何一步消失都说明发生了整份覆盖。
    assert "4" in steps and "12" in steps, f"并发首写丢了数据:{sorted(steps)}"

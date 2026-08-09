"""教学面板(班级/学生/进度/评阅/公告)测试。

使用独立测试库 gvclab_test(GVCSIM_PG_DSN_TEST 可覆盖),本地 PostgreSQL
不可用时整模块跳过,与仓库其它数据依赖测试的 skipif 约定一致。
每个用例结束后清空全部教学表,下个用例自动重新播种。
"""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import psycopg
import pytest
from fastapi.testclient import TestClient

from gvcsim import artifacts, config, teaching_report
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


def _save_generated_report(
    username: str,
    report_key: str,
    manifest_id: str,
    markdown: str,
    provenance: dict,
) -> dict:
    """通过现行原子写入路径准备报告，不为测试保留已废弃的独立写入函数。"""
    current = db.get_session(username, manifest_id)
    revision = current["revision"] if current else 0
    session = current["session"] if current else session_model.empty_session(manifest_id)
    saved = db.save_generated_report_and_session(
        username,
        report_key,
        revision,
        manifest_id,
        markdown,
        provenance,
        session,
    )
    assert saved
    return saved["report"]


def test_seeded_accounts_login_via_db():
    headers = _login("student")
    me = client.get("/api/auth/me", headers=headers).json()
    assert me == {"username": "student", "name": "同学", "role": "student", "account_id": 2}
    # 播种数据落在测试库
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT count(*) FROM accounts").fetchone()[0] == 2


@needs_artifacts
def test_quiz_endpoint_persists_only_a_fully_correct_current_answer_set():
    from gvcsim import quizzes

    student = _login("student")
    correct = quizzes.correct_quiz(12)
    wrong = dict(correct["answers"])
    question = quizzes.STEP_QUIZZES[12][0]
    wrong[question["id"]] = next(option["id"] for option in question["options"] if option["id"] != question["correct"])

    failed = client.post(
        "/api/classroom/quiz/submit",
        headers=student,
        json={"step": 12, "version": correct["version"], "answers": wrong},
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["passed"] is False
    assert "quiz_id" not in failed.json() and "quiz" not in failed.json()
    with psycopg.connect(TEST_DSN) as connection:
        assert connection.execute("SELECT count(*) FROM learning_evidence_events WHERE kind='quiz'").fetchone()[0] == 0

    passed = client.post("/api/classroom/quiz/submit", headers=student, json={"step": 12, **correct})
    assert passed.status_code == 200, passed.text
    assert passed.json()["passed"] is True and passed.json()["quiz_id"]
    assert passed.json()["quiz"] == correct
    with psycopg.connect(TEST_DSN) as connection:
        assert connection.execute("SELECT count(*) FROM learning_evidence_events WHERE kind='quiz'").fetchone()[0] == 1

    stale = client.post(
        "/api/classroom/quiz/submit",
        headers=student,
        json={"step": 12, "version": "old-version", "answers": correct["answers"]},
    )
    assert stale.status_code == 422 and "刷新" in stale.json()["detail"]


@needs_artifacts
def test_steps_api_exposes_questions_but_not_answer_keys():
    student = _login("student")
    response = client.get("/api/steps", headers=student)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "evidence_rules" not in payload
    steps = payload["steps"]
    assert all(step.get("quiz", {}).get("questions") for step in steps[:15])
    assert "quiz" not in steps[15]
    for step in steps[:15]:
        for question in step["quiz"]["questions"]:
            assert "correct" not in question and "explanation" not in question


@needs_artifacts
def test_operation_receipt_endpoint_is_removed():
    """实验操作只自动保存为会话快照，不再有独立提交端点。"""
    student = _login("student")
    response = client.post(
        "/api/classroom/evidence/issue",
        headers=student,
        json={"step": 11, "kind": "shock", "payload": {"viewed_shock_types": ["tariff"]}},
    )
    assert response.status_code == 404
    with psycopg.connect(TEST_DSN) as connection:
        assert connection.execute("SELECT count(*) FROM learning_evidence_events").fetchone()[0] == 0


def test_teacher_creates_student_who_can_login():
    t = _login("teacher")
    resp = client.post(
        "/api/classroom/students",
        headers=t,
        json={
            "username": "s001",
            "display_name": "王小明",
            "password": "abc12345-safe",
            "student_no": "2026002",
            "class_id": 1,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["username"] == "s001"
    # 新账号立即可登录
    s = _login("s001", "abc12345-safe")
    assert client.get("/api/auth/me", headers=s).json()["name"] == "王小明"
    # 重名 409;非法用户名 400
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "s001", "display_name": "x", "password": "abc12345-safe"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "空 格", "display_name": "x", "password": "abc12345-safe"},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "shortpw", "display_name": "x", "password": "too-short", "class_id": 1},
        ).status_code
        == 422
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


def test_read_only_schema_verification_never_initializes_an_empty_database():
    db._schema_ready = False
    with pytest.raises(db.SchemaVersionMismatch, match="classroom-init"):
        db.verify_schema()

    with psycopg.connect(TEST_DSN) as connection:
        assert connection.execute("SELECT to_regclass('public.schema_meta')").fetchone()[0] is None
    assert db._schema_ready is False


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
    assert "备份" in str(excinfo.value) and "禁止直接 reset" in str(excinfo.value)

    # 关键:失败后没有留下任何新表,版本戳也没有被偷偷改写。
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT version FROM schema_meta WHERE singleton").fetchone()[0] == "gvcsim-teaching-db-v2"


def test_legacy_schema_without_version_stamp_is_rejected():
    """没有版本戳的更早 schema 不能被当成空库直接建表。"""
    _login("student")
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP TABLE schema_meta")
    db._schema_ready = False

    with pytest.raises(db.SchemaVersionMismatch):
        db.initialize_schema()


def test_v3_schema_is_migrated_in_place_and_legacy_session_is_unverified():
    """生产升级必须保留旧数据，旧 JSON 只能只读且不能静默满足新门槛。"""
    v3 = """
    CREATE TABLE schema_meta(singleton boolean PRIMARY KEY,version text NOT NULL,created_at timestamptz DEFAULT now());
    CREATE TABLE classes(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL,code text UNIQUE NOT NULL,
      semester text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',archived boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now());
    CREATE TABLE accounts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,username text UNIQUE NOT NULL,display_name text NOT NULL,
      role text NOT NULL,class_id bigint REFERENCES classes(id),student_no text NOT NULL DEFAULT '',pw_salt text NOT NULL,pw_hash text NOT NULL,
      active boolean NOT NULL DEFAULT true,last_login_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE step_progress(account_id bigint PRIMARY KEY REFERENCES accounts(id),current_step int NOT NULL,max_step int NOT NULL,updated_at timestamptz DEFAULT now());
    CREATE TABLE experiment_sessions(account_id bigint PRIMARY KEY REFERENCES accounts(id),revision bigint NOT NULL,manifest_id text NOT NULL,
      session jsonb NOT NULL,updated_at timestamptz DEFAULT now());
    CREATE TABLE reports(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,account_id bigint NOT NULL REFERENCES accounts(id),report_key text NOT NULL,
      session_revision bigint NOT NULL,manifest_id text NOT NULL,markdown text NOT NULL,provenance jsonb NOT NULL,created_at timestamptz DEFAULT now(),
      UNIQUE(account_id,report_key));
    CREATE TABLE submissions(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,account_id bigint NOT NULL UNIQUE REFERENCES accounts(id),title text NOT NULL,
      year int NOT NULL,design jsonb NOT NULL,markdown text NOT NULL,state text NOT NULL DEFAULT 'pending',score int,feedback text NOT NULL DEFAULT '',
      graded_by text,graded_at timestamptz,submitted_at timestamptz DEFAULT now());
    CREATE TABLE announcements(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,class_id bigint REFERENCES classes(id),title text NOT NULL,
      body text NOT NULL DEFAULT '',author text NOT NULL,created_at timestamptz DEFAULT now());
    """
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE")
        c.execute("CREATE SCHEMA public")
        c.execute(v3)
        c.execute("INSERT INTO schema_meta VALUES(true,'gvcsim-teaching-db-v3',now())")
        class_id = c.execute("INSERT INTO classes(name,code) VALUES('旧班','OLD') RETURNING id").fetchone()[0]
        teacher_id = c.execute(
            "INSERT INTO accounts(username,display_name,role,pw_salt,pw_hash) VALUES('old_teacher','旧师','teacher','00','x') RETURNING id"
        ).fetchone()[0]
        student_id = c.execute(
            "INSERT INTO accounts(username,display_name,role,class_id,pw_salt,pw_hash) VALUES('old_student','旧生','student',%s,'00','x') RETURNING id",
            (class_id,),
        ).fetchone()[0]
        c.execute(
            "INSERT INTO experiment_sessions(account_id,revision,manifest_id,session) VALUES(%s,2,'old-manifest',%s)",
            (student_id, '{"version":"experiment-session-v3","manifest_id":"old-manifest","steps":{}}'),
        )
    db._schema_ready = False
    applied = db.initialize_schema()
    assert any("v3" in item and "v4" in item for item in applied)
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT version FROM schema_meta").fetchone()[0] == db.TEACHING_DB_VERSION
        assert c.execute("SELECT legacy_unverified FROM attempt_sessions").fetchone()[0] is True
        assert c.execute("SELECT count(*) FROM accounts").fetchone()[0] == 2
        assert (
            c.execute(
                "SELECT count(*) FROM teacher_course_access WHERE teacher_account_id=%s", (teacher_id,)
            ).fetchone()[0]
            == 1
        )


def test_v4_schema_is_migrated_in_place_with_assignment_selection():
    _login("student")
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP TABLE student_assignment_selections")
        c.execute("UPDATE schema_meta SET version='gvcsim-teaching-db-v4' WHERE singleton")
    db._schema_ready = False

    applied = db.initialize_schema()

    assert any("v4" in item and "v5" in item for item in applied)
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT version FROM schema_meta").fetchone()[0] == db.TEACHING_DB_VERSION
        assert c.execute("SELECT to_regclass('public.student_assignment_selections')").fetchone()[0]


def test_v5_schema_is_migrated_in_place_with_shared_login_limiter():
    _login("student")
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP TABLE auth_login_attempts")
        c.execute("UPDATE schema_meta SET version='gvcsim-teaching-db-v5' WHERE singleton")
    db._schema_ready = False

    applied = db.initialize_schema()

    assert any("v5" in item and "v6" in item for item in applied)
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT version FROM schema_meta").fetchone()[0] == db.TEACHING_DB_VERSION
        assert c.execute("SELECT to_regclass('public.auth_login_attempts')").fetchone()[0]


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


def test_connection_pool_reuses_connections_and_applies_bounded_backpressure(monkeypatch):
    _login("student")
    monkeypatch.setattr(config, "DB_POOL_MIN_SIZE", 1)
    monkeypatch.setattr(config, "DB_POOL_MAX_SIZE", 1)
    monkeypatch.setattr(config, "DB_POOL_TIMEOUT_SECONDS", 0.08)
    monkeypatch.setattr(config, "DB_POOL_MAX_WAITING", 1)
    db.close_pool()

    with db.conn() as connection:
        first_pid = connection.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
    with db.conn() as connection:
        second_pid = connection.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]
    assert second_pid == first_pid
    assert db.pool_stats()["size"] == 1
    assert db.readiness()["pool"]["available"] == 1

    def wait_for_connection() -> str:
        with pytest.raises(db.Unavailable, match="繁忙"):
            with db.conn():
                pass
        return "bounded"

    with db.conn():
        with ThreadPoolExecutor(max_workers=1) as executor:
            assert executor.submit(wait_for_connection).result(timeout=2) == "bounded"


@needs_artifacts
def test_teacher_progress_reuses_held_pool_connection_for_trusted_checks(monkeypatch):
    """单连接池也必须验证事件与报告，不能因嵌套 checkout 静默清空完成度。"""
    from gvcsim import quizzes

    student = _login("student")
    manifest_id = _manifest_id()
    answer = quizzes.correct_quiz(1)
    graded = client.post(
        "/api/classroom/quiz/submit",
        headers=student,
        json={"step": 1, **answer},
    )
    assert graded.status_code == 200, graded.text
    receipt = graded.json()

    report_key = "single-connection-report"
    session = session_model.empty_session(manifest_id)
    session["steps"] = {
        "1": session_model.make_record({"quiz": receipt["quiz"], "quiz_id": receipt["quiz_id"]}),
        "16": session_model.make_record({"report_key": report_key}),
    }
    saved = db.save_generated_report_and_session(
        "student",
        report_key,
        0,
        manifest_id,
        "# report",
        {},
        session,
    )
    assert saved is not None

    monkeypatch.setattr(config, "DB_POOL_MIN_SIZE", 1)
    monkeypatch.setattr(config, "DB_POOL_MAX_SIZE", 1)
    monkeypatch.setattr(config, "DB_POOL_TIMEOUT_SECONDS", 0.08)
    monkeypatch.setattr(config, "DB_POOL_MAX_WAITING", 1)
    db.close_pool()

    row = db.list_students(teacher_username="teacher")[0]
    assert row["verified_completed_steps"] == [1, 16]
    assert row["verified_completed_count"] == 2


def test_connection_checkout_failure_is_not_reported_as_a_query_failure(monkeypatch):
    class BusyPool:
        def getconn(self, *, timeout):
            raise db.PoolTimeout("sensitive pool detail")

    monkeypatch.setattr(db, "_schema_ready", True)
    monkeypatch.setattr(db, "_startup_sealed", False)
    monkeypatch.setattr(db, "_get_pool", lambda: BusyPool())

    with pytest.raises(db.Unavailable, match="连接池繁忙") as exc_info:
        with db.conn():
            pass
    assert not isinstance(exc_info.value, db.OperationFailed)
    assert "sensitive" not in str(exc_info.value)


def test_query_operational_error_keeps_a_distinct_reason_and_sqlstate(monkeypatch, caplog):
    class BorrowedConnection:
        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _traceback):
            return False

    class ReadyPool:
        def __init__(self):
            self.connection = BorrowedConnection()
            self.returned = False

        def getconn(self, *, timeout):
            return self.connection

        def putconn(self, connection):
            assert connection is self.connection
            self.returned = True

    pool = ReadyPool()
    monkeypatch.setattr(db, "_schema_ready", True)
    monkeypatch.setattr(db, "_startup_sealed", False)
    monkeypatch.setattr(db, "_get_pool", lambda: pool)

    with pytest.raises(db.OperationFailed) as exc_info:
        with db.conn():
            raise psycopg.errors.QueryCanceled("sensitive SQL and bind values")

    assert exc_info.value.reason == "query_canceled"
    assert exc_info.value.sqlstate == "57014"
    assert str(exc_info.value) == "教学数据库操作失败，请稍后重试"
    assert isinstance(exc_info.value.__cause__, psycopg.errors.QueryCanceled)
    assert pool.returned is True
    assert "sensitive SQL" not in caplog.text
    assert "sqlstate=57014" in caplog.text


def test_worker_startup_verifies_schema_without_running_migrations(monkeypatch):
    calls: list[str] = []

    class ReadyPool:
        def wait(self, *, timeout):
            assert timeout > 0
            calls.append("pool:wait")

    def verified():
        db._schema_ready = True
        calls.append("schema:verify")
        return {"status": "ok", "schema_version": db.TEACHING_DB_VERSION}

    monkeypatch.setattr(db, "_schema_ready", False)
    monkeypatch.setattr(db, "_startup_sealed", False)
    monkeypatch.setattr(db, "verify_schema", verified)
    monkeypatch.setattr(
        db,
        "initialize_schema",
        lambda: (_ for _ in ()).throw(AssertionError("worker startup must not migrate schema")),
    )
    monkeypatch.setattr(db, "_get_pool", lambda: ReadyPool())

    db.startup()

    assert calls == ["schema:verify", "pool:wait"]
    assert db._startup_sealed is True


def test_started_worker_refuses_request_time_lazy_schema_initialization(monkeypatch):
    monkeypatch.setattr(db, "_schema_ready", False)
    monkeypatch.setattr(db, "_startup_sealed", True)
    monkeypatch.setattr(
        db,
        "initialize_schema",
        lambda: (_ for _ in ()).throw(AssertionError("request path must not migrate schema")),
    )

    with pytest.raises(db.Unavailable, match="拒绝在请求路径执行惰性迁移"):
        with db.conn():
            pass


def test_started_worker_rejects_direct_schema_reinitialization(monkeypatch):
    monkeypatch.setattr(db, "_startup_sealed", True)
    with pytest.raises(RuntimeError, match="请求生命周期"):
        db.initialize_schema()


def test_provisioned_teachers_receive_isolated_default_courses(monkeypatch):
    """生产空库显式建多个教师时，默认课程不能成为隐式共享授权通道。"""
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.setattr(config, "BOOTSTRAP_PASSWORD", "")
    assert any("创建 schema" in item for item in db.initialize_schema())

    db.provision_teacher("owner_a", "甲教师", "owner-a-private-password")
    db.provision_teacher("owner_b", "乙教师", "owner-b-private-password")
    runs_a = db.list_course_runs("owner_a")
    runs_b = db.list_course_runs("owner_b")
    assert len(runs_a) == 1 and len(runs_b) == 1
    assert runs_a[0]["id"] != runs_b[0]["id"]
    assert runs_a[0]["code"] != runs_b[0]["code"]

    class_a = db.create_class("甲班", "OWNER-A-CLASS", teacher_username="owner_a")
    class_b = db.create_class("乙班", "OWNER-B-CLASS", teacher_username="owner_b")
    assert {row["id"] for row in db.list_classes("owner_a")} == {class_a["id"]}
    assert {row["id"] for row in db.list_classes("owner_b")} == {class_b["id"]}


def test_course_assignment_enrollment_attempt_scope_is_operational():
    _login("student")  # 初始化并播种
    run = db.create_course_run("teacher", "第二门课", "RUN-2", "2026 秋", "release-2")
    cls = db.create_class("第二班", "CLASS-2", teacher_username="teacher")
    student = db.create_student(
        "scope_s2", "作用域学生", "safe-password", class_id=cls["id"], teacher_username="teacher"
    )
    enrollment = db.enroll_student("teacher", run["id"], student["id"], cls["id"])
    assignment = db.create_assignment("teacher", run["id"], "lab-1", "实验一", "manifest-release-2")

    context = db.assignment_context("scope_s2", "manifest-release-2")
    assert context and context["course_run_id"] == run["id"]
    assert context["assignment_id"] == assignment["id"]
    assert context["enrollment_id"] == enrollment["id"]
    assert context["attempt_no"] == 1

    second = db.start_new_attempt("scope_s2", "manifest-release-2")
    assert second["attempt_no"] == 2 and second["attempt_id"] != context["attempt_id"]
    assert {row["code"] for row in db.list_course_runs("teacher")} >= {"GVC-LEGACY", "RUN-2"}


@needs_artifacts
def test_student_explicitly_switches_assignments_without_new_course_overriding_completed_context():
    student_headers = _login("student")
    manifest = artifacts.manifest_id()
    original = db.assignment_context("student", manifest)
    assert original
    db.upsert_progress("student", 16)

    with psycopg.connect(TEST_DSN) as c:
        student_id = c.execute("SELECT id FROM accounts WHERE username='student'").fetchone()[0]
    run = db.create_course_run("teacher", "第二门课", "SELECT-RUN", "2026 秋")
    db.enroll_student("teacher", run["id"], student_id, 1)
    newer = db.create_assignment("teacher", run["id"], "new-lab", "新作业", manifest)

    # 新课程发布后刷新仍保留学生已在使用的作业，不隐式跳到 0/16。
    assert db.assignment_context("student", manifest)["assignment_id"] == original["assignment_id"]
    listed = client.get("/api/classroom/assignment-contexts", headers=student_headers)
    assert listed.status_code == 200, listed.text
    options = listed.json()["assignments"]
    assert {row["assignment_id"] for row in options} == {original["assignment_id"], newer["id"]}
    assert next(row for row in options if row["selected"])["assignment_id"] == original["assignment_id"]

    switched = client.post(
        "/api/classroom/assignment-context/select",
        headers=student_headers,
        json={"assignment_id": newer["id"]},
    )
    assert switched.status_code == 200, switched.text
    assert switched.json()["assignment_id"] == newer["id"]
    assert db.assignment_context("student", manifest)["assignment_id"] == newer["id"]

    restored = client.post(
        "/api/classroom/assignment-context/select",
        headers=student_headers,
        json={"assignment_id": original["assignment_id"]},
    )
    assert restored.status_code == 200, restored.text
    assert db.assignment_context("student", manifest)["attempt_id"] == original["attempt_id"]

    teacher_headers = _login("teacher")
    assert client.get("/api/classroom/assignment-contexts", headers=teacher_headers).status_code == 403
    assert (
        client.post(
            "/api/classroom/assignment-context/select",
            headers=student_headers,
            json={"assignment_id": 999_999},
        ).status_code
        == 404
    )


def test_first_attempt_creation_is_safe_under_concurrent_student_bootstrap():
    """首屏 meta/progress 并发时只能得到同一个 attempt，不能有唯一键 500。"""
    _login("student")
    run = db.create_course_run("teacher", "并发首屏课程", "RACE-RUN")
    cls = db.create_class("并发首屏班", "RACE-CLASS", teacher_username="teacher")
    student = db.create_student(
        "race_student",
        "并发学生",
        "race-student-password",
        class_id=cls["id"],
        teacher_username="teacher",
    )
    enrollment = db.enroll_student("teacher", run["id"], student["id"], cls["id"])
    assignment = db.create_assignment("teacher", run["id"], "race-lab", "并发作业", "race-manifest")

    with ThreadPoolExecutor(max_workers=4) as pool:
        contexts = list(pool.map(lambda _: db.assignment_context("race_student", "race-manifest"), range(4)))

    attempt_ids = {context["attempt_id"] for context in contexts if context is not None}
    assert len(attempt_ids) == 1
    with psycopg.connect(TEST_DSN) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM experiment_attempts WHERE assignment_id=%s AND enrollment_id=%s",
                (assignment["id"], enrollment["id"]),
            ).fetchone()[0]
            == 1
        )


def test_enrollment_list_is_persistent_and_teacher_scoped():
    teacher = _login("teacher")
    context = db.assignment_context("student", "manifest-enrollment-list")
    assert context
    url = f"/api/classroom/enrollments?course_run_id={context['course_run_id']}"
    first = client.get(url, headers=teacher)
    second = client.get(url, headers=teacher)
    assert first.status_code == 200 and second.json() == first.json()
    enrolled = first.json()["enrollments"]
    assert any(row["account_id"] == 2 and row["active"] is True for row in enrolled)

    db.provision_teacher("teacher2", "教师二", "teacher2-private-password")
    other = _login("teacher2", "teacher2-private-password")
    assert client.get(url, headers=other).status_code == 403


def test_assignment_time_window_is_enforced_by_api_and_db():
    teacher = _login("teacher")
    run_id = db.assignment_context("student", "manifest-window")["course_run_id"]
    response = client.post(
        "/api/classroom/assignments",
        headers=teacher,
        json={
            "course_run_id": run_id,
            "slug": "bad-window",
            "title": "不可达作业",
            "manifest_id": "manifest-window",
            "opens_at": "2026-07-20T00:00:00Z",
            "due_at": "2026-07-20T00:00:00Z",
        },
    )
    assert response.status_code == 422
    with pytest.raises(ValueError, match="due_at"):
        db.create_assignment(
            "teacher",
            run_id,
            "bad-window-db",
            "不可达作业",
            "manifest-window",
            opens_at=datetime(2026, 7, 20, tzinfo=timezone.utc),
            due_at=datetime(2026, 7, 20, tzinfo=timezone.utc),
        )


def test_historical_manifest_assignment_cannot_be_reactivated(monkeypatch):
    teacher = _login("teacher")
    run_id = db.assignment_context("student", "manifest-current")["course_run_id"]
    historical = db.create_assignment("teacher", run_id, "historical", "历史作业", "manifest-historical")
    assert db.set_assignment_active("teacher", historical["id"], False)
    monkeypatch.setattr(artifacts, "manifest_id", lambda: "manifest-current")
    response = client.post(
        f"/api/classroom/assignments/{historical['id']}/state",
        headers=teacher,
        json={"active": True},
    )
    assert response.status_code == 409
    assert "历史" in response.json()["detail"]


def test_teacher_queries_are_scoped_to_granted_courses_and_classes():
    _login("student")
    db.provision_teacher("teacher2", "教师二", "a-long-private-password")
    other_class = db.create_class("教师二班级", "T2-CLASS", teacher_username="teacher2")
    other_student = db.create_student(
        "teacher2_student",
        "二班学生",
        "safe-password",
        class_id=other_class["id"],
        teacher_username="teacher2",
    )

    # 模拟生产服务重启。普通 v4 initialize 不能把所有教师、班级和学生再次
    # 汇入 GVC-LEGACY，否则两个原本隔离的教师会经共享 legacy run 互相越权。
    db._schema_ready = False
    assert db.initialize_schema() == []

    assert other_class["id"] not in {row["id"] for row in db.list_classes("teacher")}
    assert 1 not in {row["id"] for row in db.list_classes("teacher2")}
    assert "teacher2_student" not in {row["username"] for row in db.list_students(teacher_username="teacher")}
    assert db.update_student(other_student["id"], {"display_name": "越权修改"}, "teacher") is None
    assert "GVC-LEGACY" not in {row["code"] for row in db.list_course_runs("teacher2")}


def test_revoked_course_manage_access_cannot_enumerate_course_or_submission_metadata():
    """撤销 can_manage 后，列表端点也必须与详情/评分端点一样 fail closed。"""
    _login("student")
    db.provision_teacher("teacher2", "教师二", "teacher2-private-password")
    teacher2 = _login("teacher2", "teacher2-private-password")
    run = db.create_course_run("teacher2", "教师二私有课程", "T2-PRIVATE")
    cls = db.create_class("教师二私有班", "T2-PRIVATE-CLASS", teacher_username="teacher2")
    student = db.create_student(
        "teacher2_private_student",
        "教师二学生",
        "student-private-password",
        class_id=cls["id"],
        teacher_username="teacher2",
    )
    db.enroll_student("teacher2", run["id"], student["id"], cls["id"])
    db.create_assignment("teacher2", run["id"], "private-lab", "私有作业", "private-manifest")
    provenance = {"artifact": {"years": [2020]}, "runs": []}
    assert _save_generated_report(
        "teacher2_private_student",
        "private-report",
        "private-manifest",
        "# 私有报告",
        provenance,
    )
    submission = db.submit_report("teacher2_private_student", "私有提交", "private-report", "private-manifest")
    assert submission

    assert run["id"] in {
        row["id"] for row in client.get("/api/classroom/course-runs", headers=teacher2).json()["course_runs"]
    }
    assert submission["id"] in {
        row["id"] for row in client.get("/api/classroom/submissions", headers=teacher2).json()["submissions"]
    }

    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute(
            "UPDATE teacher_course_access SET can_manage=false"
            " WHERE teacher_account_id=(SELECT id FROM accounts WHERE username='teacher2')"
            " AND course_run_id=%s",
            (run["id"],),
        )

    assert run["id"] not in {
        row["id"] for row in client.get("/api/classroom/course-runs", headers=teacher2).json()["course_runs"]
    }
    assert submission["id"] not in {
        row["id"] for row in client.get("/api/classroom/submissions", headers=teacher2).json()["submissions"]
    }


def test_shared_class_teacher_dashboard_does_not_mix_other_course_attempts_or_submissions():
    """共享班级只共享花名册，不得让另一教师课程的 attempt、成绩和活动串入概览。"""
    _login("student")
    course_a = db.assignment_context("student", "manifest-course-a")
    assert course_a and course_a["attempt_id"]

    db.provision_teacher("teacher2", "教师二", "teacher2-private-password")
    course_b = db.list_course_runs("teacher2")[0]
    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        # 教务层显式共享同一个班级；两个教师仍只拥有各自 course_run 的学习记录。
        connection.execute("INSERT INTO course_class_links(course_run_id,class_id) VALUES (%s,1)", (course_b["id"],))
    student_id = db.find_account("student")["id"]
    db.enroll_student("teacher2", course_b["id"], student_id, 1)
    assignment_b = db.create_assignment(
        "teacher2", course_b["id"], "course-b-lab", "教师二课程作业", "manifest-course-b"
    )
    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute(
            "UPDATE assignments SET created_at=now()+interval '1 second' WHERE id=%s", (assignment_b["id"],)
        )
    # v5 不会让新发布的课程隐式抢占学生作用域；本用例要准备 B 课程记录，
    # 因此像前端选择器一样做一次显式切换。
    scope_b = db.select_student_assignment("student", assignment_b["id"], "manifest-course-b")
    assert scope_b and scope_b["assignment_id"] == assignment_b["id"]
    db.upsert_progress("student", 12)
    provenance = {"artifact": {"years": [2020]}, "runs": []}
    assert _save_generated_report("student", "course-b-report", "manifest-course-b", "# B 课程报告", provenance)
    submitted_b = db.submit_report("student", "B 课程提交", "course-b-report", "manifest-course-b")
    assert submitted_b

    teacher_a_row = db.list_students(teacher_username="teacher")[0]
    teacher_b_row = db.list_students(teacher_username="teacher2")[0]
    assert teacher_a_row["assignment_id"] == course_a["assignment_id"]
    assert teacher_a_row["attempt_id"] == course_a["attempt_id"]
    assert teacher_a_row["max_step"] is None
    assert teacher_a_row["submission_id"] is None
    assert teacher_b_row["assignment_id"] == assignment_b["id"]
    assert teacher_b_row["attempt_id"] == scope_b["attempt_id"]
    assert teacher_b_row["max_step"] == 12
    assert teacher_b_row["submission_id"] == submitted_b["id"]

    overview_a = db.overview_stats(teacher_username="teacher")
    overview_b = db.overview_stats(teacher_username="teacher2")
    assert overview_a["submitted"] == 0 and overview_a["active_7d"] == 0
    assert overview_b["submitted"] == 1 and overview_b["active_7d"] == 1


def test_submission_and_grading_versions_are_append_only_and_reset_is_consistent():
    _login("student")
    manifest = "manifest-version-history"
    before = db.assignment_context("student", manifest)
    assert before
    provenance = {"artifact": {"years": [2020]}, "runs": []}
    _save_generated_report("student", "report-v1", manifest, "# 第一版", provenance)
    first = db.submit_report("student", "第一版", "report-v1", manifest)
    assert first and first["version_no"] == 1
    assert db.grade_submission(first["id"], 88, "第一版评语", "teacher")

    _save_generated_report("student", "report-v2", manifest, "# 第二版", provenance)
    second = db.submit_report("student", "第二版", "report-v2", manifest)
    assert second and second["id"] == first["id"] and second["version_no"] == 2
    history = db.submission_history(first["id"], "teacher")
    assert history and [row["markdown"] for row in history["versions"]] == ["# 第一版", "# 第二版"]
    assert history["grades"][0]["version_no"] == 1 and history["grades"][0]["score"] == 88

    # 重置切换 attempt：当前进度/报告/提交为空，但不可变历史仍可审计。
    db.upsert_progress("student", 12)
    db.clear_session(
        "student",
        expected_assignment_id=before["assignment_id"],
        expected_attempt_id=before["attempt_id"],
    )
    after = db.assignment_context("student", manifest)
    assert after and after["attempt_id"] != before["attempt_id"]
    assert db.get_progress("student") is None
    assert db.latest_report("student") is None
    assert db.my_submission("student") is None
    assert len(db.submission_history(first["id"], "teacher")["versions"]) == 2


def test_report_and_step16_session_are_atomic_and_revision_bound():
    _login("student")
    manifest = "manifest-atomic-report"
    base = session_model.empty_session(manifest)
    saved = db.save_session("student", base, 0, session_model.merge_sessions)
    assert saved and saved["revision"] == 1
    updated = session_model.empty_session(manifest)
    updated["steps"]["16"] = session_model.make_record({"report_key": "atomic-key"})
    provenance = {"artifact": {"years": [2020]}, "runs": []}

    atomic = db.save_generated_report_and_session(
        "student", "atomic-key", 1, manifest, "# 原子报告", provenance, updated
    )
    assert atomic and atomic["revision"] == 2
    assert db.latest_report("student")["markdown"] == "# 原子报告"
    assert db.get_session("student")["session"]["steps"]["16"]["data"]["report_key"] == "atomic-key"

    # 同一内容重复生成必须真正幂等：不改不可变正文，也不靠刷新时间戳推进 revision。
    again = db.save_generated_report_and_session(
        "student", "atomic-key", 2, manifest, "# 不能覆盖原文", {"new": True}, updated
    )
    assert again and again["revision"] == 2
    assert again["report"]["markdown"] == "# 原子报告"
    assert db.get_session("student")["revision"] == 2

    # 旧 revision 冲突必须整笔回滚，不能留下 orphan report。
    with pytest.raises(db.SessionRevisionConflict):
        db.save_generated_report_and_session("student", "orphan-key", 1, manifest, "# 不应落库", provenance, updated)
    assert db.report_by_key("student", "orphan-key") is None

    # report_key 是内容指纹；新 attempt 可能生成同一内容，唯一边界必须是 attempt。
    db.start_new_attempt("student", manifest)
    db.save_session("student", base, 0, session_model.merge_sessions)
    repeated = db.save_generated_report_and_session(
        "student", "atomic-key", 1, manifest, "# 原子报告", provenance, updated
    )
    assert repeated
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT count(*) FROM reports WHERE report_key='atomic-key'").fetchone()[0] == 2


def test_evidence_event_cannot_cross_attempt_boundary():
    _login("student")
    manifest = "manifest-event-scope"
    context = db.assignment_context("student", manifest)
    event = db.record_evidence_event("student", 1, "quiz", manifest, "a" * 64, {"ok": True})
    assert db.evidence_event_exists(
        "student", event["event_id"], context["assignment_id"], context["attempt_id"], "a" * 64
    )
    db.start_new_attempt("student", manifest)
    assert not db.evidence_event_exists(
        "student", event["event_id"], context["assignment_id"], context["attempt_id"], "a" * 64
    )


@needs_artifacts
def test_quiz_rollout_reset_archives_current_attempt_once_and_preserves_history():
    from gvcsim import quizzes

    _login("student")
    manifest = _manifest_id()
    before = db.assignment_context("student", manifest)
    assert before and before["attempt_id"]
    session = session_model.empty_session(manifest)
    assert db.save_session("student", session, 0, session_model.merge_sessions)
    event = db.record_evidence_event("student", 1, "quiz", manifest, "a" * 64, {"payload": {}})
    assert _save_generated_report("student", "pre-quiz-report", manifest, "# 历史报告", {"runs": []})

    result = db.reset_active_attempts_for_quiz(quizzes.QUIZ_VERSION, manifest)
    assert result["already_applied"] is False and result["reset_count"] == 1
    after = db.assignment_context("student", manifest)
    assert after and after["attempt_id"] != before["attempt_id"]
    assert db.get_session("student", manifest) is None

    with psycopg.connect(TEST_DSN) as connection:
        old_state = connection.execute(
            "SELECT state FROM experiment_attempts WHERE id=%s", (before["attempt_id"],)
        ).fetchone()[0]
        assert old_state == "archived"
        assert (
            connection.execute(
                "SELECT count(*) FROM attempt_sessions WHERE attempt_id=%s", (before["attempt_id"],)
            ).fetchone()[0]
            == 1
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM reports WHERE attempt_id=%s AND report_key='pre-quiz-report'",
                (before["attempt_id"],),
            ).fetchone()[0]
            == 1
        )
        assert (
            connection.execute(
                "SELECT revoked_at IS NOT NULL FROM learning_evidence_events WHERE id=%s", (event["event_id"],)
            ).fetchone()[0]
            is True
        )
        attempts_before_retry = connection.execute("SELECT count(*) FROM experiment_attempts").fetchone()[0]

    repeated = db.reset_active_attempts_for_quiz(quizzes.QUIZ_VERSION, manifest)
    assert repeated["already_applied"] is True and repeated["reset_count"] == 1
    with psycopg.connect(TEST_DSN) as connection:
        assert connection.execute("SELECT count(*) FROM experiment_attempts").fetchone()[0] == attempts_before_retry


def test_quiz_and_regression_receipts_cannot_cross_new_assignment_with_same_manifest():
    """新 assignment 不会归档旧 attempt；答题与运行收据仍须按 current scope 失效。"""
    from gvcsim import evidence, quizzes, trusted_evidence

    _login("student")
    manifest = "manifest-same-release-new-assignment"
    old_scope = db.assignment_context("student", manifest)
    assert old_scope

    def regression_token(step: int, design: dict) -> str:
        result = {"depvar": "DVAex_share", "coefs": []}
        event = db.record_evidence_event(
            "student",
            step,
            "regression",
            manifest,
            trusted_evidence.digest({"design": design, "result": result}),
            {"design": design, "result_sha256": trusted_evidence.digest(result)},
        )
        return trusted_evidence.issue_regression_run(
            subject="student", manifest_id=manifest, design=design, result=result, event=event
        )

    run_design = {
        "outcome": "trade",
        "granularity": "country_industry",
        "shock_type": "tariff",
        "method": "did",
        "control_mode": "none",
        "interaction": False,
        "price_mode": "nominal",
        "scenario": "clean",
        "exclude_row": True,
        "weight_mode": "fixed_pretreatment",
    }
    run_token = regression_token(12, run_design)
    quiz_payload = quizzes.correct_quiz(12)
    quiz_event = db.record_evidence_event(
        "student", 12, "quiz", manifest, trusted_evidence.digest(quiz_payload), {"payload": quiz_payload}
    )
    quiz_token = trusted_evidence.issue_quiz_completion(
        subject="student",
        step=12,
        manifest_id=manifest,
        payload=quiz_payload,
        event=quiz_event,
    )

    assert trusted_evidence.verify_quiz_completion(
        quiz_token, subject="student", step=12, manifest_id=manifest, payload=quiz_payload
    )
    assert trusted_evidence.verify_regression_run(
        run_token,
        subject="student",
        manifest_id=manifest,
        outcome="trade",
        settings={"controlMode": "none"},
        step=12,
    )

    step12_data = {
        "run": {"depvar": "DVAex_share", "settings": {"controlMode": "none"}},
        "run_id": run_token,
        "quiz": quiz_payload,
        "quiz_id": quiz_token,
    }
    old_session = _session_body({"12": session_model.make_record(step12_data)}, manifest)
    assert evidence.evaluate_step(12, old_session, subject="student", require_trusted=True).complete

    newer = db.create_assignment(
        "teacher",
        old_scope["course_run_id"],
        "same-release-next",
        "同一发布的新作业",
        manifest,
    )
    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute("UPDATE assignments SET created_at=now()+interval '1 second' WHERE id=%s", (newer["id"],))
        assert (
            connection.execute(
                "SELECT state FROM experiment_attempts WHERE id=%s", (old_scope["attempt_id"],)
            ).fetchone()[0]
            == "active"
        )
    # 作业切换改为学生显式选择；这里仍验证切换后的凭据边界。
    new_scope = db.select_student_assignment("student", newer["id"], manifest)
    assert new_scope and new_scope["assignment_id"] == newer["id"]

    assert not trusted_evidence.verify_quiz_completion(
        quiz_token, subject="student", step=12, manifest_id=manifest, payload=quiz_payload
    )
    assert not trusted_evidence.verify_regression_run(
        run_token,
        subject="student",
        manifest_id=manifest,
        outcome="trade",
        settings={"controlMode": "none"},
        step=12,
    )
    assert not evidence.evaluate_step(12, old_session, subject="student", require_trusted=True).complete


def test_password_reset_revokes_existing_access_token():
    student_headers = _login("student")
    teacher_headers = _login("teacher")
    student_id = client.get("/api/classroom/students", headers=teacher_headers).json()["students"][0]["id"]
    changed = client.post(
        f"/api/classroom/students/{student_id}",
        headers=teacher_headers,
        json={"password": "new-safe-password"},
    )
    assert changed.status_code == 200
    assert client.get("/api/meta", headers=student_headers).status_code == 401
    _login("student", "new-safe-password")


# ---------------------------------------------------------------- 实验会话


def _session_body(steps: dict, manifest_id: str) -> dict:
    return {"version": session_model.SESSION_VERSION, "manifest_id": manifest_id, "steps": steps}


def _manifest_id() -> str:
    return artifacts.manifest_id()


def _session_request(
    session: dict,
    *,
    base_revision: int = 0,
    username: str = "student",
    context: dict | None = None,
) -> dict:
    """构造带浏览器所见 assignment/attempt 边界的现行会话请求。"""
    scope = context or db.assignment_context(username)
    assert scope and scope["assignment_id"] and scope["attempt_id"]
    return {
        "base_revision": base_revision,
        "expected_assignment_id": scope["assignment_id"],
        "expected_attempt_id": scope["attempt_id"],
        "session": session,
    }


def _attempt_request(context: dict) -> dict:
    return {
        "expected_assignment_id": context["assignment_id"],
        "expected_attempt_id": context["attempt_id"],
    }


@needs_artifacts
def test_session_round_trips_and_survives_relogin():
    """会话必须能跨刷新/重新登录恢复——这正是 HEAD 丢失学生实验的地方。"""
    s = _login("student")
    empty = client.get("/api/classroom/session", headers=s).json()
    assert empty["revision"] == 0 and empty["session"]["steps"] == {}

    body = _session_body({"4": session_model.make_record({"country": "CHN", "year": 2020})}, _manifest_id())
    saved = client.put("/api/classroom/session", headers=s, json=_session_request(body))
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1

    # 重新登录 = 新令牌、新客户端状态;服务端仍应还原实验。
    again = client.get("/api/classroom/session", headers=_login("student")).json()
    assert again["revision"] == 1
    assert again["session"]["steps"]["4"]["data"] == {"country": "CHN", "year": 2020}
    assert again["stale"] is False


@needs_artifacts
def test_stale_tab_cannot_write_an_old_session_into_a_new_attempt():
    """reset 后仍开着的旧标签页必须在服务端边界被拒绝。"""
    headers = _login("student")
    manifest_id = _manifest_id()
    old_scope = db.assignment_context("student", manifest_id)
    assert old_scope and old_scope["attempt_id"]
    stale_session = _session_body(
        {"4": session_model.make_record({"country": "CHN", "year": 2020})},
        manifest_id,
    )

    new_scope = db.start_new_attempt("student", manifest_id)
    assert new_scope["attempt_id"] != old_scope["attempt_id"]

    response = client.put(
        "/api/classroom/session",
        headers=headers,
        json=_session_request(stale_session, context=old_scope),
    )
    assert response.status_code == 409
    assert "attempt 已变化" in response.json()["detail"]
    assert db.get_session("student", manifest_id) is None


@needs_artifacts
def test_concurrent_stale_resets_only_archive_the_expected_attempt_once():
    """两个旧标签页同时 reset 时，后到者不能再归档先到者刚创建的 attempt。"""
    headers = _login("student")
    manifest_id = _manifest_id()
    old_scope = db.assignment_context("student", manifest_id)
    assert old_scope and old_scope["attempt_id"]
    body = _attempt_request(old_scope)

    def reset():
        return client.request("DELETE", "/api/classroom/session", headers=headers, json=body)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = [future.result() for future in [pool.submit(reset), pool.submit(reset)]]

    assert sorted(response.status_code for response in responses) == [200, 409]
    current = db.assignment_context("student", manifest_id)
    assert current
    assert current["attempt_id"] != old_scope["attempt_id"]
    assert current["attempt_no"] == old_scope["attempt_no"] + 1
    stale_new = client.post("/api/classroom/attempts/new", headers=headers, json=body)
    assert stale_new.status_code == 409
    assert db.assignment_context("student", manifest_id)["attempt_id"] == current["attempt_id"]


@needs_artifacts
def test_concurrent_session_writes_merge_per_step_instead_of_clobbering():
    """两个标签页各做一步,不能有一边被整份覆盖掉。"""
    s = _login("student")
    mid = _manifest_id()
    first = client.put(
        "/api/classroom/session",
        headers=s,
        json=_session_request(_session_body({"4": session_model.make_record({"country": "CHN"})}, mid)),
    ).json()
    assert first["revision"] == 1

    # 第二个标签页仍拿着 revision=0,只改了第 12 步。
    second = client.put(
        "/api/classroom/session",
        headers=s,
        json=_session_request(_session_body({"12": session_model.make_record({"shock": "tariff"})}, mid)),
    )
    assert second.status_code == 200
    merged = second.json()
    assert merged["merged_from"] == 1
    # 两步都在:第 4 步没有因为第二次写入而消失。
    assert merged["session"]["steps"]["4"]["data"] == {"country": "CHN"}
    assert merged["session"]["steps"]["12"]["data"] == {"shock": "tariff"}


@needs_artifacts
def test_concurrent_same_step_writes_merge_experiment_and_quiz_fields():
    """同一步骤的实验快照与答题由不同标签页保存时，两者都必须保留。"""
    s = _login("student")
    mid = _manifest_id()
    initial_time = "2026-07-16T10:00:00+00:00"
    action_time = "2026-07-16T10:01:00+00:00"
    quiz_time = "2026-07-16T10:02:00+00:00"
    initial = session_model.make_record({"compared": ["CHN", "USA"]}, initial_time)
    experiment = {
        "data": {"compared": ["CHN", "USA"], "chart": "quadrant"},
        "updated_at": action_time,
        "field_updated_at": {"compared": action_time, "chart": action_time},
    }
    quiz = {
        "data": {
            **initial["data"],
            "quiz": {"version": "course-quiz-v2", "answers": {"q1": "a"}},
            "quiz_id": "quiz-event",
        },
        "updated_at": quiz_time,
        "field_updated_at": {
            **initial["field_updated_at"],
            "quiz": quiz_time,
            "quiz_id": quiz_time,
        },
    }

    first = client.put(
        "/api/classroom/session",
        headers=s,
        json=_session_request(_session_body({"3": experiment}, mid)),
    )
    assert first.status_code == 200, first.text
    second = client.put(
        "/api/classroom/session",
        headers=s,
        json=_session_request(_session_body({"3": quiz}, mid)),
    )
    assert second.status_code == 200, second.text

    merged = second.json()["session"]["steps"]["3"]["data"]
    assert merged["compared"] == ["CHN", "USA"]
    assert merged["chart"] == "quadrant"
    assert merged["quiz_id"] == "quiz-event"


@needs_artifacts
def test_session_from_other_artifacts_is_rejected():
    """产物变了就不能再往当前会话里写旧结果。"""
    s = _login("student")
    body = _session_body({"4": session_model.make_record({"country": "CHN"})}, "0000000000000000")
    resp = client.put("/api/classroom/session", headers=s, json=_session_request(body))
    assert resp.status_code == 409
    assert "产物" in resp.json()["detail"]


@needs_artifacts
def test_stale_session_is_flagged_not_silently_served():
    """产物换代后,旧会话必须被标记为过期,而不是被当成当前结果。"""
    s = _login("student")
    client.put(
        "/api/classroom/session",
        headers=s,
        json=_session_request(_session_body({"4": session_model.make_record({"a": 1})}, _manifest_id())),
    )
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("UPDATE attempt_sessions SET session = jsonb_set(session, '{manifest_id}', '\"deadbeef\"')")
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
        resp = client.put("/api/classroom/session", headers=s, json=_session_request(body))
        assert resp.status_code == 422, body


@needs_artifacts
def test_due_at_is_a_hard_write_boundary_but_preserves_verified_read_state():
    from gvcsim import quizzes

    student = _login("student")
    mid = _manifest_id()
    context = db.assignment_context("student", mid)
    payload = {"compared": ["CHN", "USA"]}
    answer = quizzes.correct_quiz(3)
    graded = client.post("/api/classroom/quiz/submit", headers=student, json={"step": 3, **answer})
    assert graded.status_code == 200, graded.text
    payload.update({"quiz": graded.json()["quiz"], "quiz_id": graded.json()["quiz_id"]})
    session = _session_body({"3": session_model.make_record(payload)}, mid)
    saved = client.put("/api/classroom/session", headers=student, json=_session_request(session, context=context))
    assert saved.status_code == 200 and saved.json()["completion"]["completed"] == [3]

    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute("UPDATE assignments SET due_at=now() WHERE id=%s", (context["assignment_id"],))

    reopened = client.get("/api/classroom/session", headers=student)
    assert reopened.status_code == 200
    assert reopened.json()["assignment_closed"] is True
    assert reopened.json()["read_only"] is True
    assert reopened.json()["stale"] is False
    assert reopened.json()["completion"]["completed"] == [3]
    assert reopened.json()["session"]["steps"]["3"]["data"]["compared"] == ["CHN", "USA"]

    meta = client.get("/api/meta", headers=student).json()
    assert meta["assignment_closed"] is True and meta["due_at"]
    assert meta["assignment_context"]["assignment_closed"] is True

    assert (
        client.put(
            "/api/classroom/session",
            headers=student,
            json=_session_request(session, base_revision=1, context=context),
        ).status_code
        == 409
    )
    assert client.post("/api/classroom/progress", headers=student, json={"step": 4}).status_code == 409
    assert (
        client.request(
            "DELETE",
            "/api/classroom/session",
            headers=student,
            json=_attempt_request(context),
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/classroom/attempts/new",
            headers=student,
            json=_attempt_request(context),
        ).status_code
        == 409
    )
    assert client.post("/api/classroom/report/generate", headers=student).status_code == 409
    assert (
        client.post(
            "/api/classroom/report/submit", headers=student, json={"title": "截止后提交", "report_key": "none"}
        ).status_code
        == 409
    )
    with pytest.raises(db.AssignmentClosed):
        db.record_evidence_event("student", 4, "quiz", mid, "a" * 64, {"payload": {}})


# ------------------------------------------------------- 第 16 步:报告闭环


def _put_complete_session(headers: dict) -> None:
    """只靠真实判题收据写入 1–15 步，另带几项自动保存的实验快照。"""
    from gvcsim import quizzes

    mid = _manifest_id()
    snapshots = {
        1: {
            "slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"},
            "observation": {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 12.5},
        },
        3: {"year": 2020, "metric": "FVA_share", "compared": ["CHN", "USA"]},
        7: {"year": 2020, "chart": "rank", "compared": ["CHN", "USA"]},
        11: {
            "viewed_shock_types": ["tariff", "sanctions", "export_control"],
            "viewed_events": ["测试关税事件", "测试制裁事件", "测试出口管制事件"],
        },
    }
    steps: dict[str, dict] = {}
    for step in range(1, 16):
        answer = quizzes.correct_quiz(step)
        graded = client.post(
            "/api/classroom/quiz/submit",
            headers=headers,
            json={"step": step, **answer},
        )
        assert graded.status_code == 200, graded.text
        body = graded.json()
        assert body["passed"] is True and body.get("quiz_id")
        steps[str(step)] = session_model.make_record(
            {**snapshots.get(step, {}), "quiz": body["quiz"], "quiz_id": body["quiz_id"]}
        )

    resp = client.put("/api/classroom/session", headers=headers, json=_session_request(_session_body(steps, mid)))
    assert resp.status_code == 200, resp.text


@needs_artifacts
def test_report_generation_is_blocked_until_the_first_15_quizzes_pass():
    s = _login("student")
    resp = client.post("/api/classroom/report/generate", headers=s)
    assert resp.status_code == 409
    blocked = resp.json()["detail"]["blocked"]
    assert [item["step"] for item in blocked] == list(range(1, 16))
    # 门槛状态也可单独查询,便于第 16 步界面直接告诉学生还差什么。
    assert client.get("/api/classroom/report/gate", headers=s).json()["blocked"]


@needs_artifacts
def test_report_replay_failure_is_explicit_and_does_not_persist_a_partial_report(monkeypatch):
    student = _login("student")

    def fail_replay(*_args, **_kwargs):
        raise teaching_report.ReportReplayError(12, "贸易流回归", "服务端无法读取当前回归面板")

    monkeypatch.setattr(teaching_report, "build", fail_replay)
    response = client.post("/api/classroom/report/generate", headers=student)

    assert response.status_code == 503
    assert "已记录回归" in response.json()["detail"]
    assert db.latest_report("student") is None
    stored = client.get("/api/classroom/session", headers=student).json()["session"]
    assert "16" not in stored["steps"]


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
    before_generation = client.get("/api/classroom/session", headers=s).json()
    assert before_generation["completion"]["completed_count"] == 15
    # 模拟浏览器防抖队列里已经捕获、但尚未发出的本地快照。报告生成后客户端
    # 会拿到最新 revision；快照本身仍可能没有服务端刚写入的 step 16。
    queued_local_session = before_generation["session"]

    generated = client.post("/api/classroom/report/generate", headers=s)
    assert generated.status_code == 200, generated.text
    report_key = generated.json()["report_key"]

    # 第 16 步的报告记录由服务端写入会话 → 完成度变成 16/16。
    completion = client.get("/api/classroom/session", headers=s).json()["completion"]
    assert completion["completed_count"] == 16

    # 真实事故：onGenerated reload 先把 revision 更新到报告写入后的值，随后这个
    # 旧快照用“相同 revision”执行 PUT。服务端必须仍做记录级 merge，不能让
    # incoming 整份覆盖并删除只由服务端签发的 step 16。
    generated_revision = client.get("/api/classroom/session", headers=s).json()["revision"]
    delayed = client.put(
        "/api/classroom/session",
        headers=s,
        json=_session_request(queued_local_session, base_revision=generated_revision),
    )
    assert delayed.status_code == 200, delayed.text
    assert delayed.json()["merged_from"] is None  # revision 没冲突，但仍必须合并。
    assert delayed.json()["completion"]["completed_count"] == 16
    assert delayed.json()["session"]["steps"]["16"]["data"]["report_key"] == report_key

    persisted = client.get("/api/classroom/session", headers=s).json()
    assert persisted["completion"]["completed_count"] == 16
    assert persisted["session"]["steps"]["16"]["data"]["report_key"] == report_key

    # 刷新/重新登录后仍能重新打开报告全文。
    reopened = client.get("/api/classroom/report/generated", headers=_login("student")).json()
    assert reopened["report_key"] == report_key
    assert reopened["markdown"] == generated.json()["markdown"]
    assert reopened["provenance"]["manifest_id"] == _manifest_id()

    revision = persisted["revision"]
    repeated = client.post("/api/classroom/report/generate", headers=s)
    assert repeated.status_code == 200
    assert repeated.json() == generated.json()
    assert client.get("/api/classroom/session", headers=s).json()["revision"] == revision


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
    这条用例把该语义钉死:在有真实答题结果之前,任何一层都不得把它当作完成度——
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
    # 可撤销令牌逐请求复查数据库；故障必须明确 503，不能伪装成无效令牌 401。
    assert client.get("/api/meta", headers=s).status_code == 503
    assert client.get("/api/classroom/announcements", headers=s).status_code == 503
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 200
    bad = client.post("/api/auth/login", json={"username": "teacher", "password": "wrong"})
    assert bad.status_code == 503
    assert "认证数据库不可用" in bad.json()["detail"]


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
            json=_session_request(_session_body({step: session_model.make_record(data)}, mid)),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [
            f.result()
            for f in [
                pool.submit(put, "4", {"compared": ["CHN", "USA"]}),
                pool.submit(put, "12", {"run": {"depvar": "FVA_share"}}),
            ]
        ]
    assert all(r.status_code == 200 for r in results), [r.text for r in results]

    steps = client.get("/api/classroom/session", headers=s).json()["session"]["steps"]
    # 两边的实验都必须还在:任何一步消失都说明发生了整份覆盖。
    assert "4" in steps and "12" in steps, f"并发首写丢了数据:{sorted(steps)}"

"""测试夹具:手工构造的 2 国 × 2 行业迷你 ICIO 系统。

数值满足会计恒等式(x = Z行和 + Y行和)且各部门增加值为正,
用于验证指标计算的数学性质,不依赖真实数据下载。
"""

import json
import os
from pathlib import Path
from types import SimpleNamespace

# 应用不再含数据库 DSN/演示口令默认值。测试必须显式选择隔离的 demo 配置，
# 且要在测试模块 import ``gvcsim.api`` 之前设置。
os.environ.setdefault(
    "GVCSIM_PG_DSN",
    os.environ.get("GVCSIM_PG_DSN_TEST", "postgresql://alice:111111@127.0.0.1:5432/gvclab_test"),
)
os.environ.setdefault("GVCSIM_DEMO_MODE", "1")
os.environ.setdefault("GVCSIM_BOOTSTRAP_PASSWORD", "gvclab2026")
os.environ.setdefault("GVCSIM_AUTH_SECRET", "tests-only-auth-secret-at-least-32-bytes")

import numpy as np
import pandas as pd
import pytest

# 检出目录的原始数据形态决定数据集分支。CI 合成夹具必须同时带上生成器要求的
# 两道环境闸门，否则 ``artifact_data_sources`` / ``dimension_contract_for`` 会
# fail-closed，而真实数据断言又会跑在 15×24 的合成表上。显式设置的值优先；
# 这段必须在 import ``gvcsim.config`` 之前执行，它会在导入时读取这些变量。
if (
    Path(os.environ.get("GVCSIM_RAW_DATA_DIR") or (Path(__file__).resolve().parents[1] / "OECD_ICIO"))
    / ".ci-only-synthetic.json"
).is_file():
    os.environ.setdefault("CI", "true")
    os.environ.setdefault("GVCSIM_CI_SYNTHETIC", "1")

from gvcsim.config import RAW_DATA_DIR

REGIONS = ["AAA", "BBB"]
SECTORS = ["s1", "s2"]


@pytest.fixture(autouse=True)
def clear_process_request_limits():
    """Keep process-local production limiters isolated between unit tests."""
    from gvcsim import auth_routes, regression_routes

    auth_routes.clear_rate_limits()
    regression_routes.clear_rate_limits()
    yield
    auth_routes.clear_rate_limits()
    regression_routes.clear_rate_limits()


@pytest.fixture(autouse=True)
def clear_regression_results():
    """Completed runs are cached per release, and tests feed their own panels under one release: start each empty."""
    from gvcsim import regression_routes

    regression_routes.clear_result_cache()
    yield
    regression_routes.clear_result_cache()


@pytest.fixture(params=["hash", "notify"])
def file_identity_backend(request, monkeypatch):
    from gvcsim import file_identity

    monkeypatch.setenv("GVCSIM_FILE_CACHE_MODE", request.param)
    monitor = file_identity._new_monitor()
    monkeypatch.setattr(file_identity, "_monitor", monitor)
    yield request.param
    if monitor is not None:
        monitor.close()


@pytest.fixture
def freeze_file_metadata(monkeypatch):
    """Force stat-key collisions without depending on filesystem clock precision."""
    snapshots = {}
    original = Path.stat

    def frozen(path, *args, **kwargs):
        return snapshots[path] if path in snapshots else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", frozen)

    def freeze(path):
        snapshots[path] = original(path)
        return snapshots[path]

    return freeze


@pytest.fixture
def teaching_db(monkeypatch):
    """Create a fresh v13 classroom database for each database test."""
    import psycopg

    from gvcsim import artifacts, config, demo_accounts
    from gvcsim.classroom import db

    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "a" * 32)
    monkeypatch.setattr(
        artifacts,
        "validate_release_cached",
        lambda _path=None: {"release_id": "a" * 32, "files": 1, "years": 1},
    )
    # Most database tests need only the compatibility student.  The dedicated
    # demo-pool test expands this to the production default of 50 once.
    monkeypatch.setattr(demo_accounts, "DEMO_STUDENT_COUNT", 1)

    from db_guard import authorize_reset

    host, port, database, user = authorize_reset(config.PG_DSN)
    db.shutdown()
    with psycopg.connect(config.PG_DSN, autocommit=True) as connection:
        actual = connection.execute("SELECT current_database(), current_user").fetchone()
        # A local Docker port can map to a different server address/port. Verify the client endpoint and
        # the server-reported database/user, rather than comparing the container's internal address.
        if (connection.info.host, str(connection.info.port)) != (host, port) or actual != (database, user):
            raise ValueError("实际连接不是批准的一次性测试库，拒绝重置")
        connection.execute("DROP SCHEMA public CASCADE")
        connection.execute("CREATE SCHEMA public")
    db._schema_ready = False
    db.initialize_schema()
    yield db
    db.shutdown()


@pytest.fixture(scope="session")
def ci_synthetic_contract() -> dict | None:
    """Return the explicit CI-only dataset contract, never infer it from size.

    Real OECD runs keep their strict 77×45 assertions.  The smaller expectations
    are enabled only when both the CI environment flag and the generator's marker
    are present, preventing an accidental partial production dataset from passing.
    """
    if os.environ.get("GVCSIM_CI_SYNTHETIC") != "1":
        return None
    marker = Path(RAW_DATA_DIR) / ".ci-only-synthetic.json"
    if not marker.is_file():
        pytest.fail(f"GVCSIM_CI_SYNTHETIC=1 but marker is missing: {marker}")
    payload = json.loads(marker.read_text(encoding="utf-8"))
    assert payload["kind"] == "gvcsim-ci-only-synthetic-oecd-icio"
    assert payload["production_data"] is False
    return payload


class FakeIOSystem:
    """最小化模拟 pymrio.IOSystem 的接口(Z/Y/x/A/L + get_regions/get_sectors)。"""

    def __init__(
        self,
        Z: np.ndarray,
        Y: np.ndarray,
        regions: list[str] | None = None,
        sectors: list[str] | None = None,
    ):
        self._regions = regions or REGIONS
        self._sectors = sectors or SECTORS
        index = pd.MultiIndex.from_product([self._regions, self._sectors], names=["region", "sector"])
        y_cols = pd.MultiIndex.from_product([self._regions, ["final"]], names=["region", "category"])

        x = Z.sum(axis=1) + Y.sum(axis=1)
        A = Z / x[None, :]
        L = np.linalg.inv(np.eye(len(x)) - A)

        self.Z = pd.DataFrame(Z, index=index, columns=index)
        self.Y = pd.DataFrame(Y, index=index, columns=y_cols)
        self.x = pd.DataFrame({"indout": x}, index=index)
        self.A = pd.DataFrame(A, index=index, columns=index)
        self.L = pd.DataFrame(L, index=index, columns=index)
        self.reported_output = pd.Series(x, index=index, name="OUT")
        primary_inputs = x - Z.sum(axis=0)
        self.factor_inputs = SimpleNamespace(
            F=pd.DataFrame(
                [np.zeros_like(primary_inputs), primary_inputs],
                index=pd.Index(["TLS", "VA"], name="inputtype"),
                columns=index,
            )
        )
        self.unit = pd.DataFrame({"unit": "Million USD"}, index=index)

    def get_regions(self):
        return self._regions

    def get_sectors(self):
        return self._sectors


@pytest.fixture
def fake_io() -> FakeIOSystem:
    Z = np.array(
        [
            [10.0, 5.0, 4.0, 2.0],
            [3.0, 8.0, 2.0, 1.0],
            [2.0, 1.0, 12.0, 6.0],
            [1.0, 2.0, 3.0, 9.0],
        ]
    )
    Y = np.array(
        [
            [30.0, 10.0],
            [20.0, 5.0],
            [8.0, 40.0],
            [5.0, 25.0],
        ]
    )
    return FakeIOSystem(Z, Y)


@pytest.fixture
def autarky_io() -> FakeIOSystem:
    """无任何跨国交易的封闭系统:跨境指标应全为 0。"""
    Z = np.array(
        [
            [10.0, 5.0, 0.0, 0.0],
            [3.0, 8.0, 0.0, 0.0],
            [0.0, 0.0, 12.0, 6.0],
            [0.0, 0.0, 3.0, 9.0],
        ]
    )
    Y = np.array(
        [
            [30.0, 0.0],
            [20.0, 0.0],
            [0.0, 40.0],
            [0.0, 25.0],
        ]
    )
    return FakeIOSystem(Z, Y)


@pytest.fixture
def cycle_io() -> FakeIOSystem:
    """3 国 × 1 行业循环链条:A→B→C→A,用于检验返回与重复计算项。"""
    regions = ["AAA", "BBB", "CCC"]
    sectors = ["s1"]
    Z = np.array(
        [
            [5.0, 20.0, 0.0],
            [0.0, 5.0, 18.0],
            [16.0, 0.0, 5.0],
        ]
    )
    Y = np.array(
        [
            [30.0, 0.0, 2.0],
            [2.0, 30.0, 0.0],
            [0.0, 2.0, 30.0],
        ]
    )
    return FakeIOSystem(Z, Y, regions=regions, sectors=sectors)

"""Authorize destructive fixtures only on an explicitly selected local test database."""

import os

from psycopg.conninfo import conninfo_to_dict


def test_target(dsn: str) -> tuple[str, str, str, str]:
    params = conninfo_to_dict(dsn)
    # Do not let libpq services, hostaddr or environment defaults redirect the connection.
    if params.get("service") or params.get("hostaddr"):
        raise ValueError("测试数据库不允许 service 或 hostaddr")
    host, port, database, user = (params.get(key, "") for key in ("host", "port", "dbname", "user"))
    if host not in {"127.0.0.1", "::1"} or not port.isdecimal() or not 0 < int(port) < 65536:
        raise ValueError("测试数据库必须显式指定本机 IP 和端口")
    if not user or not database.endswith("_test"):
        raise ValueError("测试数据库必须显式指定用户，库名必须以 _test 结尾")
    return host, str(int(port)), database, user


def authorize_reset(dsn: str) -> tuple[str, str, str, str]:
    if os.environ.get("GVCSIM_ENV", "").strip().lower() in {"production", "prod"}:
        raise ValueError("生产环境禁止重置数据库")
    if any(os.environ.get(key) for key in ("PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR")):
        raise ValueError("测试数据库禁止隐式 service/hostaddr 配置")
    expected = os.environ.get("GVCSIM_PG_DSN_TEST")
    if not expected:
        raise ValueError("请显式设置 GVCSIM_PG_DSN_TEST 为专用的一次性测试库")
    target = test_target(dsn)
    if target != test_target(expected):
        raise ValueError("应用与测试数据库的主机、端口、库名或用户不一致，拒绝重置")
    return target

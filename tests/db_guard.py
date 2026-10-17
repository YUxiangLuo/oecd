"""Refuse to run the destructive pytest fixtures against a non-test database.

``tests/conftest.py`` has a ``teaching_db`` fixture that executes
``DROP SCHEMA public CASCADE`` on the database in ``GVCSIM_PG_DSN``.  The
guard runs at collection time, before any fixture can connect, and requires a
database name that looks like a dedicated test database.  It also catches the
common ``source .env.local`` accident, where ``GVCSIM_PG_DSN`` points at the
classroom database while ``GVCSIM_PG_DSN_TEST`` points at the test one.

Set ``GVCSIM_ALLOW_DB_RESET=1`` only when the target is known to be a
throwaway database whose name does not contain ``test``.
"""

from __future__ import annotations

from urllib.parse import unquote, urlsplit

ALLOW_ENV = "GVCSIM_ALLOW_DB_RESET"


def database_name(dsn: str | None) -> str | None:
    """The database name of a libpq URI or keyword/value DSN, without credentials."""
    if not dsn or not dsn.strip():
        return None
    value = dsn.strip()
    if value.startswith(("postgresql://", "postgres://")):
        path = urlsplit(value).path
        name = unquote(path.lstrip("/"))
        return name or None
    for token in value.split():
        key, separator, raw = token.partition("=")
        if separator and key in {"dbname", "database"}:
            name = raw.strip("'\"")
            return name or None
    return None


def _enabled(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def database_problem(
    dsn: str | None,
    test_dsn: str | None = None,
    *,
    allow_reset: str | None = None,
    app_env: str | None = None,
) -> str | None:
    """Why pytest must not touch this DSN, or None when it is a dedicated test database."""
    if _enabled(allow_reset):
        return None
    if (app_env or "").strip().lower() in {"production", "prod"}:
        return "GVCSIM_ENV=production：pytest 的 teaching_db 夹具会清空所连库的 public schema。"
    name = database_name(dsn)
    if not name:
        return "GVCSIM_PG_DSN 为空或无法解析数据库名。"
    test_name = database_name(test_dsn)
    if test_dsn and not test_name:
        return "GVCSIM_PG_DSN_TEST 已设置但无法解析数据库名。"
    if test_name and test_name != name:
        return f"GVCSIM_PG_DSN 指向 {name}，GVCSIM_PG_DSN_TEST 指向 {test_name}；两者不是同一个库。"
    if "test" not in name.casefold():
        return f"GVCSIM_PG_DSN 指向 {name}，数据库名不含 test。"
    return None

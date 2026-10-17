"""The pytest database guard: a destructive fixture must never meet a classroom database."""

import pytest

from db_guard import ALLOW_ENV, database_name, database_problem


@pytest.mark.parametrize(
    "dsn, expected",
    [
        ("postgresql://alice:secret@127.0.0.1:5432/gvclab_test", "gvclab_test"),
        ("postgresql://alice:secret@db.example:5432/gvclab_test?sslmode=require", "gvclab_test"),
        ("postgresql://alice:secret@127.0.0.1:5432/gvclab%5Ftest", "gvclab_test"),
        ("host=127.0.0.1 port=5432 dbname=gvclab_test user=alice password=secret", "gvclab_test"),
        ("host=127.0.0.1 dbname='gvclab_test' user=alice", "gvclab_test"),
        ("postgresql://alice:secret@127.0.0.1:5432/", None),
        ("host=127.0.0.1 user=alice", None),
        ("", None),
        (None, None),
    ],
)
def test_database_name_reads_uri_and_keyword_dsns(dsn, expected):
    assert database_name(dsn) == expected


def test_the_default_test_dsn_and_a_matching_pair_are_allowed():
    test_dsn = "postgresql://alice:secret@127.0.0.1:5432/gvclab_test"
    assert database_problem(test_dsn) is None
    assert database_problem(test_dsn, test_dsn) is None
    assert database_problem("host=127.0.0.1 dbname=gvclab_test", None) is None


def test_the_classroom_database_is_refused():
    classroom = "postgresql://alice:secret@127.0.0.1:5432/gvclab"
    reason = database_problem(classroom)
    assert reason is not None
    assert "gvclab" in reason and "不含 test" in reason
    assert "secret" not in reason


def test_a_mismatched_test_dsn_catches_the_sourced_env_local_accident():
    classroom = "postgresql://alice:secret@127.0.0.1:5432/gvclab"
    test_dsn = "postgresql://alice:secret@127.0.0.1:5432/gvclab_test"
    reason = database_problem(classroom, test_dsn)
    assert reason is not None
    assert "gvclab" in reason and "gvclab_test" in reason and "不是同一个库" in reason
    assert "secret" not in reason


def test_production_is_refused_even_with_a_test_named_database():
    test_dsn = "postgresql://alice:secret@127.0.0.1:5432/gvclab_test"
    reason = database_problem(test_dsn, test_dsn, app_env="production")
    assert reason is not None and "production" in reason


def test_a_malformed_test_dsn_is_refused():
    test_dsn = "postgresql://alice:secret@127.0.0.1:5432/gvclab_test"
    reason = database_problem(test_dsn, "not-a-postgres-dsn")
    assert reason is not None and "无法解析" in reason


def test_missing_dsn_is_refused():
    assert "为空" in (database_problem(None) or "")
    assert "为空" in (database_problem("") or "")


def test_explicit_override_is_the_only_way_for_another_database_name():
    classroom = "postgresql://alice:secret@127.0.0.1:5432/gvclab"
    assert database_problem(classroom, allow_reset="1") is None
    assert ALLOW_ENV == "GVCSIM_ALLOW_DB_RESET"

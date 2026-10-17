import pytest

from db_guard import authorize_reset


DSN = "postgresql://agent@127.0.0.1:5432/course_test"


def test_reset_requires_an_explicit_local_test_target(monkeypatch):
    for key in ("GVCSIM_PG_DSN_TEST", "GVCSIM_ENV", "PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(ValueError):
        authorize_reset(DSN)
    monkeypatch.setenv("GVCSIM_PG_DSN_TEST", DSN)
    assert authorize_reset(DSN) == ("127.0.0.1", "5432", "course_test", "agent")
    assert authorize_reset("host=127.0.0.1 port=5432 user=agent dbname='course_test'") == authorize_reset(DSN)
    for unsafe in (
        DSN + "?dbname=classroom",
        "host=127.0.0.1 port=5432 user=agent dbname=course_test dbname=classroom",
        DSN.replace("course_test", "latest_classroom"),
        DSN.replace("127.0.0.1", "example.com"),
        DSN.replace("5432", "5433"),
        DSN + "?hostaddr=192.0.2.1",
        DSN + "?service=classroom",
        "dbname=course_test",
    ):
        with pytest.raises(ValueError):
            authorize_reset(unsafe)
    monkeypatch.setenv("GVCSIM_ALLOW_DB_RESET", "1")
    for environment in ("production", " PrOd "):
        monkeypatch.setenv("GVCSIM_ENV", environment)
        with pytest.raises(ValueError):
            authorize_reset(DSN)
    monkeypatch.setenv("GVCSIM_ENV", "development")
    for key in ("PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR"):
        monkeypatch.setenv(key, "unsafe")
        with pytest.raises(ValueError):
            authorize_reset(DSN)
        monkeypatch.delenv(key)

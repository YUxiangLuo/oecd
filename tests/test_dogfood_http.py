"""Deployment probes must distinguish HTTP overload from broken JSON."""

from io import BytesIO
from urllib.error import HTTPError

import pytest

from scripts import dogfood_sync


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (401, b'{"detail":"expired"}', {"detail": "expired"}),
        (503, b"Service Unavailable", {"detail": "Service Unavailable"}),
        (502, b"<html>bad gateway</html>\xff", {"detail": "<html>bad gateway</html>\ufffd"}),
    ],
)
def test_http_error_preserves_status(monkeypatch, status, body, expected):
    def unavailable(*args, **kwargs):
        raise HTTPError("http://localhost/api/meta", status, "error", {}, BytesIO(body))

    monkeypatch.setattr(dogfood_sync, "urlopen", unavailable)
    assert dogfood_sync.request("http://localhost", "GET", "/api/meta") == (status, expected)

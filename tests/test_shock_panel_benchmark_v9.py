import json
from functools import lru_cache
from pathlib import Path

import pytest

from scripts import benchmark_shock_panel_v9 as benchmark
from scripts.benchmark_shock_panel_v9 import percentile, sample_summary


def test_benchmark_percentile_and_budget_contract():
    values = [float(value) for value in range(1, 21)]
    assert percentile(values) == 19.0
    assert sample_summary(values, 19.0)["passed"] is True
    assert sample_summary(values, 18.9)["passed"] is False
    with pytest.raises(ValueError, match="must not be empty"):
        percentile([])


def test_old_v3_result_is_explicitly_preliminary():
    payload = json.loads(Path("benchmarks/shock_panel_preliminary_v3.json").read_text(encoding="utf-8"))
    assert payload["environment"]["existing_artifact_contract"] == 3
    assert payload["status"] == "preliminary_not_v7_attestation"


def test_v9_harness_rebuilds_only_cold_index_through_authenticated_route(monkeypatch):
    events = []
    index_builds = []

    def validate_release(_root):
        events.append("validate_release")
        return {"release_id": "r" * 32, "files": 40, "years": 3}

    @lru_cache(maxsize=1)
    def fake_exposure_index(release):
        index_builds.append(release)
        return object()

    class Response:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

    class Client:
        def __init__(self, _app):
            self.headers = {}
            self.logged_in = False

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, path, json):
            events.append(("post", path, json["username"]))
            self.logged_in = True
            return Response({"token": "benchmark-token"})

        def get(self, path, params):
            assert self.logged_in is True
            assert self.headers["Authorization"] == "Bearer benchmark-token"
            events.append(("get", path))
            fake_exposure_index("active-release")
            return Response({"page_size": params["page_size"], "disclaimer": "validated"})

    fake_exposure_index("active-release")
    assert len(index_builds) == 1
    monkeypatch.setattr(benchmark.artifacts, "validate_release_cached", validate_release)
    monkeypatch.setattr(
        benchmark.artifacts,
        "dataset_metadata",
        lambda _root: {
            "artifact_contract_version": benchmark.artifacts.ARTIFACT_CONTRACT_VERSION,
            "shock_contract": {"version": 7},
            "years": [2018, 2020, 2022],
        },
    )
    monkeypatch.setattr(
        benchmark.artifacts,
        "clear_artifact_caches",
        lambda: pytest.fail("benchmark must preserve validated release and artifact caches"),
    )
    monkeypatch.setattr(benchmark.data_routes, "clear_exposure_index_cache", fake_exposure_index.cache_clear)
    monkeypatch.setattr(benchmark, "TestClient", Client)

    result = benchmark.run_benchmark(
        username="student",
        password="secret",
        sequential_samples=2,
        concurrent_samples=8,
    )

    assert result["passed"] is True
    assert len(index_builds) == 3  # seeded once, then rebuilt once for each of the two cold phases
    assert events[0] == "validate_release"
    assert events[1] == ("post", "/api/auth/login", "student")
    assert [event for event in events if isinstance(event, tuple) and event[0] == "get"] == [
        ("get", "/api/shocks/panel")
    ] * 19
    assert "Only the exposure index is cleared" in result["method"]


def test_v9_harness_refuses_old_release_before_login(monkeypatch):
    monkeypatch.setattr(
        benchmark.artifacts,
        "validate_release_cached",
        lambda _root: {"release_id": "old", "files": 1, "years": 1},
    )
    monkeypatch.setattr(
        benchmark.artifacts,
        "dataset_metadata",
        lambda _root: {
            "artifact_contract_version": benchmark.artifacts.ARTIFACT_CONTRACT_VERSION - 1,
            "years": [2020],
        },
    )
    monkeypatch.setattr(
        benchmark,
        "TestClient",
        lambda _app: pytest.fail("old release must be refused before authentication"),
    )

    with pytest.raises(RuntimeError, match="active artifact contract v9"):
        benchmark.run_benchmark(
            username="student",
            password="secret",
            sequential_samples=2,
            concurrent_samples=8,
        )

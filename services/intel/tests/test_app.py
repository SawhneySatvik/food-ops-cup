"""The HTTP surface: service secret on every POST, run tokens verified, one uniform refusal."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient

from conftest import SECRET
from munim_intel.app import create_app
from munim_intel.config import Config, load_config

UNAUTHENTICATED = {"error": {"code": "unauthenticated", "message": "unauthenticated", "reason_code": None}}


def ce(tenant: str, token: str, n: int) -> dict[str, Any]:
    return {
        "specversion": "1.0",
        "id": f"01920000-0000-7000-8000-0000000000e{n}",
        "time": "2026-10-10T10:00:00Z",
        "datacontenttype": "application/json",
        "tenantid": tenant,
        "munimrun": token,
        "source": f"/tenants/{tenant}/orders",
        "type": "munim.orders.order.placed.v1",
        "subject": "01920000-0000-7000-8000-0000000000f1",
        "data": {"status": "placed"},
    }


def test_health(cfg: Config) -> None:
    r = TestClient(create_app(cfg)).get("/health")
    assert (r.status_code, r.json()) == (200, {"status": "ok", "service": "intel", "model_mode": "recorded"})


def core_refusing() -> httpx.MockTransport:
    """core-api answering every call 503: the run-frame is refused, so each run fails closed (no network in tests)."""
    return httpx.MockTransport(lambda _: httpx.Response(503))


def test_events_are_acknowledged_only_with_the_secret_and_each_events_own_tenant(cfg: Config, minted: dict[str, Any]) -> None:
    client = TestClient(create_app(cfg, core_transport=core_refusing()))
    a, valid, b_token = minted["tenant_a"], minted["tokens"]["valid"], minted["tokens"]["tenant_b"]
    headers = {"x-munim-service-secret": SECRET, "content-type": "application/cloudevents-batch+json"}
    ok = client.post("/events", json=[ce(a, valid, 1), ce(a, valid, 2)], headers=headers)
    assert (ok.status_code, ok.json()) == (202, {"accepted": 2})
    assert client.post("/events", json=ce(a, valid, 3), headers=headers).status_code == 202
    wrong_tenant = client.post("/events", json=[ce(a, valid, 1), ce(a, b_token, 2)], headers=headers)
    no_secret = client.post("/events", json=[ce(a, valid, 1)], headers={"x-munim-service-secret": "nope"})
    for r in (wrong_tenant, no_secret):
        assert (r.status_code, r.json()) == (401, UNAUTHENTICATED)
    assert client.post("/events", json=[{"id": "x"}], headers=headers).status_code == 400
    assert client.post("/events", content=b"{not json", headers=headers).status_code == 400


def test_fanout_calls_need_a_valid_run_token(cfg: Config, minted: dict[str, Any]) -> None:
    # Core refuses the run-frame (T-040b's default source): a sweep fails closed — no country guessed, nothing detected.
    client = TestClient(create_app(cfg, core_transport=core_refusing()))
    run_id = minted["claims"]["valid"]["run_id"]
    for path, body in (("/watch:sweep", {"run_id": run_id, "status": "frame_unavailable"}), ("/brief", {"run_id": run_id})):
        ok = client.post(path, headers={"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['valid']}"})
        assert (ok.status_code, ok.json()) == (202, body)
        expired = client.post(path, headers={"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['expired']}"})
        assert (expired.status_code, expired.json()) == (401, UNAUTHENTICATED)


def test_without_core_key_material_every_post_is_refused(tmp_path: Path, minted: dict[str, Any]) -> None:
    client = TestClient(create_app(load_config(env={"MUNIM_RUN_DIR": str(tmp_path)})))
    r = client.post("/watch:sweep", headers={"x-munim-service-secret": "", "authorization": f"Bearer {minted['tokens']['valid']}"})
    assert r.status_code == 503

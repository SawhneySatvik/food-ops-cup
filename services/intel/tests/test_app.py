"""The HTTP surface: service secret on every POST, run tokens verified, one uniform refusal."""

from __future__ import annotations

import json
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
    for path, body in (("/watch:sweep", {"run_id": run_id, "status": "frame_unavailable"}),):
        ok = client.post(path, headers={"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['valid']}"})
        assert (ok.status_code, ok.json()) == (202, body)
        expired = client.post(path, headers={"x-munim-service-secret": SECRET, "authorization": f"Bearer {minted['tokens']['expired']}"})
        assert (expired.status_code, expired.json()) == (401, UNAUTHENTICATED)


def post(client: TestClient, path: str, token: str) -> httpx.Response:
    res: httpx.Response = client.post(path, headers={"x-munim-service-secret": SECRET, "authorization": f"Bearer {token}"})
    return res


def core_with_one_item() -> httpx.MockTransport:
    """core-api answering the brief-items read with one item and storing the posted answer; any other call is a 503."""
    item = {
        "finding_id": "01920000-0000-7000-8000-000000000f01",
        "pack": "finance",
        "severity": "high",
        "type": "finance.tender_gap",
        "texts": ["Takings differ from the till by \u27e8snap:01920000-0000-7000-8000-000000000501\u00b70\u00b7impact_minor\u27e9."],
        "impact_ref": "\u27e8snap:01920000-0000-7000-8000-000000000501\u00b70\u00b7impact_minor\u27e9",
        "draft_ids": [],
    }

    def handle(req: httpx.Request) -> httpx.Response:
        if req.method == "GET" and req.url.path == "/internal/intel/v1/brief-items":
            return httpx.Response(200, json={"items": [item]})
        if req.method == "POST" and req.url.path == "/internal/intel/v1/answers":
            body = json.loads(req.content)
            return httpx.Response(201, json={"answer_id": body["envelope"]["answer_id"], "abstained": False, "reason_code": None})
        return httpx.Response(503)

    return httpx.MockTransport(handle)


def test_brief_takes_only_a_brief_token_and_posts_one_answer(cfg: Config, minted: dict[str, Any]) -> None:
    client = TestClient(create_app(cfg, core_transport=core_with_one_item()))
    tokens = minted["tokens"]
    ok = post(client, "/brief", tokens["brief"])
    assert (ok.status_code, ok.json()) == (
        202,
        {"run_id": minted["claims"]["brief"]["run_id"], "items": 1, "posted": True, "abstained": False},
    )
    # The pair: the same route refuses every other trigger and an expired token, with the one uniform refusal.
    for other in ("valid", "ask", "ingest", "expired"):
        refused = post(client, "/brief", tokens[other])
        assert (refused.status_code, refused.json()) == (401, UNAUTHENTICATED), other
    # Core down: the read fails, nothing is posted, and the answer is a typed 502 (no text from core).
    down = post(TestClient(create_app(cfg, core_transport=core_refusing())), "/brief", tokens["brief"])
    assert (down.status_code, down.json()["error"]["code"]) == (502, "internal")


def test_ingest_takes_only_an_ingest_token(cfg: Config, minted: dict[str, Any]) -> None:
    client = TestClient(create_app(cfg, core_transport=core_refusing()))
    tokens, claims = minted["tokens"], minted["claims"]["ingest"]
    ok = post(client, "/ingest", tokens["ingest"])
    assert (ok.status_code, ok.json()) == (202, {"run_id": claims["run_id"]})
    for other in ("valid", "ask", "brief", "expired"):
        refused = post(client, "/ingest", tokens[other])
        assert (refused.status_code, refused.json()) == (401, UNAUTHENTICATED), other


def test_without_core_key_material_every_post_is_refused(tmp_path: Path, minted: dict[str, Any]) -> None:
    client = TestClient(create_app(load_config(env={"MUNIM_RUN_DIR": str(tmp_path)})))
    r = client.post("/watch:sweep", headers={"x-munim-service-secret": "", "authorization": f"Bearer {minted['tokens']['valid']}"})
    assert r.status_code == 503

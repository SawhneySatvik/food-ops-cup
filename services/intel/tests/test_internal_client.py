"""Internal client against a mock core: auth headers, typed bodies, retries only on the idempotent read."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from munim_intel.contracts_gen.models import InternalSnapshotsRequest, InternalWikiBatchRequest
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import CoreError, InternalClient

CTX = RunContext(
    "01920000-0000-7000-8000-00000000000a", "01920000-0000-7000-8000-000000000002", ("*",), "event", "watcher:x", 2_000_000_000, "h.p.s"
)
EVENT = "01920000-0000-7000-8000-0000000000e1"
ROLES = {
    "items": [
        {
            "role": "router",
            "provider": "gemini",
            "model_id": "gemini-3.5-flash-lite",
            "location": None,
            "input_price_per_mtok_minor": 2_700,
            "output_price_per_mtok_minor": 22_500,
            "price_currency": "INR",
            "probed_at": None,
            "updated_at": "2026-10-10T00:00:00Z",
        }
    ]
}


def core(responses: list[httpx.Response | Exception]) -> tuple[list[httpx.Request], Callable[[], InternalClient]]:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        r = responses[min(len(seen), len(responses)) - 1]
        if isinstance(r, Exception):
            raise r
        return r

    return seen, lambda: InternalClient(CTX, base_url="http://core.test", service_secret="s3cret", transport=httpx.MockTransport(handle))


def err(status: int, code: str, message: str = "core composed text", reason: str | None = None) -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": message, "reason_code": reason}})


def test_every_call_carries_the_run_token_and_the_service_secret_and_no_tenant() -> None:
    seen, client = core([httpx.Response(200, json={"event_id": EVENT, "claimed_at": "2026-10-10T10:00:00Z"})])
    claimed = asyncio.run(client().claim_event(EVENT))
    assert claimed is not None and claimed.event_id.root == EVENT
    (r,) = seen
    assert (r.method, r.url.path) == ("POST", "/internal/intel/v1/events:claim")
    assert r.headers["authorization"] == "Bearer h.p.s" and r.headers["x-munim-service-secret"] == "s3cret"
    assert json.loads(r.content) == {"event_id": EVENT}


def test_a_repeat_claim_is_none_not_an_error() -> None:
    _, client = core([err(409, "conflict")])
    assert asyncio.run(client().claim_event(EVENT)) is None


def test_writes_are_never_retried() -> None:
    seen, client = core([err(503, "unavailable"), err(503, "unavailable")])
    with pytest.raises(CoreError) as failed:
        asyncio.run(client().mint_snapshot(InternalSnapshotsRequest(template_id="finance.pnl", params={})))
    assert (len(seen), failed.value.status, failed.value.code) == (1, 503, "unavailable")


def test_the_model_role_read_is_retried_then_succeeds() -> None:
    seen, client = core([err(503, "unavailable"), httpx.ConnectError("refused"), httpx.Response(200, json=ROLES)])
    roles = asyncio.run(client().model_roles())
    assert (len(seen), roles.items[0].model_id) == (3, "gemini-3.5-flash-lite")
    assert seen[0].method == "GET"


def test_a_client_error_on_the_read_is_not_retried_and_exposes_codes_only() -> None:
    seen, client = core([err(403, "forbidden", message="untrusted text from core", reason="authority_denied")])
    with pytest.raises(CoreError) as failed:
        asyncio.run(client().model_roles())
    assert len(seen) == 1
    assert (failed.value.code, failed.value.reason_code) == ("forbidden", "authority_denied")
    assert "untrusted text" not in str(failed.value)


def test_brief_items_is_a_retried_get_and_write_wiki_a_never_retried_post() -> None:
    seen, client = core([err(503, "unavailable"), httpx.Response(200, json={"items": []})])
    got = asyncio.run(client().brief_items())
    assert (len(seen), got.items, seen[0].method, seen[0].url.path) == (2, [], "GET", "/internal/intel/v1/brief-items")
    page = "01920000-0000-7000-8000-000000000146"
    body: dict[str, Any] = {
        "pages": [
            {
                "page_id": page,
                "entity_id": None,
                "kind": "outlet",
                "slug": "main",
                "title": "Main",
                "version_id": page,
                "version": 1,
                "body": [],
            }
        ]
    }
    seen, client = core([err(503, "unavailable"), httpx.Response(201, json={"pages": []})])
    with pytest.raises(CoreError):
        asyncio.run(client().write_wiki(InternalWikiBatchRequest.model_validate(body)))
    assert (len(seen), seen[0].method, seen[0].url.path) == (1, "POST", "/internal/intel/v1/wiki:batch")
    seen, client = core([httpx.Response(201, json={"pages": [{"page_id": page, "version": 1, "status": "stored", "reason_code": None}]})])
    assert asyncio.run(client().write_wiki(InternalWikiBatchRequest.model_validate(body))).pages[0].status == "stored"

"""`InternalClient.write_quotes` reaches core-api's real route names with the run token (R25): quotes go to `quotes:batch` — the route
T-040b mounted — through the same client as every other internal write, and a refusal surfaces as CoreError."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from kit import INGREDIENT, OUTLET, SUPPLIER_IDS, TENANT
from munim_intel.contracts_gen.models import InternalQuotesBatchRequest
from munim_intel.negotiate.run import Core
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import SERVICE_SECRET_HEADER, CoreError, InternalClient

QUOTE = {
    "id": "0199a000-0000-7000-8000-00000000d001",
    "supplier_id": SUPPLIER_IDS["steady"],
    "ingredient_id": INGREDIENT,
    "round": 1,
    "qty_milli": 20_000,
    "unit": "pc",
    "unit_price_minor": 816,
    "currency": "INR",
    "min_order_qty_milli": 0,
    "payment_days": 15,
    "terms": {"simulated": True},
    "trace_event_id": None,
    "source_chunk_id": "0199a000-0000-7000-8000-00000000d002",
    "spans": {"unit_price_minor": [60, 64], "qty_milli": [42, 44], "min_order_qty_milli": None, "payment_days": [80, 82]},
}
CTX = RunContext("0199a000-0000-7000-8000-00000000e001", TENANT, (OUTLET,), "event", "watcher:inventory_purchasing", 2_000_000_000, "tok")


def _core(status: int, seen: list[httpx.Request]) -> Core:
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if status == 201:
            return httpx.Response(201, json={"inserted": 1, "existing": 0})
        return httpx.Response(status, json={"error": {"code": "invalid_payload", "message": "x", "reason_code": None}})

    return InternalClient(CTX, base_url="http://core.test", service_secret="s", transport=httpx.MockTransport(handler))


def test_quotes_go_to_quotes_batch_with_the_run_token() -> None:
    seen: list[httpx.Request] = []
    out = asyncio.run(_core(201, seen).write_quotes(InternalQuotesBatchRequest.model_validate({"quotes": [QUOTE]})))
    req = seen[0]
    assert req.url.path == "/internal/intel/v1/quotes:batch" and req.method == "POST"
    assert req.headers["authorization"] == "Bearer tok" and req.headers[SERVICE_SECRET_HEADER] == "s"
    assert json.loads(req.content)["quotes"][0]["unit_price_minor"] == 816 and out.inserted == 1


def test_a_refused_quote_raises() -> None:
    with pytest.raises(CoreError) as e:
        asyncio.run(_core(422, []).write_quotes(InternalQuotesBatchRequest.model_validate({"quotes": [QUOTE]})))
    assert e.value.status == 422

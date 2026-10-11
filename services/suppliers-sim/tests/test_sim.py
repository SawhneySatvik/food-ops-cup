"""suppliers-sim gates (T-055a): every card and reply carries "Simulated supplier" (count = the 3 cards of pack §6);
the card URL is the configured public URL, never a default (gotcha 6); prices follow the pack §6 personalities, worked
by hand below; the discounter's minimum order sits only in the terms sentence. In-process over A2A (ASGI transport)."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.helpers import get_message_text, new_data_message
from a2a.types.a2a_pb2 import Role, SendMessageRequest

from suppliers_sim.app import PublicUrlError, build_app

PUBLIC = "https://suppliers-sim.example.test"
LABEL = "Simulated supplier"
KEYS = ("steady", "discounter", "premium")  # pack §6, hand list
RFQ = {
    "kind": "rfq",
    "item": "Takeaway boxes",
    "unit": "pc",
    "qty_milli": 20_000,
    "reference_price_minor": 800,
    "currency": "INR",
    "minor_unit": 2,
    "needed_by": "2026-10-14",
}


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=PUBLIC)


async def _say(app: Any, key: str, msgs: list[dict[str, Any]]) -> list[str]:
    async with _client(app) as http:
        c = await A2ACardResolver(http, f"{PUBLIC}/{key}").get_agent_card()
        client = ClientFactory(ClientConfig(httpx_client=http, streaming=False)).create(c)
        out: list[str] = []
        for m in msgs:
            msg = new_data_message(m, role=Role.ROLE_USER, context_id="ctx-1")
            async for r in client.send_message(SendMessageRequest(message=msg)):
                out.append(get_message_text(r.message))
        return out


def test_every_card_is_labelled_and_public() -> None:
    app = build_app(PUBLIC)

    async def cards() -> list[Any]:
        async with _client(app) as http:
            return [await A2ACardResolver(http, f"{PUBLIC}/{k}").get_agent_card() for k in KEYS]

    got = asyncio.run(cards())
    labelled = [c for c in got if LABEL in c.name and LABEL in c.description and LABEL in c.skills[0].name]
    print(f"cards {len(got)}, labelled {len(labelled)}, urls {[c.supported_interfaces[0].url for c in got]}")
    assert len(got) == 3 and len(labelled) == 3
    assert [c.supported_interfaces[0].url for c in got] == [f"{PUBLIC}/{k}" for k in KEYS]
    assert not any("localhost" in c.supported_interfaces[0].url or "127.0.0.1" in c.supported_interfaces[0].url for c in got)


@pytest.mark.parametrize("url", [None, "", "ftp://x", "localhost:8000", "https://x.test/?q=1"])
def test_no_public_url_no_server(url: str | None) -> None:
    with pytest.raises(PublicUrlError):
        build_app(url)


def test_prices_follow_the_personalities() -> None:
    app = build_app(PUBLIC, clause=0)
    counter = {"kind": "counter", "unit_price_minor": 720}
    steady = asyncio.run(_say(app, "steady", [RFQ, counter, counter, {"kind": "accept"}]))
    disc = asyncio.run(_say(app, "discounter", [RFQ]))
    prem = asyncio.run(_say(app, "premium", [RFQ, counter, counter, {"kind": "walk"}]))
    replies = steady + disc + prem
    for r in replies:
        print(r)
    # Hand: 800 x 10200/10000 = 816; then 10050 bp = 804; then floor 9900 bp = 792.
    assert "INR 8.16 per pc" in steady[0] and "INR 8.04 per pc" in steady[1] and "INR 7.92 per pc" in steady[2]
    # 800 x 9000/10000 = 720, minimum order 3 x 20 = 60 pc, in the terms sentence only.
    assert "INR 7.20 per pc" in disc[0] and disc[0].endswith("Terms: minimum order 60 pc.")
    assert "60" not in disc[0].split("Payment:")[0]
    # 800 x 11200/10000 = 896; 11000 bp = 880; 10800 bp = 864.
    assert "INR 8.96" in prem[0] and "INR 8.80" in prem[1] and "INR 8.64" in prem[2]
    assert sum(LABEL in r for r in replies) == len(replies) == 9


def test_a_counter_above_the_concession_is_met_never_raised() -> None:
    app = build_app(PUBLIC)
    counters = [{"kind": "counter", "unit_price_minor": 890}, {"kind": "counter", "unit_price_minor": 999}]
    out = asyncio.run(_say(app, "premium", [RFQ, *counters]))
    # 896 → max(880, 890) = 890 → min(890, max(864, 999)) = 890 (never above the last offer).
    assert "INR 8.90" in out[1] and "INR 8.90" in out[2]


def test_ten_clause_phrasings_all_name_the_minimum() -> None:
    texts = [asyncio.run(_say(build_app(PUBLIC, clause=i), "discounter", [RFQ]))[0] for i in range(10)]
    assert len(set(texts)) == 10 and all("60 pc" in t for t in texts)

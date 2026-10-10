"""T-040b: the app's default Frame comes from core's `GET /internal/intel/v1/run-frame`, under the run's own token.

A body shaped as core serves it → a Frame with core's values (hand values below, the IN pack's ladder L and the
catalogue.md §4 cost_drift thresholds); anything else core may answer (a refusal, a non-JSON body, a missing key, a
narration mode outside the two) → None, so the run does nothing rather than guess (fail closed, rule 11).
"""

from __future__ import annotations

import asyncio
from datetime import date
from typing import Any

import httpx

from munim_intel.config import Config
from munim_intel.detect import Ladder, OutletFrame
from munim_intel.runtime.context import RunContext
from munim_intel.watch.frame import Frame, core_frame_source

OUTLET = "01920000-0000-7000-8000-00000000000a"
BODY: dict[str, Any] = {
    "pack": {"code": "IN", "version": 2},
    "currency": "INR",
    "severity_ladder": {"critical_minor_gte": 5_000_000, "high_minor_gte": 1_000_000, "medium_minor_gte": 200_000},
    "detectors": {"catalogue.cost_drift": {"thresholds": {"cost_change_bp_gte": 800, "cost_increase_minor_gte": 500}}},
    "outlets": [{"id": OUTLET, "name": "Outlet 1", "kind": "restaurant", "tz": "Asia/Kolkata", "business_date": "2026-10-11"}],
    "budget": None,
    "narration": "template",
}
RUN, TENANT = "01920000-0000-7000-8000-0000000000r1", "01920000-0000-7000-8000-0000000000t1"
CTX = RunContext(RUN, TENANT, ("*",), "watch_sweep", "watcher:sweep", 0, "tok.en.x")


def fetch(cfg: Config, answer: httpx.Response) -> tuple[Frame | None, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer

    return asyncio.run(core_frame_source(cfg, httpx.MockTransport(handler))(CTX)), seen


def test_a_served_frame_becomes_the_runs_frame_under_the_runs_token(cfg: Config) -> None:
    frame, seen = fetch(cfg, httpx.Response(200, json=BODY))
    assert frame == Frame(
        pack_code="IN",
        currency="INR",
        ladder=Ladder(5_000_000, 1_000_000, 200_000),
        detectors={"catalogue.cost_drift": {"cost_change_bp_gte": 800, "cost_increase_minor_gte": 500}},
        outlets=(OutletFrame(OUTLET, "restaurant", date(2026, 10, 11)),),
        narration="template",
    )
    assert [(r.method, r.url.path, r.headers["authorization"]) for r in seen] == [
        ("GET", "/internal/intel/v1/run-frame", "Bearer tok.en.x")
    ]
    assert seen[0].headers["x-munim-service-secret"] == cfg.service_secret()


def test_anything_else_core_answers_is_no_frame(cfg: Config) -> None:
    bad = [
        httpx.Response(503, json={"error": {"code": "unavailable"}}),
        httpx.Response(404, json={"error": {"code": "not_found"}}),
        httpx.Response(200, content=b"<html>"),
        httpx.Response(200, json={k: v for k, v in BODY.items() if k != "severity_ladder"}),
        httpx.Response(200, json={**BODY, "narration": "freeform"}),
        httpx.Response(200, json={**BODY, "outlets": [{"id": OUTLET, "kind": "restaurant", "business_date": "not a date"}]}),
    ]
    assert [fetch(cfg, r)[0] for r in bad] == [None] * len(bad)

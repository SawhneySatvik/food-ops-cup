"""Shared by the catalogue (T-044) and market (T-051) pack gates.

Offline: `FakeCore` serves fixture rows per template as core's internal API would (the system boundary; the real one
is in the *_e2e modules) and records every write. End to end: `Sweeper` runs one pack's detectors through intel's
real WatchRun against the real core-api on embedded Postgres, the four worldgen worlds seeded through the API in the
100-day gate profile (as of 2026-10-10) — T-043's core_stack.mts, driven through tests/watch/stack.py.

Expected values in the gates come from the hand-kept answer keys (tools/worldgen/answer-key/*.json, detector-map.json),
the pack docs' §4 thresholds, or hand arithmetic written beside them — never from the code under test.
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from conftest import REPO
from munim_intel.config import Config, load_config
from munim_intel.contracts_gen.models import (
    InternalDraftsRequest,
    InternalDraftsResponse,
    InternalEventsClaimResponse,
    InternalFindingsRequest,
    InternalFindingsResponse,
    InternalSnapshotsRequest,
    InternalTracesBatchRequest,
    InternalTracesBatchResponse,
    InternalWatchClaimResponse,
    Snapshot,
)
from munim_intel.detect import DetectorSpec
from munim_intel.runtime.context import RunContext, load_public_key, verify_run_token
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.watch.frame import Frame, frame_from_pack
from munim_intel.watch.pipeline import Report, WatchRun

sys.path.insert(0, str(REPO / "services" / "intel" / "tests" / "watch"))
from stack import Bridge as Bridge  # noqa: E402  (T-043's stack client, shared — not copied)
from stack import Stack as Stack  # noqa: E402

RUN = "01920000-0000-7000-8000-0000000044a1"
TENANT = "01920000-0000-7000-8000-0000000044b1"
OUTLET = "01920000-0000-7000-8000-0000000044c1"
CTX = RunContext(RUN, TENANT, ("*",), "watch_sweep", "watcher:sweep", 2_000_000_000, "h.p.s")
CFG = load_config(env={}, run_dir=Path("/nonexistent"))
#: The gate profile's business date (tools/worldgen/test/profile.ts; core_stack.mts pins the run-frame to it).
AS_OF = date(2026, 10, 10)
WORLDS = ["store", "restaurant_group", "cloud_kitchen", "au_outlet"]
WORLD_OF_PREFIX = {"RG": "restaurant_group", "CK": "cloud_kitchen", "ST": "store", "AU": "au_outlet"}
TEXT_COLUMNS = {"label", "kind", "class", "unit", "tax_class", "channel_kind"}


def column_type(name: str) -> str:
    if name.endswith("_id"):
        return "uuid"
    if name == "on_date":
        return "date"
    return "text" if name in TEXT_COLUMNS else "integer"


class FakeCore:
    """Serves each template's fixture rows as a snapshot and records every write, as core's internal API answers."""

    def __init__(self, rows: dict[str, list[dict[str, Any]]]) -> None:
        self.rows = rows
        self.minted: list[InternalSnapshotsRequest] = []
        self.findings: list[InternalFindingsRequest] = []
        self.drafts: list[InternalDraftsRequest] = []
        self.traces: list[dict[str, Any]] = []

    async def claim_event(self, event_id: str) -> InternalEventsClaimResponse | None:
        return InternalEventsClaimResponse.model_validate({"event_id": event_id, "claimed_at": "2026-10-10T10:00:00Z"})

    async def claim_watch(self, pack: str) -> InternalWatchClaimResponse:
        return InternalWatchClaimResponse(pack=pack, go=True, last_run_at=None)

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        self.minted.append(req)
        rows = self.rows.get(req.template_id, [])
        cols = sorted({k for r in rows for k in r})
        return Snapshot.model_validate(
            {
                "snapshot_id": f"01920000-0000-7000-8000-{len(self.minted):012x}",
                "template_id": req.template_id,
                "params": req.model_dump(mode="json")["params"],
                "run_id": RUN,
                "minted_by_member_id": None,
                "minted_by_operator_id": None,
                "outlet_scope": ["*"],
                "columns": [{"name": c, "type": column_type(c)} for c in cols],
                "rows": rows,
                "row_count": len(rows),
                "sha256": "0" * 64,
                "created_at": "2026-10-10T10:00:00Z",
            }
        )

    async def write_finding(self, req: InternalFindingsRequest) -> InternalFindingsResponse:
        self.findings.append(req)
        return InternalFindingsResponse.model_validate(
            {"finding_id": req.envelope.finding_id.root, "outcome": "stored", "reason_code": None}
        )

    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse:
        self.drafts.append(req)
        return InternalDraftsResponse.model_validate({"draft_id": req.draft_id.root, "status": "proposed", "reason_code": None})

    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse:
        self.traces += [e.model_dump(mode="json") for e in req.events]
        return InternalTracesBatchResponse(inserted=len(req.events), last_seq=len(self.traces))


def pack_doc(code: str) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((REPO / "packages" / "contracts" / "packs" / f"{code}.json").read_text("utf8"))
    return doc


def frame(code: str, kind: str = "restaurant", business_date: date = AS_OF) -> Frame:
    return frame_from_pack(pack_doc(code), [{"id": OUTLET, "kind": kind, "business_date": business_date.isoformat()}], "template")


def run(core: FakeCore, f: Frame, pack: str, specs: list[DetectorSpec]) -> Report:
    return asyncio.run(WatchRun(CTX, core, f, CFG).run({pack: specs}))


def answer_key(world: str) -> dict[str, Any]:
    key: dict[str, Any] = json.loads((REPO / "tools" / "worldgen" / "answer-key" / f"{world}.json").read_text("utf8"))
    return key


def detector_map() -> dict[str, Any]:
    m: dict[str, Any] = json.loads((REPO / "tools" / "worldgen" / "answer-key" / "detector-map.json").read_text("utf8"))
    return m


FINDINGS = """SELECT f.tenant_id::text, f.id::text, f.pack, f.type, f.severity, f.dedupe_key, f.confidence_bp, f.envelope,
                     (s.rows -> f.impact_row ->> f.impact_column)::bigint AS impact
                FROM intel.finding f JOIN evidence.snapshot s ON s.tenant_id = f.tenant_id AND s.id = f.impact_snapshot_id
               WHERE f.pack = $1 ORDER BY f.tenant_id, f.dedupe_key"""


class Sweeper:
    """One pack's detectors through WatchRun against the real core-api (run token, run-frame, internal API)."""

    def __init__(self, stack: Stack, run_dir: Path) -> None:
        self.stack = stack
        (run_dir / "keys").mkdir(parents=True, exist_ok=True)
        (run_dir / "keys" / "run-token-ed25519.pub.pem").write_text(stack.ready["public_key_pem"])
        (run_dir / "service-secret").write_text(stack.ready["secret"] + "\n")
        self.cfg: Config = load_config(env={"MUNIM_RUN_DIR": str(run_dir)})

    def sweep(self, world: str, pack: str, specs: list[DetectorSpec]) -> Report:
        t = self.stack.call("token", world=world, trigger="watch_sweep", scope=["*"])
        ctx = verify_run_token(t["token"], load_public_key(self.cfg.run_token_public_key_pem()))

        async def go() -> Report:
            client = InternalClient(ctx, base_url=self.cfg.core_url, service_secret=self.cfg.service_secret(), transport=Bridge(self.stack))
            try:
                return await WatchRun(ctx, client, self.stack.frame(world, "template"), self.cfg).run({pack: specs})
            finally:
                await client.aclose()

        return asyncio.run(go())

    def findings(self, pack: str) -> list[dict[str, Any]]:
        return self.stack.sql(FINDINGS, pack)

    def id(self, world: str, key: str) -> str:
        return str(self.stack.call("id", world=world, key=key))

    def items_using(self, world: str, outlet: str, ingredient: str) -> set[str]:
        """Items whose recipe has a line of the ingredient (the rows a waste plant legitimately lifts)."""
        rows = self.stack.sql(
            """SELECT DISTINCT r.item_id::text AS item FROM core.recipe_version r
                 JOIN core.recipe_line l ON l.tenant_id = r.tenant_id AND l.recipe_version_id = r.id
                WHERE r.tenant_id = $1 AND l.ingredient_id = $2""",
            self.stack.tenants[world],
            self.id(world, ingredient),
        )
        return {f"{outlet}:{r['item']}" for r in rows}

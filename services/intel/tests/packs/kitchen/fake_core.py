"""An in-memory core for the pack lanes' offline gates (the internal API is the system boundary; the real one is in the
e2e gates). `serve(template_id, params) -> rows` decides what each mint returns; every write is recorded."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from conftest import REPO
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
from munim_intel.runtime.context import RunContext
from munim_intel.watch.frame import Frame, frame_from_pack

RUN = "01920000-0000-7000-8000-0000000046a1"
TENANT = "01920000-0000-7000-8000-0000000046b1"
OUTLET = "01920000-0000-7000-8000-0000000046c1"
CTX = RunContext(RUN, TENANT, ("*",), "watch_sweep", "watcher:sweep", 2_000_000_000, "h.p.s")

Serve = Callable[[str, dict[str, Any]], list[dict[str, Any]]]


class FakeCore:
    def __init__(self, serve: Serve) -> None:
        self.serve = serve
        self.minted: list[tuple[str, dict[str, Any], str]] = []
        self.findings: list[InternalFindingsRequest] = []
        self.drafts: list[InternalDraftsRequest] = []
        self.traces: list[dict[str, Any]] = []

    async def claim_event(self, event_id: str) -> InternalEventsClaimResponse | None:
        return InternalEventsClaimResponse.model_validate({"event_id": event_id, "claimed_at": "2026-10-10T10:00:00Z"})

    async def claim_watch(self, pack: str) -> InternalWatchClaimResponse:
        return InternalWatchClaimResponse(pack=pack, go=True, last_run_at=None)

    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot:
        params = req.model_dump(mode="json")["params"]
        rows = self.serve(req.template_id, params)
        sid = f"01920000-0000-7000-8000-{len(self.minted) + 1:012x}"
        self.minted.append((req.template_id, params, sid))
        cols = sorted({k for r in rows for k in r})
        return Snapshot.model_validate(
            {
                "snapshot_id": sid,
                "template_id": req.template_id,
                "params": params,
                "run_id": RUN,
                "minted_by_member_id": None,
                "minted_by_operator_id": None,
                "outlet_scope": ["*"],
                "columns": [{"name": c, "type": "uuid" if c.endswith("_id") else "text" if c in TEXT else "integer"} for c in cols],
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

    def finding_rows(self) -> list[dict[str, Any]]:
        """Each finding with its impact cell's row index and column, parsed from the canonical ref."""
        out = []
        for f in self.findings:
            body = f.model_dump(mode="json")
            ref = body["envelope"]["impact_ref"]
            sid, row, col = ref[len("⟨snap:") : -1].split("·")
            out.append({**body, "impact_snapshot": sid, "impact_row": int(row), "impact_column": col})
        return out


TEXT = {"station", "slot_start", "iso_week", "business_on", "weekday"}


def pack(code: str) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((REPO / "packages" / "contracts" / "packs" / f"{code}.json").read_text("utf8"))
    return doc


def frame(code: str, kind: str = "restaurant", outlet: str = OUTLET) -> Frame:
    return frame_from_pack(pack(code), [{"id": outlet, "kind": kind, "business_date": "2026-10-10"}], "template")

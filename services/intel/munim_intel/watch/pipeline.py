"""The watcher pipeline (ADR-014 §3.3): `watch:claim` → detectors (template + threshold) → finding → DraftMapping.
No model call except narration of a `high`/`critical` finding when the Frame allows it.

One WatchRun per run token. It owns the run's RunState (traces, budget, actor labels) and the run's one HandleTable
(on `RunState.handles`), and flushes its traces before it returns, failed or not.

Per outlet (note a from T-040): a detector mints its template once per outlet in the run's scope, with that
`outlet_id` as a param, and the outlet is part of the dedupe key — so a `*` sweep yields one finding per outlet,
never a tenant-wide one. Core stamps the finding's `outlet_ids` (T-040 stores the run's scope; the request to derive
it from the impact snapshot's outlet is in the T-043 report).

Ids (§5.5): a finding id is fresh per run (sha256 of run id ‖ dedupe key), because core returns an existing id's
stored row before it merges; a re-detection in a later run is a new id that core merges into the open finding of the
same dedupe key and answers with that finding's id. Every later step uses the id core returned.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx
from google.adk.models import BaseLlm
from pydantic import ValidationError

from munim_intel.config import Config
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
from munim_intel.detect import REGISTRY, DetectorSpec, OutletFrame, Severity, Window
from munim_intel.mapping import Detection, DraftMapping, draft_body, snap_ref
from munim_intel.narrate import NARRATE_AT, model_segments, template_segments
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import CoreError
from munim_intel.runtime.runner import RunFailed
from munim_intel.runtime.state import Budget, RunState
from munim_intel.tools.generated import run_start_ms, uuid7
from munim_intel.tools.handles import HandleTable
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.watch.frame import Frame

log = logging.getLogger("munim_intel.watch")

#: ADR-014 §3.4 "narrate": ≤ 8k input a call, 1 call (+1 grammar retry). A watcher run narrates at most this many
#: findings; the "≤ 10 per tenant per day" cap needs a core-side count (reported, not built here).
MAX_NARRATIONS = 10


class Core(Protocol):
    """The internal API calls a watcher makes (InternalClient implements it)."""

    async def claim_event(self, event_id: str) -> InternalEventsClaimResponse | None: ...
    async def claim_watch(self, pack: str) -> InternalWatchClaimResponse: ...
    async def mint_snapshot(self, req: InternalSnapshotsRequest) -> Snapshot: ...
    async def write_finding(self, req: InternalFindingsRequest) -> InternalFindingsResponse: ...
    async def write_draft(self, req: InternalDraftsRequest) -> InternalDraftsResponse: ...
    async def write_traces(self, req: InternalTracesBatchRequest) -> InternalTracesBatchResponse: ...


@dataclass
class Report:
    """Counts only (ids and labels never leave as prose)."""

    packs: dict[str, str] = field(default_factory=dict)
    snapshots: int = 0
    findings: Counter[str] = field(default_factory=Counter)
    narrations: Counter[str] = field(default_factory=Counter)
    drafts: Counter[str] = field(default_factory=Counter)
    errors: int = 0

    def as_json(self) -> dict[str, Any]:
        return {
            "packs": dict(self.packs),
            "snapshots": self.snapshots,
            "findings": dict(self.findings),
            "narrations": dict(self.narrations),
            "drafts": dict(self.drafts),
            "errors": self.errors,
        }


class WatchRun:
    def __init__(self, ctx: RunContext, core: Core, frame: Frame, cfg: Config, *, llm: BaseLlm | None = None) -> None:
        self.ctx = ctx
        self.core = core
        self.frame = frame
        self.cfg = cfg
        #: The narrate-role model; None → template narration only (and then 0 model calls).
        self.llm = llm if frame.narration == "model" else None
        self.state = RunState(
            traces=TraceBuffer(core.write_traces),
            budget=Budget(max_model_calls=MAX_NARRATIONS, max_input_tokens=MAX_NARRATIONS * 8_000, max_tool_calls=0),
        )
        self.handles = HandleTable(self.state.handles)
        self.report = Report()

    async def trace(self, kind: str, pack: str, payload: dict[str, str | list[str]]) -> None:
        await self.state.traces.append(kind, f"watcher:{pack}", payload)

    async def run(self, packs: dict[str, list[DetectorSpec]]) -> Report:
        """Runs each pack's detectors whose `watch:claim` says go. Traces are flushed before this returns."""
        try:
            for pack, specs in packs.items():
                claim = await self.core.claim_watch(pack)
                if not claim.go:
                    self.report.packs[pack] = "debounced"
                    continue
                self.report.packs[pack] = "ran"
                for spec in specs:
                    await self._detector(spec)
        finally:
            try:
                await self.state.traces.flush()
            except (CoreError, httpx.HTTPError) as e:
                log.error("intel: watch run %s could not flush traces: %s", self.ctx.run_id, type(e).__name__)
        return self.report

    async def _detector(self, spec: DetectorSpec) -> None:
        thresholds = self.frame.detectors.get(spec.id)
        if thresholds is None:
            # The tenant's pack has no thresholds for it: nothing to compare against, so it does not run.
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": "no_pack_thresholds"})
            return
        for outlet in self.frame.in_scope(self.ctx):
            if outlet.kind not in spec.outlet_kinds:
                continue
            for window in spec.windows(outlet, thresholds):
                try:
                    snap = await self.core.mint_snapshot(
                        InternalSnapshotsRequest.model_validate({"template_id": spec.template, "params": window.params})
                    )
                except (CoreError, httpx.HTTPError) as e:
                    self.report.errors += 1
                    await self.trace("error", spec.pack, {"where": "mint", "detector": spec.id, "error": _label(e)})
                    continue
                self.report.snapshots += 1
                body = snap.model_dump(mode="json")
                for i, row in enumerate(body["rows"]):
                    if spec.fires(row, thresholds):
                        await self._finding(spec, thresholds, outlet, window, body, i)

    async def _finding(
        self, spec: DetectorSpec, thresholds: Any, outlet: OutletFrame, window: Window, snap: dict[str, Any], i: int
    ) -> None:
        row = snap["rows"][i]
        sid = snap["snapshot_id"]
        dedupe = f"{spec.id}:{spec.dedupe(row, window)}"
        severity = spec.severity(row, thresholds, self.frame.ladder)
        base = {
            "pack": spec.pack,
            "type": spec.finding_type,
            "severity": severity,
            "confidence_bp": spec.confidence_bp(row),
            "dedupe_key": dedupe,
        }
        envelope = {"segments": template_segments(spec, sid, i), "impact_ref": snap_ref(sid, i, spec.impact_column), "abstained": False}
        fid = uuid7(run_start_ms(self.ctx.run_id), f"{self.ctx.run_id}\0{dedupe}")
        res = await self._post_finding({**base, "envelope": {"finding_id": fid, **envelope}}, spec)
        if res is None:
            return
        self.report.findings[res.outcome] += 1
        await self.trace("finding", spec.pack, {"detector": spec.id, "finding_id": res.finding_id.root, "outcome": res.outcome})
        if res.outcome == "abstained":
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": res.reason_code.root if res.reason_code else "unknown"})
            return
        finding_id = res.finding_id.root
        if self.llm is not None and severity in NARRATE_AT and res.outcome == "stored":
            await self._narrate(self.llm, spec, severity, snap, i, base, envelope, dedupe)
        if spec.mapping is not None:
            await self._draft(spec, spec.mapping, Detection(sid, i, row, outlet, self.frame.currency), finding_id)

    async def _post_finding(self, body: dict[str, Any], spec: DetectorSpec) -> InternalFindingsResponse | None:
        try:
            return await self.core.write_finding(InternalFindingsRequest.model_validate(body))
        except (CoreError, httpx.HTTPError) as e:
            # e.g. 409: the open finding of this key sits in an outlet this run cannot see.
            self.report.errors += 1
            await self.trace("error", spec.pack, {"where": "finding", "detector": spec.id, "error": _label(e)})
            return None

    async def _narrate(
        self,
        llm: BaseLlm,
        spec: DetectorSpec,
        severity: Severity,
        snap: dict[str, Any],
        i: int,
        base: dict[str, Any],
        envelope: dict[str, Any],
        dedupe: str,
    ) -> None:
        """Model prose for a stored finding, merged into it by a second post under the same dedupe key. Core keeps the
        template when it refuses the prose (a failed re-detection never overwrites a valid open finding)."""
        if self.state.budget.models_exhausted():
            self.report.narrations["budget"] += 1
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": "ai_budget_cap"})
            return
        try:
            segments = await model_segments(
                spec, severity, snap, i, llm=llm, ctx=self.ctx, cfg=self.cfg, state=self.state, handles=self.handles
            )
        except RunFailed as e:
            self.report.narrations["failed"] += 1
            await self.trace("error", spec.pack, {"where": "narrate", "detector": spec.id, "error": e.kind})
            return
        if segments is None:
            self.report.narrations["empty"] += 1
            return
        nid = uuid7(run_start_ms(self.ctx.run_id), f"{self.ctx.run_id}\0{dedupe}\0narration")
        res = await self._post_finding({**base, "envelope": {**envelope, "finding_id": nid, "segments": segments}}, spec)
        if res is None:
            return
        outcome = "narrated" if res.outcome == "merged" else res.outcome
        self.report.narrations[outcome] += 1
        if res.outcome == "abstained":
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": res.reason_code.root if res.reason_code else "unknown"})

    async def _draft(self, spec: DetectorSpec, mapping: DraftMapping, d: Detection, finding_id: str) -> None:
        proposal = mapping(d)
        if proposal is None:
            return
        try:
            req = InternalDraftsRequest.model_validate(draft_body(spec.pack, finding_id, d, proposal))
        except ValidationError:
            self.report.errors += 1
            await self.trace("error", spec.pack, {"where": "mapping", "detector": spec.id, "error": "invalid_proposal"})
            return
        try:
            res = await self.core.write_draft(req)
        except CoreError as e:
            if e.status == 409:
                # The same draft id with newer refs: this finding's draft is already recorded (re-detection).
                self.report.drafts["recorded"] += 1
                await self.trace(
                    "draft", spec.pack, {"command_type": proposal.command_type, "draft_id": req.draft_id.root, "status": "recorded"}
                )
                return
            self.report.errors += 1
            await self.trace("error", spec.pack, {"where": "draft", "detector": spec.id, "error": _label(e)})
            return
        except httpx.HTTPError as e:
            self.report.errors += 1
            await self.trace("error", spec.pack, {"where": "draft", "detector": spec.id, "error": _label(e)})
            return
        self.report.drafts[res.status] += 1
        await self.trace("draft", spec.pack, {"command_type": proposal.command_type, "draft_id": res.draft_id.root, "status": res.status})
        if res.status == "abstained":
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": res.reason_code.root if res.reason_code else "unknown"})


def _label(e: Exception) -> str:
    if isinstance(e, CoreError):
        return f"core_{e.status}_{e.reason_code or e.code}"
    return type(e).__name__


def detectors_for(event_type: str | None) -> dict[str, list[DetectorSpec]]:
    """pack -> its detectors: all of them for a sweep (None), only those watching the type for an event."""
    import munim_intel.watch.detectors  # noqa: F401  (registers the detectors)

    out: dict[str, list[DetectorSpec]] = {}
    for pack, specs in REGISTRY.items():
        chosen = [s for s in specs if event_type is None or event_type in s.watches]
        if chosen:
            out[pack] = chosen
    return out

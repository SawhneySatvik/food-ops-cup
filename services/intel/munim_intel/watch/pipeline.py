"""The watcher pipeline (ADR-014 §3.3): `watch:claim` → detectors (template + threshold) → finding → DraftMapping.
No model call except narration of a `high`/`critical` finding when the Frame allows it.

One WatchRun per run token. It owns the run's RunState (traces, budget, actor labels) and the run's one HandleTable
(on `RunState.handles`), and flushes its traces before it returns, failed or not.

Per outlet (note a from T-040): a detector mints its template once per outlet in the run's scope, with that
`outlet_id` as a param, and the outlet is part of the dedupe key — so a `*` sweep yields one finding per outlet,
never a tenant-wide one. Core stamps the finding's `outlet_ids` (T-040 stores the run's scope; the request to derive
it from the impact snapshot's outlet is in the T-043 report).

W3.2 hooks: a detector may enumerate its windows from a list template (`DetectorSpec.driver`: one window per listed
uuid); its mapping reads the window params, every row of the snapshot and the stored finding's id (`Detection`), plus
follow-up snapshots minted after the finding (`DetectorSpec.follow_ups`); a mapping may refuse with a contracts reason
code (`Abstain`, traced by code); a finding the contract refuses is traced `invalid_finding` and the run goes on.

Containment (R-B S2-A): a detector, window, finding or mapping that raises is traced `detector_error` with the
exception's type name only (never its message) and the sweep goes on with the next one; a `TraceLabelError` still ends
the run (it exists to fail a run rather than ship text). A pack whose `detectors.<id>.thresholds` lacks a key the
detector declares abstains that detector with `no_pack_thresholds` before anything is minted.

Tenant-level detectors (`DetectorSpec.tenant_level`, R-B S2-C) mint once per run, with the in-scope outlet whose
business date is latest (the first such in frame order), only in a run over every outlet (`not_applicable` otherwise:
core refuses a tenant-wide draft from a scoped run); their drafts are tenant-wide (`outlet_ids` []).

Ids (§5.5): a finding id is fresh per run (sha256 of run id ‖ dedupe key), because core returns an existing id's
stored row before it merges; a re-detection in a later run is a new id that core merges into the open finding of the
same dedupe key and answers with that finding's id. Every later step uses the id core returned.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field, replace
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
    ReasonCode,
    Snapshot,
)
from munim_intel.detect import REGISTRY, DetectorSpec, Driver, Hit, OutletFrame, Severity, Thresholds, Window
from munim_intel.llm import over_cap
from munim_intel.mapping import Abstain, Detection, DraftMapping, Minted, draft_body, snap_ref
from munim_intel.narrate import NARRATE_AT, model_segments, template_segments
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import CoreError
from munim_intel.runtime.runner import RunFailed
from munim_intel.runtime.state import Budget, RunState
from munim_intel.tools.generated import run_start_ms, uuid7
from munim_intel.tools.handles import HandleTable
from munim_intel.trace.buffer import TraceBuffer, TraceLabelError, error_label, label_of
from munim_intel.trace.spend import Meter
from munim_intel.watch.frame import Frame

log = logging.getLogger("munim_intel.watch")

#: ADR-014 §3.4 "narrate": ≤ 8k input a call, 1 call (+1 grammar retry). A watcher run narrates at most this many
#: findings; the "≤ 10 per tenant per day" cap needs a core-side count (reported, not built here).
MAX_NARRATIONS = 10

#: core's snapshot row cap (02-schema "minting": caps 500 rows; `runTemplate`'s LIMIT). Core does not say when it cut a
#: snapshot, so a snapshot AT the cap may be missing its last rows — and templates put Σ rows first and order by day, so
#: the cut drops the newest days. A detector never judges part of a window: it abstains `row_cap` (traced, no finding).
#: Stopgap until core marks truncation itself.
ROW_CAP = 500

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


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
    def __init__(
        self, ctx: RunContext, core: Core, frame: Frame, cfg: Config, *, llm: BaseLlm | None = None, meter: Meter | None = None
    ) -> None:
        self.ctx = ctx
        self.core = core
        self.frame = frame
        self.cfg = cfg
        #: The narrate-role model; None → template narration only (and then 0 model calls). Over the month's AI cap with AI on (live)
        #: it is the capped model app.watch built: each call served from its recorded fixture or abstaining (T-127).
        self.llm = llm if frame.narration == "model" or over_cap(cfg, frame.ai_enabled, frame.budget_level) else None
        self.state = RunState(
            traces=TraceBuffer(core.write_traces),
            budget=Budget(max_model_calls=MAX_NARRATIONS, max_input_tokens=MAX_NARRATIONS * 8_000, max_tool_calls=0),
            # Where the narrations' model calls are charged (W3 close ruling); the caller builds it with the model.
            meter=meter,
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
                    try:
                        await self._detector(spec)
                    except TraceLabelError:
                        raise
                    except Exception as e:  # noqa: BLE001 — one detector's defect never ends the sweep (S2-A)
                        await self._failed(spec, "detector", e)
        finally:
            try:
                await self.state.traces.flush()
            except (CoreError, httpx.HTTPError) as e:
                log.error("intel: watch run %s could not flush traces: %s", self.ctx.run_id, type(e).__name__)
        return self.report

    async def _failed(self, spec: DetectorSpec, where: str, e: Exception) -> None:
        self.report.errors += 1
        await self.trace("error", spec.pack, {"where": where, "detector": spec.id, "error": "detector_error", "type": error_label(e)})

    async def _detector(self, spec: DetectorSpec) -> None:
        pack_thresholds = self.frame.detectors.get(spec.id)
        if pack_thresholds is None or any(k not in pack_thresholds for k in spec.thresholds):
            # The tenant's pack lacks a threshold it reads: nothing to compare against, so it does not run.
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": "no_pack_thresholds"})
            return
        thresholds = {k: pack_thresholds[k] for k in spec.thresholds}
        outlets = [o for o in self.frame.in_scope(self.ctx) if o.kind in spec.outlet_kinds]
        if spec.tenant_level:
            if self.ctx.outlet_scope != ("*",):
                await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": "not_applicable"})
                return
            outlets = [max(outlets, key=lambda o: o.business_date)] if outlets else []
        for outlet in outlets:
            try:
                windows = list(spec.windows(outlet, thresholds))
                if spec.driver is not None:
                    windows += await self._enumerate(spec, spec.driver, outlet, thresholds)
            except TraceLabelError:
                raise
            except Exception as e:  # noqa: BLE001
                await self._failed(spec, "windows", e)
                continue
            for window in windows:
                try:
                    body = await self._mint(spec, "mint", spec.template, window.params)
                    if body is None:
                        continue
                    if body["row_count"] >= ROW_CAP:
                        await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": "row_cap"})
                        continue
                    hits = spec.hits(body["rows"], window, thresholds, self.frame.ladder, outlet)
                except TraceLabelError:
                    raise
                except Exception as e:  # noqa: BLE001
                    await self._failed(spec, "hits", e)
                    continue
                for hit in hits:
                    try:
                        await self._finding(spec, outlet, window, body, hit, thresholds)
                    except TraceLabelError:
                        raise
                    except Exception as e:  # noqa: BLE001
                        await self._failed(spec, "finding", e)

    async def _mint(self, spec: DetectorSpec, where: str, template: str, params: dict[str, Any]) -> dict[str, Any] | None:
        try:
            snap = await self.core.mint_snapshot(InternalSnapshotsRequest.model_validate({"template_id": template, "params": params}))
        except (CoreError, httpx.HTTPError) as e:
            self.report.errors += 1
            await self.trace("error", spec.pack, {"where": where, "detector": spec.id, "error": _label(e)})
            return None
        self.report.snapshots += 1
        body: dict[str, Any] = snap.model_dump(mode="json")
        return body

    async def _enumerate(self, spec: DetectorSpec, driver: Driver, outlet: OutletFrame, thresholds: Thresholds) -> list[Window]:
        """One window per distinct uuid the driver template lists for this outlet, in row order."""
        body = await self._mint(spec, "driver", driver.template, driver.params(outlet, thresholds))
        if body is None:
            return []
        ids: list[str] = []
        for row in body["rows"]:
            v = row.get(driver.id_column)
            if isinstance(v, str) and _UUID.fullmatch(v) and v not in ids:
                ids.append(v)
        return [driver.window(i, outlet, thresholds) for i in ids]

    async def _finding(
        self, spec: DetectorSpec, outlet: OutletFrame, window: Window, snap: dict[str, Any], hit: Hit, thresholds: Thresholds
    ) -> None:
        i = hit.row
        row = snap["rows"][i]
        sid = snap["snapshot_id"]
        dedupe = f"{spec.id}:{hit.key if hit.key is not None else spec.dedupe(row, window)}"
        severity = hit.severity
        base = {
            "pack": spec.pack,
            "type": spec.finding_type,
            "severity": severity,
            "confidence_bp": spec.confidence_bp(row),
            "dedupe_key": dedupe,
        }
        one = spec.finding_outlet(row, window) if spec.finding_outlet is not None else None
        envelope = {
            "segments": template_segments(spec, sid, i, hit.impact_row, spec.narration_of(row)),
            "impact_ref": snap_ref(sid, hit.impact_row, spec.impact_column),
            "abstained": False,
        }
        fid = uuid7(run_start_ms(self.ctx.run_id), f"{self.ctx.run_id}\0{dedupe}")
        named = {"outlet_ids": [one]} if one else {}
        res = await self._post_finding({**base, "envelope": {"finding_id": fid, **envelope}, **named}, spec)
        if res is None:
            return
        self.report.findings[res.outcome] += 1
        await self.trace("finding", spec.pack, {"detector": spec.id, "finding_id": res.finding_id.root, "outcome": res.outcome})
        if res.outcome == "abstained":
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": res.reason_code.root if res.reason_code else "unknown"})
            return
        finding_id = res.finding_id.root
        if self.llm is not None and severity in NARRATE_AT and res.outcome == "stored":
            await self._narrate(self.llm, spec, severity, snap, hit, base, envelope, dedupe)
        if spec.mapping is not None:
            d = Detection(sid, i, row, outlet, self.frame.currency, dict(window.params), snap["rows"], finding_id, thresholds=thresholds)
            try:
                follow = await self._follow_ups(spec, d)
                if follow is not None:
                    await self._draft(spec, spec.mapping, replace(d, follow=follow), finding_id)
            except TraceLabelError:
                raise
            except Exception as e:  # noqa: BLE001 — a mapping's defect costs its draft, never the finding or the sweep
                await self._failed(spec, "mapping", e)

    async def _follow_ups(self, spec: DetectorSpec, d: Detection) -> dict[str, Minted] | None:
        """The mapping's extra snapshots by name; None when one could not be minted (no draft: a mapping never guesses
        a cell it was promised)."""
        out: dict[str, Minted] = {}
        for f in spec.follow_ups:
            # A later follow-up reads the earlier ones (cares.pickup_crew needs the listing cares.listings named).
            params = f.params(replace(d, follow=dict(out)))
            if params is None:
                continue
            body = await self._mint(spec, "follow_up", f.template, params)
            if body is None:
                return None
            out[f.name] = Minted(body["snapshot_id"], body["rows"])
        return out

    async def _post_finding(self, body: dict[str, Any], spec: DetectorSpec) -> InternalFindingsResponse | None:
        try:
            req = InternalFindingsRequest.model_validate(body)
        except ValidationError:
            # A detector built a finding the contract refuses (e.g. a dedupe key outside its pattern): that finding is
            # lost and traced by label — pydantic's message echoes the input, so it never reaches the trace.
            self.report.errors += 1
            await self.trace("error", spec.pack, {"where": "finding", "detector": spec.id, "error": "invalid_finding"})
            return None
        try:
            return await self.core.write_finding(req)
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
        hit: Hit,
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
                spec, severity, snap, hit.row, hit.impact_row, llm=llm, ctx=self.ctx, cfg=self.cfg, state=self.state, handles=self.handles
            )
        except RunFailed as e:
            self.report.narrations["failed"] += 1
            await self.trace("error", spec.pack, {"where": "narrate", "detector": spec.id, "error": label_of(e.kind)})
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
        if isinstance(proposal, Abstain):
            try:
                reason: str = ReasonCode.model_validate(proposal.reason_code).root
            except ValidationError:
                reason = "invalid_reason_code"  # a code outside the contracts list never reaches a trace as text
            self.report.drafts["abstained"] += 1
            await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": reason})
            return
        if spec.tenant_level and proposal.outlet_ids is None:
            proposal = replace(proposal, outlet_ids=[])
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
            if e.status == 422 and e.reason_code == "campaign_audience_unscoped":
                # R67: core takes the win-back campaign on a demo business only; everywhere else it is the expected refusal.
                self.report.drafts["abstained"] += 1
                await self.trace("abstain", spec.pack, {"detector": spec.id, "reason": "campaign_audience_unscoped"})
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
    return error_label(e)  # C2: ADK's `_ResourceExhaustedError` (a 429) is not a label as named


def detectors_for(event_type: str | None) -> dict[str, list[DetectorSpec]]:
    """pack -> its detectors: all of them for a sweep (None), only those watching the type for an event."""
    import munim_intel.watch.detectors  # noqa: F401  (registers the detectors)

    out: dict[str, list[DetectorSpec]] = {}
    for pack, specs in REGISTRY.items():
        chosen = [s for s in specs if event_type is None or event_type in s.watches]
        if chosen:
            out[pack] = chosen
    return out

"""Generated typed tools (T-080, ADR-014 §5): one `read_<template>` per agent-exposed snapshot template and one
`propose_<command>` per agent-exposed draftable, built from ontology.json — names come from contract names, never
from generated class names (R3-m10), and each schema is the generated model-facing one, sent to ADK as
`parameters_json_schema` (no per-provider emitters; ADK converts).

Every tool closes over the run: RunContext (tenant and outlet scope from the verified token), the internal client, and
the run's one HandleTable. No schema has a tenant, run or actor parameter (tests/test_tools.py scans every tool).

  read_<template>   expands id handles in the params, mints a snapshot through core-api (or re-reads the one this run
                    already minted with the same params: `page` never mints again) and returns a capped digest in which
                    id cells appear as their handle paths, so the model never sees or types a UUID (§5.4).
  propose_<command> expands every handle (Ref leaf → ⟨snap:…⟩, id leaf → the cell's uuid), mints new-entity ids and the
                    draft id deterministically (§5.5), checks the payload against the contract model, and posts a draft
                    — `proposed` at most: a named person approves before anything changes (R16, ADR-014 §2.2).

Errors the model sees are fixed English with paths, handles, column names and reason codes — never a raw body, an
exception message or a cell value (§5.3).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types
from pydantic import BaseModel, ValidationError

from munim_intel.contracts_gen import models
from munim_intel.contracts_gen.models import InternalDraftsRequest, InternalSnapshotsRequest
from munim_intel.contracts_gen.names import CONTRACTS
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import CoreError, InternalClient
from munim_intel.tools.args import problems
from munim_intel.tools.handles import SNAP_OPEN, HandleError, HandleTable
from munim_intel.tools.ontology import Ontology, load_ontology

PAGE_ROWS = 50
#: Past page 2 the model is told to narrow its parameters (§5.4).
MAX_PAGES = 3
#: ≈ 2,000 tokens at about four characters a token (§5.4).
DIGEST_CHARS = 8000
ERROR_CHARS = 300
#: §5.3: a 5xx or network failure of a draft post is retried twice, same draft id (core replays it).
RETRY_BACKOFF_S: tuple[float, ...] = (0.5, 2.0)
#: Payload keys that name target outlets (core intersects them with the token's scope).
OUTLET_KEYS = ("outlet_id", "outlet_ids", "from_outlet_id", "to_outlet_id")

REASON_HINTS: dict[str, str] = {
    "recently_rejected": "A person rejected this proposal within 30 days.",
    "unresolved_ref": "A handle did not resolve to a cell in this tenant. Use handles minted in this run.",
    "cross_tenant_ref": "A handle points outside this tenant. Use handles minted in this run.",
    "missing_ref": "A value needs a cell handle. Read the template that holds it first.",
    "authority_denied": "This proposal is outside what the run may propose.",
    "stale_draft": "The cells this proposal assumes have changed. Read them again.",
    "number_grammar": "Text contains a number outside a handle. Cite every number as a handle.",
}


def _clip(message: str) -> dict[str, str]:
    return {"error": message[:ERROR_CHARS]}


def _core_hint(e: CoreError) -> str:
    if e.reason_code:
        fallback = f"core-api refused this ({e.reason_code}). Abstain with that reason or change the arguments."
        return REASON_HINTS.get(e.reason_code, fallback)
    if e.status == 404:
        return "This template is not available to this run."
    if e.status in (400, 422):
        return "core-api refused the arguments as invalid. Check each argument's form against the tool description."
    if e.status == 403:
        return "This run may not do that."
    return "core-api could not complete this now. Try again later or answer with what you have."


# -- deterministic ids (§5.5) ------------------------------------------------------------------------------------


def run_start_ms(run_id: str) -> int:
    """The run's start: a UUIDv7 carries its creation time in its first 48 bits."""
    return int(run_id.replace("-", "")[:12], 16)


def uuid7(ts_ms: int, seed: str) -> str:
    """UUIDv7 with the given timestamp and `rand` = sha256(seed): the same seed always gives the same id."""
    b = bytearray(ts_ms.to_bytes(6, "big") + hashlib.sha256(seed.encode()).digest()[:10])
    b[6] = 0x70 | (b[6] & 0x0F)
    b[8] = 0x80 | (b[8] & 0x3F)
    return str(uuid.UUID(bytes=bytes(b)))


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# -- leaf walking ------------------------------------------------------------------------------------------------


def _slots(obj: Any, parts: list[str], at: str = "") -> Iterator[tuple[Any, Any, str]]:
    """(container, key, concrete JSON pointer) for each place a `*`-pointer names in `obj`."""
    if not parts:
        return
    head, rest = parts[0], parts[1:]
    if head == "*":
        if isinstance(obj, list):
            for i, item in enumerate(obj):
                if rest:
                    yield from _slots(item, rest, f"{at}/{i}")
                else:
                    yield obj, i, f"{at}/{i}"
    elif isinstance(obj, dict):
        if rest:
            yield from _slots(obj.get(head), rest, f"{at}/{head}")
        else:
            yield obj, head, f"{at}/{head}"


def _pointer(path: str) -> list[str]:
    return path.split("/")[1:]


class _GeneratedTool(BaseTool):
    def __init__(self, *, name: str, description: str, schema: dict[str, Any], handles: HandleTable) -> None:
        super().__init__(name=name, description=description)
        self.schema = schema
        self.handles = handles

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(name=self.name, description=self.description, parameters_json_schema=self.schema)

    def validate_args(self, args: dict[str, Any]) -> str | None:
        """None when `args` fit the model-facing schema, else the actionable message (§5.3, ≤ 300 chars)."""
        found = problems(self.schema, args)
        if not found:
            return None
        hint = "Call it again with corrected arguments; ids and numbers are handles like S1.r0.<column>."
        return f"invalid arguments for {self.name}: {'; '.join(found)}. {hint}"[:ERROR_CHARS]


class ReadTemplateTool(_GeneratedTool):
    def __init__(self, fn: dict[str, Any], client: InternalClient, handles: HandleTable) -> None:
        columns = ", ".join(c["name"] for c in fn["columns"])
        super().__init__(
            name=fn["tool"],
            description=(
                f"Read snapshot template {fn['id']} (columns: {columns}). Returns a handle S<n> and up to {PAGE_ROWS} rows a page; "
                "cite a cell as {S<n>.r<i>.<column>} and pass id cells by their handle, never by value."
            ),
            schema=fn["model_schema"],
            handles=handles,
        )
        self.template_id: str = fn["id"]
        self._leaves: list[dict[str, Any]] = fn["leaves"]
        self._client = client

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        bad = self.validate_args(args)
        if bad:
            return _clip(bad)
        page = args["page"]
        if page < 0 or page >= MAX_PAGES:
            return _clip(f"page must be 0–{MAX_PAGES - 1}; past that, narrow the parameters (dates, outlet) instead of paging.")
        params = {k: v for k, v in args.items() if k != "page"}
        try:
            for leaf in self._leaves:
                for box, key, _ in _slots(params, _pointer(leaf["path"])):
                    if box[key] is not None:
                        box[key] = self.handles.literal_id(box[key])
        except HandleError as e:
            return _clip(str(e))
        key = f"{self.template_id}\0{_canonical(params)}"
        handle = self.handles.cached(key)
        if handle is None:
            try:
                req = InternalSnapshotsRequest.model_validate({"template_id": self.template_id, "params": params})
                snap = await self._client.mint_snapshot(req)
            except CoreError as e:
                return _clip(_core_hint(e))
            except (httpx.TransportError, ValidationError):
                return _clip("core-api could not complete this now. Try again later or answer with what you have.")
            handle = self.handles.add_snapshot(snap.model_dump(mode="json"), key)
        return digest(self.handles.snapshot(handle), handle, page)


def digest(snap: dict[str, Any], handle: str, page: int) -> dict[str, Any]:
    """§5.4: {handle, template_id, row_count, columns, rows, truncated, next_page}, at most DIGEST_CHARS. Id cells
    are shown as their handle path; every other cell as its typed value."""
    cols = [c["name"] for c in snap["columns"]]
    ids = {c["name"] for c in snap["columns"] if c["type"] == "uuid"}
    rows: list[dict[str, Any]] = snap["rows"]
    start = page * PAGE_ROWS
    shown = [
        {"row": f"{handle}.r{i}", **{c: (f"{handle}.r{i}.{c}" if c in ids and r.get(c) is not None else r.get(c)) for c in cols}}
        for i, r in enumerate(rows[start : start + PAGE_ROWS], start)
    ]
    more = start + PAGE_ROWS < len(rows)
    out: dict[str, Any] = {
        "handle": handle,
        "template_id": snap["template_id"],
        "row_count": len(rows),
        "columns": cols,
        "rows": shown,
        "truncated": more,
        "next_page": page + 1 if more and page + 1 < MAX_PAGES else None,
    }
    while shown and len(_canonical(out)) > DIGEST_CHARS:
        shown.pop()
        out["truncated"] = True
        out["note"] = "Rows were cut to fit; narrow the parameters to see the rest."
    return out


class ProposeTool(_GeneratedTool):
    def __init__(self, action: dict[str, Any], pack: str, ctx: RunContext, client: InternalClient, handles: HandleTable) -> None:
        super().__init__(
            name=action["tool"],
            description=(
                f"Propose a {action['command_type']} draft. Nothing changes until a named person approves it. "
                "Every number and id is a handle (S<n>.r<i>.<column>); based_on lists the cells the proposal assumes."
            ),
            schema=action["model_schema"],
            handles=handles,
        )
        self.command_type: str = action["command_type"]
        self.contract: str = action["contract"]
        self._leaves: list[dict[str, Any]] = action["leaves"]
        self._optional: list[str] = action["optional"]
        self._pack = pack
        self._ctx = ctx
        self._client = client

    def _contract_model(self) -> type[BaseModel]:
        cls: type[BaseModel] = getattr(models, CONTRACTS[self.contract])
        return cls

    def _expand(self, payload: dict[str, Any]) -> list[str]:
        """Expand handles in place; returns the canonical refs placed in the payload."""
        refs: list[str] = []
        h = self.handles
        for leaf in self._leaves:
            kind = leaf["kind"]
            for box, key, _ in _slots(payload, _pointer(leaf["path"])):
                if kind == "fixed":
                    box[key] = None
                    continue
                if kind == "minted" or box[key] is None:
                    continue
                if kind == "ref":
                    box[key] = h.ref(box[key])
                    refs.append(box[key])
                elif kind == "ref_id":
                    box[key] = h.ref_id(box[key])
                    refs.append(box[key])
                elif kind == "entity":
                    box[key] = h.literal_id(box[key])
                elif kind == "snapshot":
                    box[key] = h.snapshot_id(box[key])
                elif kind == "finding":
                    box[key] = h.finding_id(box[key])
        for path in self._optional:
            for box, key, _ in _slots(payload, _pointer(path)):
                if isinstance(box, dict) and box.get(key) is None:
                    box.pop(key, None)
        return refs

    def _mint(self, payload: dict[str, Any], draft_id: str) -> None:
        ts = run_start_ms(self._ctx.run_id)
        for leaf in self._leaves:
            if leaf["kind"] != "minted":
                continue
            parts = _pointer(leaf["path"])
            # The leaf is absent from the model's arguments: set it in every parent object that exists.
            for container, at in self._parents(payload, parts[:-1]):
                pointer = f"{at}/{parts[-1]}"
                container[parts[-1]] = uuid7(ts, f"{draft_id}{pointer}")

    @staticmethod
    def _parents(payload: dict[str, Any], parts: list[str]) -> Iterator[tuple[dict[str, Any], str]]:
        if not parts:
            yield payload, ""
            return
        for box, key, at in _slots(payload, parts):
            child = box[key] if isinstance(box, list) or key in box else None
            if isinstance(child, dict):
                yield child, at

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        bad = self.validate_args(args)
        if bad:
            return _clip(bad)
        payload = json.loads(json.dumps({k: v for k, v in args.items() if k not in ("based_on", "finding")}))
        try:
            refs = self._expand(payload)
            based_on: list[str] = []
            for b in args["based_on"]:
                r = self.handles.ref(b)
                if not r.startswith(SNAP_OPEN + "snap:"):
                    return _clip(f"based_on takes cell handles (S<n>.r<i>.<column>); {b} is not one.")
                based_on.append(r)
            finding = self.handles.finding_id(args["finding"]) if args["finding"] is not None else None
        except HandleError as e:
            return _clip(str(e))
        for r in refs:
            if r.startswith(SNAP_OPEN + "snap:") and r not in based_on:
                based_on.append(r)
        evidence: list[str] = []
        for r in [*based_on, *refs]:
            # ⟨snap:<id>·row·col⟩ → snap:<id>; ⟨cite:<id>[·span]⟩ → <id>; a bare RefId leaf is already one.
            ref_id = r[1:-1].removeprefix("cite:").split("·")[0] if r.startswith(SNAP_OPEN) else r
            if ref_id not in evidence:
                evidence.append(ref_id)
        outlets: set[str] = set()
        for k in OUTLET_KEYS:
            v = payload.get(k)
            outlets.update([v] if isinstance(v, str) else [x for x in v if isinstance(x, str)] if isinstance(v, list) else [])
        fingerprint = _canonical([self.command_type, payload, sorted(based_on)])
        draft_id = uuid7(run_start_ms(self._ctx.run_id), f"{self._ctx.run_id}\0{fingerprint}")
        self._mint(payload, draft_id)
        try:
            self._contract_model().model_validate(payload)
        except ValidationError as e:
            where = "; ".join(f"/{'/'.join(str(p) for p in err['loc'])}: {err['type']}" for err in e.errors()[:5])
            return _clip(f"the proposal does not fit {self.command_type}: {where}. Fix those arguments and call again.")
        request = InternalDraftsRequest.model_validate(
            {
                "draft_id": draft_id,
                "pack": self._pack,
                "command_type": self.command_type,
                "payload": payload,
                "outlet_ids": sorted(outlets),
                "finding_id": finding,
                "evidence": evidence,
                "based_on": based_on,
            }
        )
        for attempt in range(len(RETRY_BACKOFF_S) + 1):
            try:
                res = await self._client.write_draft(request)
                break
            except CoreError as e:
                if e.status == 409:
                    return {"draft": self.handles.add_draft(draft_id), "status": "proposed", "message": "Already recorded."}
                if e.status < 500 or attempt == len(RETRY_BACKOFF_S):
                    return _clip(_core_hint(e))
            except httpx.TransportError:
                if attempt == len(RETRY_BACKOFF_S):
                    return _clip("core-api could not complete this now. Answer with what you have.")
            await asyncio.sleep(RETRY_BACKOFF_S[attempt])
        if res.status == "abstained":
            code = res.reason_code.root if res.reason_code is not None else None
            return {"status": "abstained", "reason_code": code, "message": REASON_HINTS.get(code or "", "core-api refused this proposal.")}
        return {
            "draft": self.handles.add_draft(res.draft_id.root),
            "status": "proposed",
            "message": "Recorded as a proposal; a named person must approve it before anything changes.",
        }


# -- binding -----------------------------------------------------------------------------------------------------


def _exposed(ont: Ontology) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    fns = {f["id"]: f for f in ont["functions"] if f["agent_exposed"]}
    acts = {a["command_type"]: a for a in ont["actions"] if a["agent_exposed"]}
    return fns, acts


def build_toolset(
    pack: str,
    ctx: RunContext,
    client: InternalClient,
    handles: HandleTable,
    *,
    propose: bool = True,
    ontology: Ontology | None = None,
) -> list[BaseTool]:
    """One specialist's generated tools: its registry templates that exist, and (with `propose`) its draftables.
    Binding propose tools only on `draft_request`, with one skill loaded, is the caller's rule (T-082a)."""
    ont = ontology if ontology is not None else load_ontology()
    entry = next((s for s in ont["specialists"] if s["id"] == pack), None)
    if entry is None:
        raise KeyError(f"unknown specialist {pack!r}")
    fns, acts = _exposed(ont)
    tools: list[BaseTool] = [ReadTemplateTool(fns[t], client, handles) for t in entry["templates"] if t in fns]
    if propose:
        tools += [ProposeTool(acts[d], pack, ctx, client, handles) for d in entry["draftables"] if d in acts]
    return tools


def build_every_tool(ctx: RunContext, client: InternalClient, handles: HandleTable, *, ontology: Ontology | None = None) -> list[BaseTool]:
    """Every generated tool, owned or not — for the schema scans only."""
    ont = ontology if ontology is not None else load_ontology()
    fns, acts = _exposed(ont)
    tools: list[BaseTool] = [ReadTemplateTool(f, client, handles) for f in fns.values()]
    # Each action posts as the first specialist whose registry entry may propose it (core refuses any other pack, T-040b).
    owner = {d: sp["id"] for sp in reversed(ont["specialists"]) if sp["kind"] == "specialist" for d in sp["draftables"]}
    return tools + [ProposeTool(a, owner[t], ctx, client, handles) for t, a in acts.items()]

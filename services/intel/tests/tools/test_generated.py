"""Gates for the generated typed tools (T-080, ADR-014 §5): handles, expansion, the toolset each specialist binds,
deterministic ids, digest caps and actionable errors. core-api is an httpx MockTransport behind the real InternalClient;
the number grammar is core-domain's own (tests/tools/grammar_check.mts under node). Every refusal has its accept."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from google.adk.tools.base_tool import BaseTool

from conftest import INTEL, REPO
from munim_intel.contracts_gen import models
from munim_intel.contracts_gen.names import CONTRACTS
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools import generated
from munim_intel.tools.generated import ProposeTool, ReadTemplateTool, build_toolset, run_start_ms, uuid7
from munim_intel.tools.handles import HandleTable
from munim_intel.tools.ontology import load_ontology

RUN = "01920000-0000-7000-8000-000000000001"
CTX = RunContext(
    run_id=RUN,
    tenant_id="01920000-0000-7000-8000-000000000002",
    outlet_scope=("*",),
    trigger="ask",
    actor="01920000-0000-7000-8000-000000000003",
    expires_at=2_000_000_000,
    token="t.t.t",
)
#: The generated tools never read ADK's ToolContext.
NO_CONTEXT: Any = None
UUID7 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SNAP_ID = "01920000-0000-7000-8000-00000000a001"
SUPPLIER = "01920000-0000-7000-8000-00000000b001"
OUTLET = "01920000-0000-7000-8000-00000000b002"
INGREDIENT = "01920000-0000-7000-8000-00000000b003"
FINDING = "01920000-0000-7000-8000-00000000c001"
# Per-specialist toolset size = agent-exposed templates + draftables, by hand from the pack md §3 tables (ADR-014 §5.1;
# no `forecast.*` input-only, no `purchasing.deal_inputs` / `invoice_duplicates` review-only) and the registry draftables:
#   catalogue 6 reads (catalogue.md §3) + 3 proposes = 9
#   finance 7 reads (finance.md §3) + margin_bridge + gst_summary (registry) = 9, + 3 proposes = 12
#   inventory_purchasing 11 reads (inventory-purchasing.md §3) - 2 review-only = 9, + purchasing.invoices, inventory.counts,
#     inventory.count_variance (registry-only: 0022, assigned by orchestrator 11 Oct) = 12, + 5 proposes = 17
#   kitchen 5 + 2 = 7 · people 6 + 2 = 8 · compliance 5 + 2 = 7
#   customers 7 + 0 = 7 (R-B S1-B / S1-D ruling, 11 Oct: coupon.set and campaign.create are not agent-exposed)
#   market 6 reads + market.goals (registry-only: 0022, assigned by orchestrator 11 Oct) + cares.listings + cares.impact
#     (0028, ADR-015 §4) = 9, + 2 proposes = 11
# Every one is <= 20 (F3). Reads over all specialists = 6+9+12+5+6+7+5+9 = 59, plus forecast's 3 exposed (points, accuracy,
# freshness; forecast.md §3 lists 5 minus the 2 input-only) = 62 = EVERY_TOOL reads below.
TOOLSET_SIZE = {
    "catalogue": 9,
    "finance": 12,
    "inventory_purchasing": 17,
    "kitchen": 7,
    "people": 8,
    "customers": 7,
    "compliance": 7,
    "market": 11,
}
#: Every model tool: 18 proposals (23 - 5 not agent-exposed) + 60 agent-exposed templates (db/tests/manifest.ts TEMPLATES 68 after 0022 - 1 platform
#: operator - 3 intel.* - 4 ADR-014 §5.1 not-agent-exposed = 60; 0022's five new ones are owned by specialists now).
#: 0028 (ADR-015): + cares.listings and cares.impact (market) = 62 agent-exposed templates; cares.recipient_match, cares.pickup_crew
#: (mapping code) and platform.cares_network_impact (operator) are not. Proposals stay 18 (cares.listing.publish is a workflow draftable).
EVERY_TOOL = 80
#: MANIFEST.d proposal lines (23) - 3 workflow / import-only - coupon.set and campaign.create (R-B S1-B / S1-D).
PROPOSALS = 18


def snapshot(template: str, columns: list[dict[str, Any]], rows: list[dict[str, Any]], sid: str = SNAP_ID) -> dict[str, Any]:
    return {
        "snapshot_id": sid,
        "template_id": template,
        "params": {},
        "run_id": RUN,
        "minted_by_member_id": None,
        "minted_by_operator_id": None,
        "outlet_scope": ["*"],
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "sha256": "0" * 64,
        "created_at": "2026-10-11T00:00:00Z",
    }


QUOTES = snapshot(
    "purchasing.quote_compare",
    [
        {"name": "supplier_id", "type": "uuid"},
        {"name": "outlet_id", "type": "uuid"},
        {"name": "ingredient_id", "type": "uuid"},
        {"name": "qty_milli", "type": "integer", "numeric_source": "intel.supplier_quote.qty_milli"},
        {"name": "unit_price_minor", "type": "integer", "numeric_source": "intel.supplier_quote.unit_price_minor"},
    ],
    [{"supplier_id": SUPPLIER, "outlet_id": OUTLET, "ingredient_id": INGREDIENT, "qty_milli": 12000, "unit_price_minor": 4150}],
)


class Core:
    """A MockTransport core-api: records every request; `drafts` answers with a configurable status."""

    def __init__(self, *, draft_status: int = 201, draft_body: Callable[[dict[str, Any]], dict[str, Any]] | None = None) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.draft_status = draft_status
        self.draft_body = draft_body or (lambda b: {"draft_id": b["draft_id"], "status": "proposed", "reason_code": None})
        self.mints = 0

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        path = req.url.path.rsplit("/", 1)[-1]
        self.requests.append((path, body))
        if path == "snapshots":
            self.mints += 1
            n = self.mints
            rows = [
                {"item_id": f"01920000-0000-7000-8000-{n:06x}{i:06x}", "units_sold": i * 7, "margin_minor": 1000 + i} for i in range(500)
            ]
            cols = [
                {"name": "item_id", "type": "uuid"},
                {"name": "units_sold", "type": "integer"},
                {"name": "margin_minor", "type": "integer"},
            ]
            snap = snapshot(body["template_id"], cols, rows, sid=f"01920000-0000-7000-8000-{n:012x}")
            snap["params"] = body["params"]
            return httpx.Response(201, json=snap)
        if path == "drafts":
            if self.draft_status != 201:
                return httpx.Response(
                    self.draft_status, json={"error": {"code": "invalid_payload", "message": "RAW-CORE-BODY", "reason_code": "missing_ref"}}
                )
            return httpx.Response(201, json=self.draft_body(body))
        return httpx.Response(404)

    def client(self) -> InternalClient:
        return InternalClient(CTX, base_url="http://core.test", service_secret="x", transport=httpx.MockTransport(self.handler))


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def tool(tools: list[BaseTool], name: str) -> Any:
    return next(t for t in tools if t.name == name)


def po_args(**over: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "supplier_id": "S1.r0.supplier_id",
        "outlet_ids": ["S1.r0.outlet_id"],
        "currency": "INR",
        "expected_on": None,
        "lines": [
            {
                "ingredient_id": "S1.r0.ingredient_id",
                "qty_milli": "S1.r0.qty_milli",
                "unit": "kg",
                "unit_price_minor": "S1.r0.unit_price_minor",
            }
        ],
        "based_on": ["S1.r0.qty_milli"],
        "finding": None,
    }
    args.update(over)
    return args


def grammar(texts: list[str]) -> list[dict[str, Any]]:
    node = shutil.which("node")
    assert node, "node is required: the grammar gate runs core-domain's checkGrammar"
    out = subprocess.run(
        [node, str(INTEL / "tests" / "tools" / "grammar_check.mts")],
        input=json.dumps(texts),
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    result: list[dict[str, Any]] = json.loads(out.stdout)
    return result


# -- gate 7: handles ------------------------------------------------------------------------------------------------


def test_handle_round_trip_expands_to_canonical_and_an_unexpanded_handle_fails_the_number_grammar() -> None:
    h = HandleTable()
    assert h.add_snapshot(QUOTES) == "S1"
    prose = "Price creep on this line: {S1.r0.unit_price_minor} against {S7.r0.unit_price_minor}."
    expanded = h.expand_text(prose)
    canonical = f"⟨snap:{SNAP_ID}·0·unit_price_minor⟩"
    good, bad = expanded.split(" against ")
    assert good == f"Price creep on this line: {canonical}"
    assert bad == "{S7.r0.unit_price_minor}."  # unresolved: left in place
    models.Ref.model_validate(canonical)  # well-formed per the contract
    results = grammar([good, expanded])
    print(f"grammar: expanded -> {results[0]}, with an unexpanded handle -> {results[1]}")
    assert results[0] == {"ok": True}
    # numeric_char is the grammar rule core-api reports as reason_code number_grammar (04 §4 check 2).
    assert results[1]["ok"] is False and results[1]["rule"] == "numeric_char"


def test_one_handle_table_per_run_shared_counter_across_toolsets() -> None:
    core = Core()
    index: dict[str, str] = {}
    h = HandleTable(index)
    client = core.client()
    manager = build_toolset("catalogue", CTX, client, h)
    branch = build_toolset("finance", CTX, client, h, propose=False)
    a = run(
        tool(manager, "read_catalogue_dish_margin").run_async(
            args={"from": "2026-09-01", "to": "2026-09-30", "outlet_id": None, "channel_kind": None, "page": 0}, tool_context=None
        )
    )
    b = run(
        tool(branch, "read_finance_pnl").run_async(args={"period_month": "2026-09-01", "group_by": "outlet", "page": 0}, tool_context=None)
    )
    assert (a["handle"], b["handle"]) == ("S1", "S2")
    assert sorted(index) == ["S1", "S2"] and index["S2"].startswith("snap:")
    assert h.add_snapshot(h.snapshot("S1")) == "S1"  # the same snapshot id keeps its handle


def test_handle_errors_are_actionable_and_value_free() -> None:
    h = HandleTable()
    h.add_snapshot(QUOTES)
    for handle, want in [
        ("S7.r0.qty_milli", "S7 does not exist in this run. Minted: S1."),
        ("S1.r9.qty_milli", "S1 has rows r0–r0, columns {supplier_id, outlet_id, ingredient_id, qty_milli, unit_price_minor}."),
        ("S1.r0.nope", "S1 has rows r0–r0, columns {supplier_id, outlet_id, ingredient_id, qty_milli, unit_price_minor}."),
    ]:
        with pytest.raises(Exception, match=re.escape(want)):
            h.ref(handle)
    assert h.ref("S1.r0.qty_milli") == f"⟨snap:{SNAP_ID}·0·qty_milli⟩"
    with pytest.raises(Exception, match="does not hold an id"):
        h.literal_id("S1.r0.qty_milli")
    assert h.literal_id("S1.r0.supplier_id") == SUPPLIER


# -- reads: caps, pagination, no UUIDs ------------------------------------------------------------------------------


def test_read_digest_is_capped_shows_no_uuid_and_pages_reread_the_stored_snapshot() -> None:
    core = Core()
    h = HandleTable()
    read = tool(build_toolset("catalogue", CTX, core.client(), h), "read_catalogue_dish_margin")
    args = {"from": "2026-09-01", "to": "2026-09-30", "outlet_id": None, "channel_kind": None, "page": 0}
    first = run(read.run_async(args=args, tool_context=None))
    second = run(read.run_async(args={**args, "page": 1}, tool_context=None))
    text = json.dumps([first, second])
    print(f"digest: {len(json.dumps(first))} chars, rows {len(first['rows'])}, mints {core.mints}")
    assert core.mints == 1  # page 1 re-read the stored snapshot
    assert len(json.dumps(first, ensure_ascii=False, separators=(",", ":"))) <= generated.DIGEST_CHARS
    assert first["row_count"] == 500 and first["truncated"] is True and first["next_page"] == 1
    assert second["rows"][0]["row"] == "S1.r50" and second["rows"][0]["item_id"] == "S1.r50.item_id"
    assert UUID7.search(text) is None
    third = run(read.run_async(args={**args, "page": 3}, tool_context=None))
    assert third == {"error": "page must be 0–2; past that, narrow the parameters (dates, outlet) instead of paging."}
    assert core.requests[0][1] == {"template_id": "catalogue.dish_margin", "params": {k: v for k, v in args.items() if k != "page"}}


def test_read_params_expand_id_handles_to_literals() -> None:
    core = Core()
    h = HandleTable()
    h.add_snapshot(QUOTES)
    read = tool(build_toolset("catalogue", CTX, core.client(), h), "read_catalogue_recipe_current")
    run(
        read.run_async(args={"item_id": "S1.r0.ingredient_id", "outlet_id": "S1.r0.outlet_id", "as_of": None, "page": 0}, tool_context=None)
    )
    assert core.requests[-1][1]["params"] == {"item_id": INGREDIENT, "outlet_id": OUTLET, "as_of": None}
    bad = run(
        read.run_async(
            args={"item_id": "01920000-0000-7000-8000-00000000b003", "outlet_id": None, "as_of": None, "page": 0}, tool_context=None
        )
    )
    assert bad["error"].startswith("'01920000-0000-7000-8000-00000000b003' is not a cell handle")


# -- proposes ---------------------------------------------------------------------------------------------------------


def test_propose_expands_handles_mints_ids_and_posts_only_canonical_refs() -> None:
    core = Core()
    h = HandleTable()
    h.add_snapshot(QUOTES)
    h.add_finding(FINDING)
    po = tool(build_toolset("inventory_purchasing", CTX, core.client(), h), "propose_purchasing_po_create")
    out = run(po.run_async(args=po_args(finding="F1"), tool_context=None))
    assert out == {
        "draft": "P1",
        "status": "proposed",
        "message": "Recorded as a proposal; a named person must approve it before anything changes.",
    }
    path, body = core.requests[-1]
    p = body["payload"]
    ref = f"⟨snap:{SNAP_ID}·0·"
    assert path == "drafts" and body["pack"] == "inventory_purchasing" and body["command_type"] == "purchasing.po.create.v1"
    assert (p["supplier_id"], p["outlet_ids"], p["lines"][0]["ingredient_id"]) == (SUPPLIER, [OUTLET], INGREDIENT)
    assert (p["lines"][0]["qty_milli"], p["lines"][0]["unit_price_minor"]) == (ref + "qty_milli⟩", ref + "unit_price_minor⟩")
    assert p["negotiation_run_id"] is None and UUID7.fullmatch(p["po_id"]) and UUID7.fullmatch(body["draft_id"])
    assert body["based_on"] == [ref + "qty_milli⟩", ref + "unit_price_minor⟩"] and body["evidence"] == [f"snap:{SNAP_ID}"]
    assert (body["outlet_ids"], body["finding_id"]) == ([OUTLET], FINDING)
    assert not re.search(r"\bS\d+\.r\d+|\bF\d+\b", json.dumps(body)) and "tenant" not in json.dumps(body)
    # deterministic: the same proposal in the same run gets the same draft id and po_id (§5.5)
    run(po.run_async(args=po_args(finding="F1"), tool_context=None))
    again = core.requests[-1][1]
    assert (again["draft_id"], again["payload"]["po_id"]) == (body["draft_id"], p["po_id"])
    assert body["draft_id"][:13].replace("-", "") == f"{run_start_ms(RUN):012x}"[:12]
    assert uuid7(run_start_ms(RUN), "x") == uuid7(run_start_ms(RUN), "x") != uuid7(run_start_ms(RUN), "y")


def test_nested_new_entity_ids_are_minted_per_element() -> None:
    core = Core()
    h = HandleTable()
    staff = snapshot(
        "people.payroll_lines",
        [{"name": "staff_id", "type": "uuid"}, {"name": "outlet_id", "type": "uuid"}, {"name": "needed_min", "type": "integer"}],
        [{"staff_id": SUPPLIER, "outlet_id": OUTLET, "needed_min": 480}, {"staff_id": INGREDIENT, "outlet_id": OUTLET, "needed_min": 300}],
    )
    h.add_snapshot(staff)
    roster = tool(build_toolset("people", CTX, core.client(), h), "propose_people_roster_create")
    shift = {"starts_at": "2026-10-12T09:00:00+05:30", "ends_at": "2026-10-12T17:00:00+05:30", "role_key": "cook"}
    args = {
        "outlet_id": "S1.r0.outlet_id",
        "week_start": "2026-10-12",
        "shifts": [{**shift, "staff_id": "S1.r0.staff_id"}, {**shift, "staff_id": "S1.r1.staff_id"}],
        "based_on": ["S1.r0.needed_min"],
        "finding": None,
    }
    assert run(roster.run_async(args=args, tool_context=None))["status"] == "proposed"
    p = core.requests[-1][1]["payload"]
    ids = [p["roster_id"], *(s["roster_shift_id"] for s in p["shifts"])]
    assert len(set(ids)) == 3 and all(UUID7.fullmatch(i) for i in ids)


def test_propose_errors_are_actionable_and_never_raw() -> None:
    core = Core(draft_status=422)
    h = HandleTable()
    h.add_snapshot(QUOTES)
    po = tool(build_toolset("inventory_purchasing", CTX, core.client(), h), "propose_purchasing_po_create")
    unknown = run(po.run_async(args=po_args(supplier_id="S4.r0.supplier_id"), tool_context=None))
    assert unknown == {"error": "S4 does not exist in this run. Minted: S1."}
    invalid = run(po.run_async(args=po_args(lines="three"), tool_context=None))
    assert invalid["error"].startswith("invalid arguments for propose_purchasing_po_create: /lines: expected array.")
    refused = run(po.run_async(args=po_args(), tool_context=None))
    assert refused == {"error": generated.REASON_HINTS["missing_ref"]}
    assert "RAW-CORE-BODY" not in json.dumps([unknown, invalid, refused])
    assert all(len(e["error"]) <= generated.ERROR_CHARS for e in (unknown, invalid, refused))
    # a uuid typed by the model is refused before core (the model never types an id)
    typed = run(po.run_async(args=po_args(supplier_id=SUPPLIER), tool_context=None))
    assert "is not a cell handle" in typed["error"]


def test_recently_rejected_comes_back_as_an_abstention() -> None:
    core = Core(draft_body=lambda b: {"draft_id": b["draft_id"], "status": "abstained", "reason_code": "recently_rejected"})
    h = HandleTable()
    h.add_snapshot(QUOTES)
    po = tool(build_toolset("inventory_purchasing", CTX, core.client(), h), "propose_purchasing_po_create")
    out = run(po.run_async(args=po_args(), tool_context=None))
    assert out == {"status": "abstained", "reason_code": "recently_rejected", "message": "A person rejected this proposal within 30 days."}


# -- gate 6: each specialist binds only its registry entry ---------------------------------------------------------


def foreign_tools(pack: str, names: list[str]) -> list[str]:
    entry = next(s for s in load_ontology()["specialists"] if s["id"] == pack)
    allowed = {f"read_{t.replace('.', '_')}" for t in entry["templates"]}
    allowed |= {"propose_" + re.sub(r"\.v[1-9][0-9]*$", "", d).replace(".", "_") for d in entry["draftables"]}
    return [n for n in names if n not in allowed]


def test_each_specialist_toolset_is_within_its_registry_entry() -> None:
    client = Core().client()
    sizes = {}
    for pack in TOOLSET_SIZE:
        names = [t.name for t in build_toolset(pack, CTX, client, HandleTable())]
        sizes[pack] = len(names)
        assert foreign_tools(pack, names) == [], pack
        assert len(names) <= 20  # F3 cap per context
    print(f"toolsets: {sizes}")
    assert sizes == TOOLSET_SIZE
    reads = [t.name for t in build_toolset("finance", CTX, client, HandleTable(), propose=False)]
    assert all(n.startswith("read_") for n in reads) and len(reads) == 9
    # planted: a foreign template in catalogue's toolset is caught
    planted = [t.name for t in build_toolset("catalogue", CTX, client, HandleTable())] + ["read_finance_pnl"]
    assert foreign_tools("catalogue", planted) == ["read_finance_pnl"]


def test_a_renamed_pydantic_class_leaves_tool_names_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    client = Core().client()
    before = [t.name for p in TOOLSET_SIZE for t in build_toolset(p, CTX, client, HandleTable())]
    cls = models.ProposalPurchasingPoCreateV1
    monkeypatch.setattr(models, "RenamedPurchaseOrderProposal", cls, raising=False)
    monkeypatch.delattr(models, "ProposalPurchasingPoCreateV1")
    monkeypatch.setitem(CONTRACTS, "proposal.purchasing.po.create.v1", "RenamedPurchaseOrderProposal")
    core = Core()
    h = HandleTable()
    h.add_snapshot(QUOTES)
    tools = [t for p in TOOLSET_SIZE for t in build_toolset(p, CTX, core.client(), h)]
    assert [t.name for t in tools] == before
    assert run(tool(tools, "propose_purchasing_po_create").run_async(args=po_args(), tool_context=None))["status"] == "proposed"


def test_declarations_are_the_generated_schemas() -> None:
    ont = load_ontology()
    tools = build_toolset("catalogue", CTX, Core().client(), HandleTable())
    for t in tools:
        decl = t._get_declaration()
        assert decl is not None and decl.parameters_json_schema is not None
        src = next(x for x in [*ont["functions"], *ont["actions"]] if x.get("tool") == t.name)
        assert decl.parameters_json_schema == src["model_schema"]
        assert isinstance(t, ReadTemplateTool | ProposeTool)
    assert (REPO / "packages" / "contracts" / "generated" / "ontology.json").exists()


def test_digest_cuts_rows_to_the_character_cap() -> None:
    wide = snapshot("catalogue.recipe_current", [{"name": "note", "type": "text"}], [{"note": "x" * 400} for _ in range(50)])
    out = generated.digest(wide, "S1", 0)
    assert len(json.dumps(out, ensure_ascii=False, separators=(",", ":"))) <= generated.DIGEST_CHARS
    assert 0 < len(out["rows"]) < 50 and out["truncated"] is True and out["note"].startswith("Rows were cut")


def test_adk_converts_every_generated_declaration_unchanged() -> None:
    """ADK, not us, converts the schemas (review minor 4): the Gemini path (LlmRequest.append_tools → the request config)
    and the OpenAILlm path (_function_declaration_to_openai_tool, which lowercases types) both carry them unchanged."""
    from google.adk.integrations.openai._openai_llm import _function_declaration_to_openai_tool
    from google.adk.models.llm_request import LlmRequest

    tools = generated.build_every_tool(CTX, Core().client(), HandleTable())
    req = LlmRequest()
    req.append_tools(tools)
    assert req.config.tools is not None
    decls = [d for tl in req.config.tools for d in (getattr(tl, "function_declarations", None) or [])]
    assert [d.name for d in decls] == [t.name for t in tools] and len(decls) == EVERY_TOOL
    sent = json.loads(req.config.model_dump_json(exclude_none=True))
    for t, d in zip(tools, decls, strict=True):
        assert isinstance(t, ReadTemplateTool | ProposeTool)
        assert d.parameters_json_schema == t.schema
        assert _function_declaration_to_openai_tool(d)["function"]["parameters"] == t.schema
    assert len(json.dumps(sent)) > 0


# -- what the tools post parses with core-api's own zod contracts ----------------------------------------------------

#: Literal values for the plain-text fields of the proposal schemas (by property name), valid per their contracts.
LITERALS: dict[str, str] = {
    "currency": "INR",
    "unit": "kg",
    "tax_class": "gst_5",
    "code": "SAVEMORE",
    "message_key": "campaign.festive",
    "title_key": "task.renew_licence",
    "memo_key": "journal.fee_dispute",
    "item_code": "bank.reconciled",
    "station": "grill",
    "role_key": "cook",
    "reason_code": "damaged",
    "period_month": "2026-10-01",
    "key": "name",
    "name": "Festive regulars",
    "note": "Spoiled on arrival",
    "channel_kind": "counter",
    "required_kinds": "fssai",
}
CELLS = snapshot(
    "fixture.cells",
    [{"name": "u", "type": "uuid"}, {"name": "n", "type": "integer"}],
    [{"u": SUPPLIER, "n": 1}],
)


def synth(schema: dict[str, Any], path: str, kinds: dict[str, str]) -> Any:
    """Arguments for a model-facing schema: handles where the leaf map says so, literals elsewhere, null when nullable."""
    kind = kinds.get(re.sub(r"/\d+", "/*", path))
    t = schema["type"]
    nullable = isinstance(t, list)
    base = t[0] if nullable else t
    if kind == "ref":
        return "S1.r0.n"
    if kind == "entity":
        return "S1.r0.u"
    if kind in ("snapshot", "ref_id"):
        return "S1"
    if kind == "finding":
        return "F1"
    if base == "object":
        return {k: synth(v, f"{path}/{k}", kinds) for k, v in schema["properties"].items()}
    if base == "array":
        return [synth(schema["items"], f"{path}/{i}", kinds) for i in range(max(1, schema.get("minItems", 0)))]
    if nullable:
        return None
    if "enum" in schema:
        return schema["enum"][0]
    if base == "boolean":
        return True
    if base == "integer":
        return 0
    desc = schema.get("description", "")
    if desc.startswith("A calendar date"):
        return "2026-10-12"
    if desc.startswith("An ISO-8601 date-time"):
        return "2026-10-12T09:00:00+05:30"
    return LITERALS[re.sub(r"/\d+$", "", path).rsplit("/", 1)[-1]]  # array items take their array's name


def test_every_posted_draft_and_mint_parses_with_core_zod() -> None:
    ont = load_ontology()
    core = Core()
    h = HandleTable()
    h.add_snapshot(CELLS)
    h.add_finding(FINDING)
    tools = generated.build_every_tool(CTX, core.client(), h)
    outcomes = {}
    for t in tools:
        assert isinstance(t, ReadTemplateTool | ProposeTool)
        src = next(x for x in [*ont["functions"], *ont["actions"]] if x.get("tool") == t.name)
        kinds = {leaf["path"]: leaf["kind"] for leaf in src["leaves"]} | {"/based_on/*": "ref"}
        args = synth(t.schema, "", kinds)
        outcomes[t.name] = run(t.run_async(args=args, tool_context=NO_CONTEXT))
    proposed = [n for n, o in outcomes.items() if o.get("status") == "proposed"]
    errors = {n: o for n, o in outcomes.items() if "error" in o}
    assert errors == {} and len(proposed) == PROPOSALS
    drafts = [b for p, b in core.requests if p == "drafts"]
    mints = [b for p, b in core.requests if p == "snapshots"]
    node = shutil.which("node")
    assert node, "node is required: this gate parses with core-api's zod contracts"
    out = subprocess.run(
        [node, str(INTEL / "tests" / "tools" / "zod_check.mts")],
        input=json.dumps({"drafts": drafts, "snapshots": mints}),
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    result = json.loads(out.stdout)
    print(
        f"zod: {len(drafts)} draft bodies, {len(mints)} mint bodies; failing {[i for i in result['drafts'] if i]} {[i for i in result['snapshots'] if i]}"
    )
    assert (len(drafts), len(mints)) == (PROPOSALS, EVERY_TOOL - PROPOSALS)
    assert result == {"drafts": [[] for _ in drafts], "snapshots": [[] for _ in mints], "findings": []}
    # the refusal side: a bare number where a Ref belongs is refused by the same check
    # the first draft whose payload has a top-level ref leaf
    bad = json.loads(
        json.dumps(next(d for d in drafts if any(isinstance(v, str) and v.startswith("⟨snap:") for v in d["payload"].values())))
    )
    leaf = next(k for k, v in bad["payload"].items() if isinstance(v, str) and v.startswith("⟨snap:"))
    bad["payload"][leaf] = "1200"
    refused = subprocess.run(
        [node, str(INTEL / "tests" / "tools" / "zod_check.mts")],
        input=json.dumps({"drafts": [bad], "snapshots": []}),
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    assert json.loads(refused.stdout)["drafts"] == [[f"payload/{leaf}"]]

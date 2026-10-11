"""T-058 wiring: the `graph_<template>` tools (munim_intel/graph/tools.py), offline over a mock core. Expected values are
hand-typed here: tool names and argument sets from the five templates' port table (id argument, depth for walks), the
skill bindings the orchestrator assigned (catalogue: dish_margin_drivers, neighbourhood; inventory_purchasing:
price_shock_path, supplier_dependency), and the F3 cap of 20 tools."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, cast

import httpx

from munim_intel.graph.tools import GraphTool, build_graph_tools
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.skills import load_skill
from munim_intel.tools.handles import HandleTable

CTX = RunContext(
    "01920000-0000-7000-8000-0000000058c1", "01920000-0000-7000-8000-0000000058c2", ("*",), "ask", "member:x", 2_000_000_000, "tok"
)
FINDING = "01920000-0000-7000-8000-0000000058f1"
NODE = "01920000-0000-7000-8000-0000000058e1"
FORBIDDEN = {"tenant_id", "run_id", "actor", "tenant", "outlet_id"}


def client(rows: list[dict[str, Any]], seen: list[dict[str, Any]], status: int = 200) -> InternalClient:
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append({"path": req.url.path, **json.loads(req.content)})
        if status != 200:
            return httpx.Response(status, json={"error": {"code": "invalid_payload", "message": "x", "reason_code": None}})
        return httpx.Response(200, json={"rows": rows})

    return InternalClient(CTX, base_url="http://core.test", service_secret="s", transport=httpx.MockTransport(handler))


def call(tool: GraphTool, args: dict[str, Any]) -> Any:
    return asyncio.run(tool.run_async(args=args, tool_context=cast(Any, None)))


def test_five_tools_take_only_their_templates_arguments_never_a_tenant() -> None:
    tools = build_graph_tools(
        ("price_shock_path", "dish_margin_drivers", "supplier_dependency", "claim_support", "neighbourhood"),
        cast(InternalClient, None),
        HandleTable(),
    )
    got = {t.name: sorted(cast(GraphTool, t).schema["properties"]) for t in tools}
    assert got == {
        "graph_price_shock_path": ["depth", "ingredient_id"],
        "graph_dish_margin_drivers": ["depth", "item_id"],
        "graph_supplier_dependency": ["supplier_id"],
        "graph_claim_support": ["finding_id"],
        "graph_neighbourhood": ["depth", "entity_id"],
    }
    assert not {p for t in tools for p in cast(GraphTool, t).schema["properties"]} & FORBIDDEN


def test_a_finding_handle_goes_to_core_as_its_id_and_ids_come_back_as_g_handles_with_taint() -> None:
    """Paired: rows → `tainted: true` (an entity name may be document text); no rows → not tainted."""
    handles = HandleTable()
    f = handles.add_finding(FINDING)
    seen: list[dict[str, Any]] = []
    rows = [{"node_id": NODE, "kind": "item", "name": "Dosa", "depth": 1}]
    tool = GraphTool("neighbourhood", client(rows, seen), handles)
    out = call(tool, {"entity_id": f, "depth": 2})
    assert seen == [{"path": "/internal/intel/v1/graph:query", "template": "neighbourhood", "args": {"entity_id": FINDING, "depth": 2}}]
    assert out == {"template": "neighbourhood", "rows": [{"node_id": "G1", "kind": "item", "name": "Dosa", "depth": 1}], "tainted": True}
    assert handles.entity_id("G1") == NODE
    again = call(GraphTool("price_shock_path", client([], seen), handles), {"ingredient_id": "G1", "depth": 1})
    assert seen[-1]["args"] == {"ingredient_id": NODE, "depth": 1} and again["tainted"] is False


def test_a_claim_or_finding_nodes_name_carries_a_handle_never_its_uuid() -> None:
    """claim_support names claim nodes `claim:<uuid>` (graph/project.py): the uuid comes back as the same G handle as the
    row's id column. Paired: an ordinary name is shown as it is."""
    handles = HandleTable()
    claim, entity = "01920000-0000-7000-8000-0000000058d1", NODE
    rows = [{"claim_id": claim, "claim_name": f"claim:{claim}", "relation": "supports", "entity_id": entity, "entity_name": "Rice"}]
    out = call(GraphTool("claim_support", client(rows, []), handles), {"finding_id": handles.add_finding(FINDING)})
    print("claim_support rows:", out["rows"])
    assert out["rows"] == [{"claim_id": "G1", "claim_name": "claim:G1", "relation": "supports", "entity_id": "G2", "entity_name": "Rice"}]
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}", json.dumps(out))


def test_bad_arguments_and_unknown_handles_are_refused_before_core_and_a_core_refusal_is_a_fixed_message() -> None:
    seen: list[dict[str, Any]] = []
    tool = GraphTool("price_shock_path", client([], seen), HandleTable())
    outs = [call(tool, a) for a in (
        {"ingredient_id": "G1", "depth": 4}, {"ingredient_id": "G1", "depth": 2, "tenant_id": "x"}, {"ingredient_id": "G9", "depth": 2},
        {"ingredient_id": NODE, "depth": 2},
    )]  # fmt: skip
    assert all("error" in o for o in outs) and seen == []
    handles = HandleTable()
    handles.add_node(NODE)
    refused = call(GraphTool("price_shock_path", client([], seen, 422), handles), {"ingredient_id": "G1", "depth": 2})
    assert refused == {"error": "core-api refused this graph query. Check the start handle and the depth."} and len(seen) == 1


def test_the_two_wired_skills_bind_their_graph_tools_within_the_cap() -> None:
    c = cast(InternalClient, None)
    got = {}
    for pack in ("catalogue", "inventory_purchasing"):
        tools = [t.name for t in load_skill(pack).toolset(CTX, c, HandleTable(), propose=True)]
        got[pack] = (sorted(n for n in tools if n.startswith("graph_")), len(tools))
    print("graph bindings:", got)
    assert got == {
        "catalogue": (["graph_dish_margin_drivers", "graph_neighbourhood"], 6 + 3 + 2),
        "inventory_purchasing": (["graph_price_shock_path", "graph_supplier_dependency"], 12 + 5 + 2),
    }

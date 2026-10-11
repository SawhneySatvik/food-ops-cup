"""`graph_<template>` tools (T-058 wiring; ADR-014 "Graph port"): the five bounded graph templates as typed model tools.

A tool takes only its template's own arguments (rule 3: no tenant, run or actor — core binds the tenant from the run
token): the start node as a handle — a node a graph tool returned (G<n>), a finding (F<n>) or an id cell
(S<n>.r<i>.<column>) — and, for a walk, `depth` 1..3. The model never sees or types a UUID: every id in a result row
comes back as a G<n> handle, and so does the uuid inside a claim or finding node's name (the projector names them
`claim:<id>` / `finding:<id>`). Rows carry kinds, names and hop counts — never a number to display.

Taint (W3 rule 4): an entity's name may be text a document or chat put there (an extracted, unlinked entity), and a
result row cannot tell which, so a result with any row marks the run tainted (`tainted: true`, the plugin's B1 rule):
no `propose_*` or `request_quotes` for the rest of the run.
"""

from __future__ import annotations

import re
from typing import Any

import httpx
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from munim_intel.graph.port import MAX_DEPTH, TEMPLATES
from munim_intel.runtime.internal_client import CoreError, InternalClient
from munim_intel.tools.args import problems
from munim_intel.tools.handles import HandleError, HandleTable

ERROR_CHARS = 300
#: A claim or finding node's name (graph/project.py `_node`): its label and the row's uuid.
NODE_NAME = re.compile(r"^(claim|finding):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")

DESCRIBE = {
    "price_shock_path": "Which dishes a price change of this ingredient reaches (through sub-recipes), with hop counts.",
    "dish_margin_drivers": "What a dish is made of, transitively through sub-recipes, and who supplies each ingredient.",
    "supplier_dependency": "What this supplier supplies and which of those ingredients have no other supplier.",
    "claim_support": "The claims a finding stands on, the entities each mentions, and claims that contradict them.",
    "neighbourhood": "Every entity within a few hops of this one, over any relation.",
}


def schema(template: str) -> dict[str, Any]:
    t = TEMPLATES[template]
    props: dict[str, Any] = {
        t.id_arg: {"type": "string", "description": "A handle: G<n> (a graph node), F<n> (a finding) or S<n>.r<i>.<id column>."}
    }
    if t.walks:
        props["depth"] = {"type": "integer", "enum": list(range(1, MAX_DEPTH + 1)), "description": "Hops to walk."}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


class GraphTool(BaseTool):
    def __init__(self, template: str, client: InternalClient, handles: HandleTable) -> None:
        super().__init__(name=f"graph_{template}", description=f"{DESCRIBE[template]} Ids come back as handles G<n>.")
        self.template = template
        self.schema = schema(template)
        self._client = client
        self._handles = handles

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(name=self.name, description=self.description, parameters_json_schema=self.schema)

    def validate_args(self, args: dict[str, Any]) -> str | None:
        found = problems(self.schema, args)
        if not found:
            return None
        return f"invalid arguments for {self.name}: {'; '.join(found)}. Pass the start node as a handle."[:ERROR_CHARS]

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        bad = self.validate_args(args)
        if bad:
            return {"error": bad}
        t = TEMPLATES[self.template]
        try:
            call: dict[str, str | int] = {t.id_arg: self._handles.entity_id(args[t.id_arg])}
        except HandleError as e:
            return {"error": str(e)[:ERROR_CHARS]}
        if t.walks:
            call["depth"] = args["depth"]
        try:
            rows = await self._client.graph_query(self.template, call)
        except CoreError:
            return {"error": "core-api refused this graph query. Check the start handle and the depth."}
        except httpx.TransportError:
            return {"error": "core-api could not complete this now. Answer with what you have."}
        shown = [{k: self._cell(k, v) for k, v in r.items()} for r in rows]
        return {"template": self.template, "rows": shown, "tainted": bool(shown)}

    def _cell(self, column: str, value: str | int | None) -> str | int | None:
        if not isinstance(value, str):
            return value
        if column.endswith("_id"):
            return self._handles.add_node(value)
        m = NODE_NAME.match(value)
        return f"{m.group(1)}:{self._handles.add_node(m.group(2))}" if m else value


def build_graph_tools(templates: tuple[str, ...], client: InternalClient, handles: HandleTable) -> list[BaseTool]:
    return [GraphTool(t, client, handles) for t in templates]

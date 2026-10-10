"""Gate: no tool schema names a tenant, a run or an actor (04-agent-framework §11 "tenant binding"; ADR-014 §5.6).
Reflects over every registered factory and every generated tool (T-080): the declaration ADK sends to the model (both
schema forms) and the Python signature behind it."""

from __future__ import annotations

import inspect
import re
from typing import Any

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.function_tool import FunctionTool

from conftest import REPO
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools import TOOLS, ToolFactory
from munim_intel.tools.generated import ProposeTool, ReadTemplateTool, build_every_tool
from munim_intel.tools.handles import HandleTable

#: tenant, run and actor never reach a model as parameters (ADR-014 §5.6). `negotiation_run_id` is tool-filled.
FORBIDDEN = re.compile(r"tenant|(^|_)run_id$|(^|_)actor($|_)")

CTX = RunContext(
    run_id="01920000-0000-7000-8000-000000000001",
    tenant_id="01920000-0000-7000-8000-000000000002",
    outlet_scope=("*",),
    trigger="ask",
    actor="01920000-0000-7000-8000-000000000003",
    expires_at=2_000_000_000,
    token="t.t.t",
)


def _schema_names(node: Any) -> list[str]:
    names: list[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "properties" and isinstance(v, dict):
                names.extend(v.keys())
            if k == "required" and isinstance(v, list):
                names.extend(str(x) for x in v)
            names.extend(_schema_names(v))
    elif isinstance(node, list):
        for v in node:
            names.extend(_schema_names(v))
    return names


def tenant_params(tool: BaseTool) -> list[str]:
    decl = tool._get_declaration()
    names = _schema_names(decl.model_dump(mode="json", exclude_none=True)) if decl else []
    if isinstance(tool, FunctionTool):
        names.extend(inspect.signature(tool.func).parameters)
    return sorted({n for n in names if FORBIDDEN.search(n.lower())})


def scan(tools: dict[str, ToolFactory], generated: list[BaseTool] | None = None) -> tuple[int, list[str]]:
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    built = [(name, factory(CTX, client)) for name, factory in tools.items()]
    built += [(t.name, t) for t in (generated if generated is not None else build_every_tool(CTX, client, HandleTable()))]
    hits: list[str] = []
    for name, tool in built:
        hits.extend(f"{name}.{p}" for p in tenant_params(tool))
    return len(built), hits


def expected_generated() -> int:
    """Independent count: MANIFEST.d proposal lines minus the two import-only drafts (ADR-014 §5.1), plus the
    db/tests/manifest.ts TEMPLATES list minus the operator template (platform.spend_by_tenant) and the core-consumed
    `intel.*` templates (0020: track record, budget left, cost estimate — never model tools)."""
    lines = [n for f in (REPO / "packages/contracts/MANIFEST.d").glob("*.txt") for n in f.read_text().split()]
    proposals = [n for n in lines if n.startswith("proposal.")]
    listed = re.search(r"export const TEMPLATES = \[(.*?)\];", (REPO / "db/tests/manifest.ts").read_text(), re.S)
    assert listed is not None
    templates = re.findall(r'"([a-z_.]+)"', listed.group(1))
    exposed = [t for t in templates if t != "platform.spend_by_tenant" and not t.startswith("intel.")]
    return (len(proposals) - 2) + len(exposed)


def test_no_registered_tool_takes_a_tenant() -> None:
    scanned, hits = scan(TOOLS, [])
    print(f"tool-schema scan: {scanned} registered tool(s), {len(hits)} forbidden param(s) {hits}")
    assert scanned >= 1
    assert hits == []


def test_no_generated_tool_takes_a_tenant_run_or_actor() -> None:
    scanned, hits = scan({})
    want = expected_generated()
    print(f"tool-schema scan: {scanned} generated tool(s) (expected {want}), {len(hits)} forbidden param(s) {hits}")
    assert scanned == want
    assert hits == []


def test_the_scan_sees_a_planted_tenant_param() -> None:
    def planted(ctx: RunContext, client: InternalClient) -> BaseTool:
        def lookup(tenant_id: str, item: str) -> str:
            """Planted: a tenant as a model argument."""
            return item

        return FunctionTool(lookup)

    scanned, hits = scan({**TOOLS, "planted": planted}, [])
    assert (scanned, hits) == (len(TOOLS) + 1, ["planted.tenant_id"])


def test_the_scan_sees_a_planted_run_or_actor_param_in_a_generated_schema() -> None:
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    tools = build_every_tool(CTX, client, HandleTable())
    read, propose = tools[0], tools[-1]
    assert isinstance(read, ReadTemplateTool) and isinstance(propose, ProposeTool)
    read.schema = {**read.schema, "properties": {**read.schema["properties"], "run_id": {"type": "string"}}}
    propose.schema = {**propose.schema, "properties": {**propose.schema["properties"], "actor": {"type": "string"}}}
    scanned, hits = scan({}, [read, propose])
    assert (scanned, sorted(hits)) == (2, sorted([f"{read.name}.run_id", f"{propose.name}.actor"]))

"""Gate: no tool schema names a tenant (04-agent-framework §11 "tenant binding"). Reflects over every registered
factory: the declaration ADK sends to the model (both schema forms) and the Python signature behind it."""

from __future__ import annotations

import inspect
from typing import Any

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.function_tool import FunctionTool

from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools import TOOLS, ToolFactory

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
    return sorted({n for n in names if "tenant" in n.lower()})


def scan(tools: dict[str, ToolFactory]) -> tuple[int, list[str]]:
    client = InternalClient(CTX, base_url="http://127.0.0.1:9", service_secret="x")
    hits: list[str] = []
    for name, factory in tools.items():
        hits.extend(f"{name}.{p}" for p in tenant_params(factory(CTX, client)))
    return len(tools), hits


def test_no_registered_tool_takes_a_tenant() -> None:
    scanned, hits = scan(TOOLS)
    print(f"tool-schema scan: {scanned} registered tool(s), {len(hits)} tenant param(s) {hits}")
    assert scanned >= 1
    assert hits == []


def test_the_scan_sees_a_planted_tenant_param() -> None:
    def planted(ctx: RunContext, client: InternalClient) -> BaseTool:
        def lookup(tenant_id: str, item: str) -> str:
            """Planted: a tenant as a model argument."""
            return item

        return FunctionTool(lookup)

    scanned, hits = scan({**TOOLS, "planted": planted})
    assert (scanned, hits) == (len(TOOLS) + 1, ["planted.tenant_id"])

"""The quarantine (project rule 8; ADR-014 §6.4 rules 1 and 3). An extraction or vision call is one request with no
tools and a JSON response schema, sent straight to the role's BaseLlm — no ADK agent, so there is no tool table to
reach. The run is tainted before the call: the untrusted text is in a context of the run from then on, whatever the
call returns. A response that tries a function call is refused whole (nothing in it is used), and nothing executes it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, ValidationError

from munim_intel.config import Config
from munim_intel.llm import ModelRoleSource, llm_for_role
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.state import RunState

#: Recorded extractor and vision responses (SYNTHETIC; written by tests/ingest/make_fixtures.py).
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


class QuarantineBreach(Exception):
    """`request_has_tools` (a bug here) or `tool_call_attempted` (the model tried to act). The message is the code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Unreadable(Exception):
    """The response is not the schema's JSON. The message is a code, never the model's text."""


def tool_count(req: LlmRequest) -> int:
    """Every way a request can offer the model a tool: config tools (function declarations or built-ins) and ADK's
    tools_dict."""
    n = len(req.tools_dict)
    for t in req.config.tools or []:
        declarations = getattr(t, "function_declarations", None)
        n += len(declarations) if declarations else 1
    return n


def _inline(schema: dict[str, Any]) -> dict[str, Any]:
    """A Pydantic JSON schema with its `$defs` substituted in place (providers' response schemas take no refs)."""
    defs = schema.pop("$defs", {})

    def sub(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return sub(dict(defs[node["$ref"].rsplit("/", 1)[1]]))
            return {k: sub(v) for k, v in node.items()}
        if isinstance(node, list):
            return [sub(v) for v in node]
        return node

    out: dict[str, Any] = sub(schema)
    return out


def build_request(llm: BaseLlm, system: str, parts: list[types.Part], schema: type[BaseModel]) -> LlmRequest:
    config = types.GenerateContentConfig(
        system_instruction=system,
        temperature=0,
        response_mime_type="application/json",
        response_schema=_inline(schema.model_json_schema()),
    )
    return LlmRequest(model=llm.model, contents=[types.Content(role="user", parts=parts)], config=config)


async def call[M: BaseModel](llm: BaseLlm, req: LlmRequest, schema: type[M], state: RunState) -> M:
    if tool_count(req) != 0:
        raise QuarantineBreach("request_has_tools")
    state.tainted = True
    last: LlmResponse | None = None
    async for resp in llm.generate_content_async(req, stream=False):
        parts = (resp.content.parts or []) if resp.content else []
        if any(p.function_call is not None for p in parts):
            raise QuarantineBreach("tool_call_attempted")
        if not resp.partial:
            last = resp
    text = "".join(p.text or "" for p in (last.content.parts or []) if not p.thought) if last and last.content else ""
    try:
        return schema.model_validate(json.loads(text))
    except (ValueError, ValidationError):
        raise Unreadable("response_not_schema") from None


async def quarantined_llm(role: Literal["extract", "vision"], cfg: Config, roles: ModelRoleSource) -> BaseLlm:
    """The `extract` or `vision` role. Recorded mode replays this package's fixtures."""
    if cfg.model_mode == "recorded":
        return RecordedLlm(model=f"recorded/{role}", fixtures_dir=FIXTURES_DIR)
    return await llm_for_role(role, cfg, roles)

"""RecordedLlm: committed fixtures instead of a provider (`MUNIM_MODEL_MODE=recorded`, the default; every gate).

A fixture is keyed by the sha256 of a canonical projection of the request: model, system text, contents (role,
text, function-call name + args, function-response name + data), tool declarations, output schema. ADK's
generated function-call ids and Gemini thought signatures are left out. Every UUID in the projection becomes a
positional placeholder (`⟦uuid:N⟧`, by first appearance), so a run with a fresh run id or freshly minted
snapshot ids hits the same fixture; placeholders in the recorded responses are mapped back to this request's ids.
A missing fixture is an error naming the key — never a fall-through to a live model. The other direction exists in live
mode only: a live call that fails is served from its fixture when there is one (providers.py, T-125).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any, ClassVar

from google.adk.models import BaseLlm, LlmCapabilities
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel

from munim_intel.trace.price import Price

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "recorded"

_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_PLACEHOLDER = re.compile(r"⟦uuid:(\d+)⟧")


class RecordedFixtureMissing(Exception):
    #: Misses raised in this process, counted when raised: callers that degrade on any error (the DecisionModel, run_agent)
    #: swallow the exception itself, so the test guard (tests/conftest.py) reads this count instead (R-E 2-C).
    raised: ClassVar[int] = 0

    def __init__(self, key: str, projection: str) -> None:
        super().__init__(f"no recorded fixture {key}.json")
        RecordedFixtureMissing.raised += 1
        self.key = key
        #: The canonical request (placeholders in), for whoever authors the fixture. Not in the message.
        self.projection = projection


class RecordedFixtureInvalid(Exception):
    pass


def _jsonable(x: Any) -> Any:
    if isinstance(x, BaseModel):
        return x.model_dump(mode="json", exclude_none=True)
    if isinstance(x, list):
        return [_jsonable(i) for i in x]
    if x is None or isinstance(x, str | int | float | bool | dict):
        return x
    return repr(x)


def _part(p: types.Part) -> dict[str, Any]:
    if p.function_call is not None:
        return {"call": p.function_call.name, "args": p.function_call.args or {}}
    if p.function_response is not None:
        return {"response": p.function_response.name, "data": p.function_response.response or {}}
    if p.text is not None:
        return {"thought": p.text} if p.thought else {"text": p.text}
    if p.inline_data is not None:
        return {"inline": p.inline_data.mime_type, "sha256": hashlib.sha256(p.inline_data.data or b"").hexdigest()}
    return {"other": p.model_dump(mode="json", exclude_none=True, exclude={"thought_signature"})}


def projection(req: LlmRequest) -> dict[str, Any]:
    cfg = req.config
    tools = [
        fd.model_dump(mode="json", exclude_none=True) for t in (cfg.tools or []) for fd in (getattr(t, "function_declarations", None) or [])
    ]
    return {
        "model": req.model,
        "system": _jsonable(cfg.system_instruction),
        "contents": [{"role": c.role, "parts": [_part(p) for p in c.parts or []]} for c in req.contents],
        "tools": sorted(tools, key=lambda d: str(d.get("name"))),
        "output": [_jsonable(cfg.response_schema), _jsonable(cfg.response_json_schema), cfg.response_mime_type],
    }


def request_key(req: LlmRequest) -> tuple[str, str, list[str]]:
    """(key, canonical projection with placeholders, the request's UUIDs in placeholder order)."""
    text = json.dumps(projection(req), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    ids: list[str] = []

    def sub(m: re.Match[str]) -> str:
        u = m.group(0).lower()
        if u not in ids:
            ids.append(u)
        return f"⟦uuid:{ids.index(u)}⟧"

    canonical = _UUID.sub(sub, text)
    return hashlib.sha256(canonical.encode()).hexdigest(), canonical, ids


class RecordedLlm(BaseLlm):
    """Replays `<fixtures_dir>/<key>.json` = {"request": <projection>, "responses": [<LlmResponse>, ...]}."""

    model: str = "recorded"
    fixtures_dir: Path = FIXTURES_DIR
    #: None → its spend rows are charged 0 (R47 D1: recorded mode has no operator price); a test may set one.
    price: Price | None = None
    #: Fixture replays in this process (ADK may copy the instance, so the count is per class).
    calls: ClassVar[int] = 0

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        key, canonical, ids = request_key(llm_request)
        responses = self.replay(key, ids)
        if responses is None:
            raise RecordedFixtureMissing(key, canonical)
        for r in responses:
            yield r

    def replay(self, key: str, ids: list[str]) -> list[LlmResponse] | None:
        """The fixture `<key>.json` with this request's `ids` put back, or None when there is none. The one loader: the
        live models' fallback (providers.py, T-125) replays through it too, and decides itself what a miss means."""
        path = self.fixtures_dir / f"{key}.json"
        if not path.is_file():
            return None

        def back(m: re.Match[str]) -> str:
            n = int(m.group(1))
            if n >= len(ids):
                raise RecordedFixtureInvalid(f"{key}.json: placeholder {n} has no id in the request")
            return ids[n]

        try:
            responses = json.loads(path.read_text("utf8"))["responses"]
        except (ValueError, KeyError) as e:
            raise RecordedFixtureInvalid(f"{key}.json: {type(e).__name__}") from None
        RecordedLlm.calls += 1
        return [LlmResponse.model_validate_json(_PLACEHOLDER.sub(back, json.dumps(r, ensure_ascii=False))) for r in responses]

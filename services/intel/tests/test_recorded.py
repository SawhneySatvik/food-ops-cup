"""RecordedLlm keying: deterministic, id-insensitive, and never a silent fall-through."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from munim_intel.config import Config
from munim_intel.llm.recorded import RecordedLlm, request_key
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import RunFailed, run_agent

RUN_A = "01920000-0000-7000-8000-00000000000a"
RUN_B = "01920000-0000-7000-8000-00000000000b"


def req(run_id: str, text: str = "ping", call_id: str | None = None) -> LlmRequest:
    return LlmRequest(
        model="recorded/router",
        contents=[
            types.Content(role="user", parts=[types.Part(text=text)]),
            types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(id=call_id, name="echo", args={"text": text}))]),
            types.Content(
                role="user",
                parts=[types.Part(function_response=types.FunctionResponse(id=call_id, name="echo", response={"run_id": run_id}))],
            ),
        ],
        config=types.GenerateContentConfig(system_instruction="sys"),
    )


def test_key_ignores_ids_but_not_content() -> None:
    a, _, ids_a = request_key(req(RUN_A, call_id="adk-1"))
    b, _, ids_b = request_key(req(RUN_B, call_id="adk-2"))
    assert a == b and ids_a == [RUN_A] and ids_b == [RUN_B]
    assert request_key(req(RUN_A, text="pong"))[0] != a


def test_placeholders_in_a_fixture_come_back_as_this_requests_ids(tmp_path: Path) -> None:
    key, canonical, _ = request_key(req(RUN_B))
    reply = {"content": {"role": "model", "parts": [{"text": "run ⟦uuid:0⟧"}]}}
    (tmp_path / f"{key}.json").write_text(json.dumps({"request": json.loads(canonical), "responses": [reply]}, ensure_ascii=False))

    async def first_text() -> str:
        async for r in RecordedLlm(fixtures_dir=tmp_path).generate_content_async(req(RUN_B)):
            assert r.content and r.content.parts
            return r.content.parts[0].text or ""
        return ""

    assert asyncio.run(first_text()) == f"run {RUN_B}"


@pytest.mark.fixture_miss_expected
def test_a_missing_fixture_fails_the_run_naming_its_key(cfg: Config, tmp_path: Path) -> None:
    ctx = RunContext(RUN_A, "01920000-0000-7000-8000-000000000002", ("*",), "ask", "brief", 2_000_000_000, "t.t.t")
    agent = LlmAgent(name="nofixture", model=RecordedLlm(model="recorded/router", fixtures_dir=tmp_path), instruction="x")
    with pytest.raises(RunFailed) as failed:
        asyncio.run(run_agent(agent, ctx, "hello", cfg))
    assert failed.value.kind == "RecordedFixtureMissing"
    assert failed.value.__cause__ is None and failed.value.__context__ is None

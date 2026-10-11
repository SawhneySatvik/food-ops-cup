"""Authors the recorded narration fixture in tests/wiki/fixtures (run by hand after a change to the wiki prompt):

    uv run --frozen python -m tests.wiki.make_fixtures

It runs the real narrator with a capturing model, so the fixture key is the exact request ADK builds.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import tempfile
from collections.abc import AsyncGenerator
from pathlib import Path

from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.config import load_config
from munim_intel.llm.recorded import projection, request_key
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import RunState
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.wiki import LlmNarrator, Neighbour

from .wikikit import cell, vid, world

OUT = Path(__file__).parent / "fixtures"
REPLY = "This supplier has a recorded claim {C1}. It is linked to a record {N1}."


class Capture(BaseLlm):
    model: str = "recorded/narrate"
    seen: list[LlmRequest] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        self.seen.append(llm_request)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=REPLY)]))


async def main() -> None:

    cfg = load_config(env={}, run_dir=Path(tempfile.mkdtemp()))
    ctx = RunContext(vid(0xAA), vid(0xBB), ("*",), "watch_sweep", "watcher:sweep", 0, "")

    async def sink(_: object) -> None:
        return None

    e = dataclasses.replace(world()[0], neighbours=(Neighbour(vid(3), "ingredient"),), cells=(cell("spend_minor", 7),))
    llm = Capture(seen=[])
    await LlmNarrator(llm, ctx, cfg, RunState(traces=TraceBuffer(sink))).prose(e)
    (req,) = llm.seen
    key, _, _ = request_key(req)
    body = {"request": projection(req), "responses": [{"content": {"parts": [{"text": REPLY}], "role": "model"}}]}
    OUT.mkdir(exist_ok=True)
    (OUT / f"{key}.json").write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n", "utf8")
    print(f"{key}.json")


if __name__ == "__main__":
    asyncio.run(main())

"""Authors the recorded brief fixture in tests/brief/fixtures (run by hand after a change to the brief prompt):

    uv run --frozen python -m tests.brief.make_fixtures

It runs the real brief with a capturing model, so the fixture key is the exact request ADK builds.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import AsyncGenerator
from pathlib import Path

from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.brief import compile_brief
from munim_intel.config import load_config
from munim_intel.llm.recorded import projection, request_key
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import RunState
from munim_intel.trace.buffer import TraceBuffer

from .briefkit import RecordingSink, items, reply, vid

OUT = Path(__file__).parent / "fixtures"


class Capture(BaseLlm):
    model: str = "recorded/narrate"
    seen: list[LlmRequest] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        self.seen.append(llm_request)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=reply())]))


async def main() -> None:
    cfg = load_config(env={}, run_dir=Path(tempfile.mkdtemp()))
    ctx = RunContext(vid(0xAA), vid(0xBB), ("*",), "brief", "brief", 0, "")

    async def trace_sink(_: object) -> None:
        return None

    llm = Capture(seen=[])
    await compile_brief(items(), RecordingSink(), ctx=ctx, llm=llm, cfg=cfg, state=RunState(traces=TraceBuffer(trace_sink)))
    (req,) = llm.seen
    key, _, _ = request_key(req)
    body = {"request": projection(req), "responses": [{"content": {"parts": [{"text": reply()}], "role": "model"}}]}
    OUT.mkdir(exist_ok=True)
    (OUT / f"{key}.json").write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n", "utf8")
    print(f"{key}.json")


if __name__ == "__main__":
    asyncio.run(main())

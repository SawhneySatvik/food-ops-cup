"""Authors the T-043 narration fixtures in fixtures/recorded (run by hand after a change to the narration prompt or a
reference detector; the gates replay them with RecordedLlm):

    uv run --frozen python tests/watch/make_fixtures.py

Each case runs the real narration step with a capturing model, so the fixture key is the exact request ADK builds.
The rows are where the answer-key plants sit in their snapshots (rows ordered by id; worldgen ids are seed-stable):
RG-F1 is row 0 of restaurant_group outlet 1's October `finance.unapproved_deductions`, ST-C4 row 8 of the store's
`catalogue.sku_price_check`. Each is the first snapshot its run narrates, so its handle is S1.
  clean        prose that cites cells by handle only → passes core's validator
  free_digit   prose with a typed figure ("2 rupees") → core refuses it: number_grammar
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from google.adk.models import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.config import load_config
from munim_intel.detect import DetectorSpec, Severity
from munim_intel.llm.recorded import FIXTURES_DIR, projection, request_key
from munim_intel.narrate import model_segments
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.state import RunState
from munim_intel.tools.handles import HandleTable
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.watch.detectors.catalogue import above_mrp
from munim_intel.watch.detectors.finance import unapproved_ad_fee

CASES: list[tuple[DetectorSpec, Severity, int, str]] = [
    (
        unapproved_ad_fee.SPEC,
        "high",
        0,
        "This channel billed {S1.r0.ad_fee_minor} in ad fees although ads were never switched on, "
        "so {S1.r0.unapproved_minor} was charged without your agreement.",
    ),
    (above_mrp.SPEC, "critical", 8, "This item sells for 2 rupees over its printed MRP, putting {S1.r8.above_mrp_minor} at risk."),
]


class Capture(BaseLlm):
    model: str = "recorded/narrate"
    reply: str = ""
    seen: list[LlmRequest] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        self.seen.append(llm_request)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=self.reply)]))


def fake_snapshot(spec: DetectorSpec, rows: int) -> dict[str, Any]:
    return {
        "snapshot_id": "01920000-0000-7000-8000-00000000c0de",
        "columns": [{"name": spec.impact_column, "type": "integer"}],
        "rows": [{}] * rows,
    }


async def main() -> None:
    cfg = load_config(env={}, run_dir=Path(tempfile.mkdtemp()))
    ctx = RunContext(
        "01920000-0000-7000-8000-0000000000aa", "01920000-0000-7000-8000-0000000000bb", ("*",), "watch_sweep", "watcher:sweep", 0, ""
    )

    async def sink(_: Any) -> None:
        return None

    for spec, severity, row, reply in CASES:
        llm = Capture(reply=reply, seen=[])
        state = RunState(traces=TraceBuffer(sink))
        await model_segments(
            spec,
            severity,
            fake_snapshot(spec, row + 1),
            row,
            row,
            llm=llm,
            ctx=ctx,
            cfg=cfg,
            state=state,
            handles=HandleTable(state.handles),
        )
        (req,) = llm.seen
        key, _, _ = request_key(req)
        body = {"request": projection(req), "responses": [{"content": {"parts": [{"text": reply}], "role": "model"}}]}
        (FIXTURES_DIR / f"{key}.json").write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n", "utf8")
        print(f"{spec.id} row {row}: {key}.json")


if __name__ == "__main__":
    asyncio.run(main())

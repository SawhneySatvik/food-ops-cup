"""R-C F9: a recorded fixture that is missing is counted, and a module with any miss fails at teardown — the pipeline
turns a missing fixture into a refused source (`model_error:RecordedFixtureMissing`), which would otherwise pass for
"the model refused". Module scope: test_ingest's `run` fixture is module-scoped and must be counted too. A test that
plants a miss on purpose clears the list it is handed."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Iterator

import pytest
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

from munim_intel.llm.recorded import RecordedFixtureMissing, RecordedLlm


@pytest.fixture(scope="module", autouse=True)
def no_fixture_misses() -> Iterator[list[str]]:
    misses: list[str] = []
    replay = RecordedLlm.generate_content_async

    async def counted(self: RecordedLlm, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        try:
            async for r in replay(self, llm_request, stream):
                yield r
        except RecordedFixtureMissing as e:
            misses.append(e.key)
            raise

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(RecordedLlm, "generate_content_async", counted)
        yield misses
    assert misses == [], f"recorded fixtures missing: {misses}"

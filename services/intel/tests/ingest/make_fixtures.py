"""Writes the recorded extractor and vision fixtures (`munim_intel/ingest/fixtures/`). Run from services/intel:

    uv run --frozen python -m tests.ingest.make_fixtures

The responses are SYNTHETIC (tests/ingest/corpus.py): what an extract or vision model is assumed to answer, including
the planted injections that answer with a function call. Replaying them proves the quarantine and the checks after it,
never model quality.
"""

from __future__ import annotations

import json
from typing import Any

from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.ingest.claims import extract_request
from munim_intel.ingest.invoice import vision_request
from munim_intel.ingest.quarantine import FIXTURES_DIR
from munim_intel.llm.recorded import RecordedLlm, request_key

from . import corpus as C

EXTRACT = RecordedLlm(model="recorded/extract", fixtures_dir=FIXTURES_DIR)
VISION = RecordedLlm(model="recorded/vision", fixtures_dir=FIXTURES_DIR)


def text(body: dict[str, Any]) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=json.dumps(body, ensure_ascii=False))]))


def calling(call: dict[str, Any], body: dict[str, Any] | None = None) -> LlmResponse:
    parts = [types.Part(text=json.dumps(body))] if body is not None else []
    parts.append(types.Part(function_call=types.FunctionCall(name=call["name"], args=call["args"])))
    return LlmResponse(content=types.Content(role="model", parts=parts))


def write(req: LlmRequest, resp: LlmResponse) -> None:
    key, canonical, _ = request_key(req)
    resp.usage_metadata = types.GenerateContentResponseUsageMetadata(prompt_token_count=len(canonical) // 4)
    body = {"request": json.loads(canonical), "responses": [resp.model_dump(mode="json", exclude_none=True)]}
    (FIXTURES_DIR / f"{key}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf8")


def main() -> None:
    FIXTURES_DIR.mkdir(exist_ok=True)
    for old in FIXTURES_DIR.glob("*.json"):
        old.unlink()
    # Each corpus document is one chunk (under CHUNK_CHARS), so the extractor sees exactly the document's text.
    write(extract_request(EXTRACT, C.SUPPLY_TEXT), text({"claims": C.SUPPLY_CLAIMS}))
    write(extract_request(EXTRACT, C.INJECT_TEXT), calling(C.INJECT_CALL))
    write(extract_request(EXTRACT, C.INJECT_MIXED_TEXT), calling(C.INJECT_MIXED_CALL, {"claims": C.INJECT_MIXED_CLAIMS}))
    write(extract_request(EXTRACT, C.GREENS_TEXT), text({"claims": C.GREENS_CLAIMS}))
    write(extract_request(EXTRACT, C.MSG_INJECT_TEXT), calling(C.MSG_INJECT_CALL))
    png = "image/png"
    write(vision_request(VISION, C.IMAGES[C.DOC_INVOICE], png), text(C.INVOICE_READ))
    write(vision_request(VISION, C.IMAGES[C.DOC_INVOICE_UNKNOWN], png), text(C.INVOICE_UNKNOWN_READ))
    write(vision_request(VISION, C.IMAGES[C.DOC_INVOICE_OFFPAGE], png), text(C.INVOICE_OFFPAGE_READ))
    write(vision_request(VISION, C.IMAGES[C.DOC_INVOICE_INJECT], png), calling(C.INVOICE_INJECT_CALL, C.INVOICE_READ))


if __name__ == "__main__":
    main()

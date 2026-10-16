"""R63: what a live Gemini model POSTs is the shape the Gemini API accepts. Offline: the body is caught at google-genai's
transport (`BaseApiClient._async_request`), after ADK and google-genai have built it; nothing reaches the network.

Measured live (R63, 16 Oct; status codes only): a Pydantic JSON schema sent as `response_schema` answers 400
INVALID_ARGUMENT on `generation_config.response_schema` from gemini-3.5-flash-lite AND gemini-3.8-flash, because Google's
OpenAPI-subset Schema has no `additionalProperties`; the same schema as `response_json_schema` answers 200 (the quote and the
claims schemas, the latter without `minLength`, `maxLength`, `pattern` and `default`, which are left out), and so does the
router's STRING enum under `text/x.enum` (its logprobs request 400s by design and is retried without, T-059). The invoice
schema still answered 400 after that, cause not isolated within the call budget (reported, R63). Every
quarantined call (supplier-quote extraction, claims, invoice vision) carries such a schema, so on live models each one
failed `model_error:ClientError` — the go-live's `no_quote`.

The caller's request is never edited: the recorded fallback (T-125) keys the request as built, so every committed fixture
keeps its key.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import _api_client, types
from google.genai.errors import ClientError
from pydantic import BaseModel

from conftest import GEMINI_KEY
from munim_intel.decide.mimic import build_request as router_request
from munim_intel.decide.questions import ROUTE_INTENT
from munim_intel.ingest import quarantine
from munim_intel.ingest.claims import EXTRACTOR_SYSTEM, ExtractedClaims
from munim_intel.ingest.invoice import VISION_SYSTEM, InvoiceRead
from munim_intel.llm.providers import TimedGemini
from munim_intel.llm.recorded import FIXTURES_DIR, RecordedLlm, request_key
from munim_intel.negotiate.extract import INSTRUCTION, QuoteFields
from munim_intel.trace.served import KEY

MODELS = ("gemini-3.5-flash-lite", "gemini-3.8-flash")
#: A committed negotiation fixture (record_cobnut.py): the extractor reading Bargain Bulk Traders' 1 kg reply.
FIXTURE = FIXTURES_DIR / "02838d3f4c458b70f856b601c94196f267398849c5674fc28a82cdc4f9329301.json"


@pytest.fixture
def bodies(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Every body the transport is handed; each is answered 400, as the API answers a shape it refuses."""
    sent: list[dict[str, Any]] = []

    async def transport(_self: Any, http_request: Any, http_options: Any = None, stream: bool = False) -> Any:
        sent.append(json.loads(json.dumps(http_request.data)))
        raise ClientError(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT"}})

    monkeypatch.setattr(_api_client.BaseApiClient, "_async_request", transport)
    return sent


def send(llm: TimedGemini, req: LlmRequest) -> list[Any]:
    async def go() -> list[Any]:
        return [r async for r in llm.generate_content_async(req)]

    try:
        return asyncio.run(go())
    except ClientError:
        return []


def live(model: str) -> TimedGemini:
    return TimedGemini(model=model, client_kwargs={"api_key": GEMINI_KEY})


@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize(
    ("system", "part", "schema"),
    [
        (INSTRUCTION, types.Part(text="a supplier's reply"), QuoteFields),
        (EXTRACTOR_SYSTEM, types.Part(text="a document's text"), ExtractedClaims),
        (VISION_SYSTEM, types.Part(inline_data=types.Blob(mime_type="image/png", data=b"\x89PNG")), InvoiceRead),
    ],
    ids=["quote", "claims", "invoice"],
)
def test_a_quarantined_schema_goes_to_gemini_as_a_json_schema(
    bodies: list[dict[str, Any]], model: str, system: str, part: types.Part, schema: type[BaseModel]
) -> None:
    llm = live(model)
    send(llm, quarantine.build_request(llm, system, [part], schema))
    [body] = bodies
    gen = body["generationConfig"]
    assert "responseSchema" not in gen
    assert gen["responseMimeType"] == "application/json"
    assert gen["responseJsonSchema"]["type"] == "object"
    assert gen["responseJsonSchema"]["additionalProperties"] is False
    # The field the API refuses, in either spelling, nowhere in what is sent; nor the keywords outside Gemini's subset.
    sent = json.dumps(body)
    assert "additional_properties" not in sent
    assert not [k for k in ('"minLength"', '"maxLength"', '"pattern"', '"default"') if k in sent]
    # What stays is the schema's shape: every property, still required, still closed.
    full = quarantine._inline(schema.model_json_schema())
    assert set(gen["responseJsonSchema"]["properties"]) == set(full["properties"])
    assert gen["responseJsonSchema"]["required"] == full["required"]


def test_the_router_enum_is_sent_as_before(bodies: list[dict[str, Any]]) -> None:
    llm = live(MODELS[0])
    send(llm, router_request(llm, ROUTE_INTENT, {"question": "q", "outlet_kinds": ("restaurant",), "country": "IN"}, logprobs=False))
    [body] = bodies
    gen = body["generationConfig"]
    assert gen["responseMimeType"] == "text/x.enum"
    assert gen["responseSchema"] == {"type": "STRING", "enum": ["A", "B", "C", "D", "E", "F"]}
    assert "responseJsonSchema" not in gen


def test_a_refused_call_is_still_served_from_its_committed_fixture(bodies: list[dict[str, Any]]) -> None:
    """The caller's request is untouched, so the fallback finds the fixture recorded mode authored under its old key."""
    recorded = json.loads(FIXTURE.read_text("utf8"))
    [text] = [p["text"] for c in recorded["request"]["contents"] for p in c["parts"]]
    llm = live(MODELS[0])
    llm.fallback = RecordedLlm(model="recorded/extract", fixtures_dir=FIXTURES_DIR)
    req = quarantine.build_request(llm, INSTRUCTION, [types.Part(text=text)], QuoteFields)
    before = request_key(req.model_copy(update={"model": "recorded/extract"}))[0]
    assert before == FIXTURE.stem

    responses = send(llm, req)
    assert len(bodies) == 1, "the provider was called once"
    assert [r.content.parts[0].text for r in responses] == [recorded["responses"][0]["content"]["parts"][0]["text"]]
    assert responses[0].custom_metadata[KEY] == "recorded-fallback"
    assert isinstance(req.config.response_schema, dict) and req.config.response_json_schema is None
    assert request_key(req.model_copy(update={"model": "recorded/extract"}))[0] == before

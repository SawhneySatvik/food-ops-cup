"""T-056 gates (BOARD b-56): the quarantined extractor and vision, claims, the invoice draft, map.columns, traces.

Recorded mode only; the model answers are SYNTHETIC (tests/ingest/corpus.py, tests/ingest/make_fixtures.py) and prove
the plumbing and the checks, never model quality. Expected values are hand-counted in the corpus or read from the
source texts themselves — never from the code under test. Core is a fake here (shape-checked against the generated
contract models); tests/ingest/test_ingest_e2e.py runs chunks, claims and embeddings through the real core-api.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any, ClassVar

import pytest
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from conftest import GEMINI_KEY
from munim_intel.config import load_config
from munim_intel.contracts_gen.models import (
    InternalBatchResponse,
    InternalDraftsResponse,
    InternalSpendRequest,
    InternalTracesBatchRequest,
    PlatformModelRoles,
)
from munim_intel.decide import mimic
from munim_intel.decide.mimic import LlmMimic
from munim_intel.decide.port import EgressRefused, egress_payload
from munim_intel.decide.questions import MAP_COLUMNS
from munim_intel.ingest import claims as claims_mod
from munim_intel.ingest import columns, quarantine
from munim_intel.ingest.claims import ExtractedClaim, ExtractedClaims, extract_request
from munim_intel.ingest.embed import DIMENSIONS, RecordedEmbedder, write_embeddings
from munim_intel.ingest.invoice import COMMAND, InvoiceDraft, InvoiceRead, invoice_draft, vision_request
from munim_intel.ingest.link import Alias, AliasTable, normalize_alias
from munim_intel.ingest.pipeline import Ingest, Report
from munim_intel.ingest.quarantine import FIXTURES_DIR, QuarantineBreach, tool_count
from munim_intel.ingest.sink import BATCHES
from munim_intel.llm.providers import TimedGemini
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import CoreError
from munim_intel.runtime.state import Budget, RunState
from munim_intel.trace.buffer import TraceBuffer
from munim_intel.trace.spend import Meter, SpendBuffer, estimate_input_tokens

from . import corpus as C

INTEL_TESTS = Path(__file__).resolve().parents[1]
DOC_REF = re.compile(r"^⟨cite:doc:([0-9a-f-]{36})·([0-9]+)-([0-9]+)⟩$")


class Spy(RecordedLlm):
    """A RecordedLlm that keeps every request it is sent (the gates inspect what actually left)."""

    seen: ClassVar[list[LlmRequest]] = []

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        Spy.seen.append(llm_request)
        async for r in super().generate_content_async(llm_request, stream):
            yield r


class FakeSink:
    """core's batch and draft routes, shape-checked against the generated contracts. Embeddings answer 503 (as embedded
    Postgres without pgvector does) unless `vectors` is set."""

    def __init__(self, vectors: bool = False) -> None:
        self.vectors = vectors
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def batch(self, route: str, body: dict[str, Any]) -> InternalBatchResponse:
        BATCHES[route].model_validate(body)
        self.posts.append((route, body))
        if route == "embeddings:batch" and not self.vectors:
            raise CoreError(503, "unavailable", None)
        return InternalBatchResponse(inserted=len(next(iter(body.values()))), existing=0)

    async def draft(self, body: dict[str, Any]) -> InternalDraftsResponse:
        self.posts.append(("drafts", body))
        return InternalDraftsResponse.model_validate({"draft_id": body["draft_id"], "status": "proposed", "reason_code": None})

    def rows(self, route: str) -> list[dict[str, Any]]:
        return [r for p, b in self.posts if p == route for r in next(iter(b.values()))]


ALIASES = AliasTable(
    [
        Alias(C.vid(0xA1), "supplier", f"core.supplier:{C.SUPPLIER}", "Steady Dairy"),
        Alias(C.vid(0xA2), "ingredient", f"core.ingredient:{C.INGREDIENT_PANEER}", "Paneer"),
        Alias(C.vid(0xA3), "supplier", None, "fresh  farm GREENS"),
        # Two entities share "cream": exact linking leaves it unlinked.
        Alias(C.vid(0xA4), "ingredient", None, "Cream"),
        Alias(C.vid(0xA5), "ingredient", None, "cream"),
    ]
)


def new_state() -> tuple[RunState, list[InternalTracesBatchRequest]]:
    sent: list[InternalTracesBatchRequest] = []

    async def sink(req: InternalTracesBatchRequest) -> object:
        sent.append(req)
        return None

    return RunState(traces=TraceBuffer(sink)), sent


def ingest(state: RunState, sink: FakeSink) -> Ingest:
    return Ingest(
        state=state,
        sink=sink,
        extract_llm=Spy(model="recorded/extract", fixtures_dir=FIXTURES_DIR),
        vision_llm=Spy(model="recorded/vision", fixtures_dir=FIXTURES_DIR),
        embedder=RecordedEmbedder(),
        aliases=ALIASES,
        actor="specialist:inventory_purchasing",
    )


class Run:
    def __init__(self) -> None:
        Spy.seen = []
        self.state, self.traces_sent = new_state()
        # Hand count of the model calls: 3 documents of one chunk each + 2 messages + 4 invoice pages (R-C F6: every
        # quarantined call spends the run's budget).
        self.state.budget = Budget(max_model_calls=9)
        self.sink = FakeSink()
        ing = ingest(self.state, self.sink)

        async def go() -> dict[str, Report]:
            out = {doc: await ing.document(doc, text) for doc, text in C.DOCS.items()}
            out["messages"] = await ing.messages(C.MESSAGES)
            for doc, image in C.IMAGES.items():
                out[doc] = await ing.invoice(doc, image, "image/png", "INR")
            await self.state.traces.flush()
            return out

        self.reports = asyncio.run(go())
        self.requests = list(Spy.seen)


@pytest.fixture(scope="module")
def run() -> Run:
    return Run()


# -- (1) the extractor and vision hold no tool -----------------------------------------------------------------------


def test_extractor_and_vision_requests_offer_no_tool(run: Run) -> None:
    """Every request that reached a quarantined model (captured on the wire, not read off our builder) offers 0 tools:
    no config tools, no ADK tools_dict. Expected request count = the corpus' sources: 3 documents + 2 messages + 4 pages."""
    roles = [str(r.model) for r in run.requests]
    print("quarantined requests:", {m: roles.count(m) for m in sorted(set(roles))})
    assert roles.count("recorded/extract") == 5 and roles.count("recorded/vision") == 4
    for r in run.requests:
        assert not r.config.tools and not r.tools_dict, r.model
        assert tool_count(r) == 0
        assert r.config.response_schema and r.config.response_mime_type == "application/json"


def test_a_request_with_a_tool_is_refused_before_the_model_is_called() -> None:
    """The runtime guard behind gate (1): a planted tool → `request_has_tools`, 0 model calls; the clean request → sent."""
    Spy.seen = []
    llm = Spy(model="recorded/extract", fixtures_dir=FIXTURES_DIR)
    state, _ = new_state()
    req = extract_request(llm, C.SUPPLY_TEXT)
    req.config.tools = [types.Tool(function_declarations=[types.FunctionDeclaration(name="propose_purchasing_po_create")])]
    with pytest.raises(QuarantineBreach, match="request_has_tools"):
        asyncio.run(quarantine.call(llm, req, ExtractedClaims, state))
    assert Spy.seen == []
    out = asyncio.run(quarantine.call(llm, extract_request(llm, C.SUPPLY_TEXT), ExtractedClaims, state))
    assert len(Spy.seen) == 1 and len(out.claims) == len(C.SUPPLY_CLAIMS)


# -- (2) claim quotes are source substrings --------------------------------------------------------------------------


def test_claim_quotes_are_their_source_text_100_percent(run: Run) -> None:
    """Every claim sent equals its source's text at its span — the source read from the corpus (a document at the
    chunk's char_start, or the message body), not from the chunks the code built. Kept and dropped counts are the
    corpus' hand counts."""
    chunks = {c["id"]: c for c in run.sink.rows("chunks:batch")}
    messages = dict(C.MESSAGES)
    claims = run.sink.rows("claims:batch")
    checked = 0
    for cl in claims:
        if cl["chunk_id"]:
            ch = chunks[cl["chunk_id"]]
            source = C.DOCS[ch["document_id"]][ch["char_start"] :]
        else:
            source = messages[cl["message_id"]]
        assert source[cl["span_start"] : cl["span_end"]] == cl["quote"], cl["id"]
        checked += 1
    dropped = sum(r.dropped for r in run.reports.values())
    print(f"claims sent {len(claims)}, quote == source text {checked}/{len(claims)}, dropped {dropped}")
    assert checked == len(claims) == C.EXPECTED_KEPT
    assert dropped == C.EXPECTED_DROPPED
    # Exact-alias links: Steady Dairy → its entity; "Fresh Farm Greens" matches "fresh  farm GREENS" after normalising.
    subjects = {cl["quote"][:12]: cl["subject_entity_id"] for cl in claims}
    assert subjects["Steady Dairy"] == C.vid(0xA1) and subjects["Fresh Farm G"] == C.vid(0xA3)


def test_exact_alias_linking_links_one_match_only() -> None:
    assert normalize_alias("﻿ Fresh  Farm\tGREENS ") == "fresh farm greens"
    assert ALIASES.link("Steady Dairy", "supplier") is not None
    assert ALIASES.link("Steady Dairy", "ingredient") is None
    assert ALIASES.link("Steady Dairies") is None
    assert ALIASES.link("cream") is None  # two entities: ambiguous → unlinked


# -- (3) injection: 0 tool calls, the run tainted --------------------------------------------------------------------


def test_injection_fixtures_execute_no_tool_and_taint_the_run(run: Run) -> None:
    """The planted sources answer with a function call: each is refused whole (no claim from it, not even the plausible
    one beside the call), nothing is executed (no tool exists to run), no draft from the injected page, and the run
    is tainted."""
    refused = sum(r.refused.get("tool_call_attempted", 0) for r in run.reports.values())
    print("refused tool_call_attempted:", refused, "tainted:", run.state.tainted, "tool calls:", run.state.budget.tool_calls)
    assert refused == C.EXPECTED_REFUSED + 1  # + the injected invoice page
    chunks = {c["id"]: c["document_id"] for c in run.sink.rows("chunks:batch")}
    sources = {chunks.get(cl["chunk_id"]) or cl["message_id"] for cl in run.sink.rows("claims:batch")}
    assert sources.isdisjoint({C.DOC_INJECT, C.DOC_INJECT_MIXED, C.MSG_INJECT})
    assert run.reports[C.DOC_INVOICE_INJECT].reason_code == "tool_call_attempted"
    assert len([b for p, b in run.sink.posts if p == "drafts"]) == 1  # the clean page only
    assert run.state.tainted is True
    assert run.state.budget.tool_calls == 0


@pytest.mark.fixture_miss_expected
def test_any_extraction_taints_the_run_even_when_it_fails(no_fixture_misses: list[str]) -> None:
    """Taint is set before the call: a clean document taints, and so does a call that never returns (missing fixture,
    which the pipeline records as a refused source, `model_error:RecordedFixtureMissing`)."""
    for text in (C.SUPPLY_TEXT, "a document with no recorded answer"):
        state, _ = new_state()
        assert state.tainted is False
        ing = ingest(state, FakeSink())
        report = asyncio.run(ing.document(C.vid(0xD9), text))
        assert state.tainted is True, text[:20]
    assert report.refused == {"model_error:RecordedFixtureMissing": 1}
    assert len(no_fixture_misses) == 1  # the planted miss, and only it
    no_fixture_misses.clear()


# -- the invoice draft -----------------------------------------------------------------------------------------------


def test_invoice_image_becomes_a_draft_whose_numbers_are_page_spans(run: Run) -> None:
    """One draft (never a recorded invoice): every number is a doc span whose page text is the hand-located number, the
    supplier and paneer are linked by exact alias, the unlinked line keeps its words; the page's chunks are written
    before the draft. Paired refusals: an unknown supplier and a rate that is not on the page abstain, no draft."""
    drafts = [b for p, b in run.sink.posts if p == "drafts"]
    assert len(drafts) == 1
    d = drafts[0]
    assert (d["command_type"], d["pack"], d["outlet_ids"], d["evidence"]) == (COMMAND, "inventory_purchasing", [], [f"doc:{C.DOC_INVOICE}"])
    p = d["payload"]
    assert (p["supplier_id"], p["invoice_no"], p["invoice_date"], p["currency"], p["po_id"]) == (
        C.SUPPLIER,
        "INV-1042",
        "2026-10-09",
        "INR",
        None,
    )
    numbers = []
    for line, printed in zip(p["lines"], C.INVOICE_LINES, strict=True):
        lo = C.INVOICE_PAGE.index(printed)
        for k in ("qty_milli", "unit_price_minor", "tax_minor"):
            m = DOC_REF.match(line[k])
            assert m and m.group(1) == C.DOC_INVOICE, line[k]
            s, e = int(m.group(2)), int(m.group(3))
            assert lo <= s < e <= lo + len(printed), (k, printed)
            numbers.append(C.INVOICE_PAGE[s:e])
    assert numbers == C.INVOICE_NUMBERS
    assert [(ln["ingredient_id"], ln["description"], ln["unit"]) for ln in p["lines"]] == [
        (C.INGREDIENT_PANEER, None, "kg"),
        (None, "Malai cream", "l"),
    ]
    order = [p for p, b in run.sink.posts if p == "drafts" or b.get("chunks", [{}])[0].get("document_id") == C.DOC_INVOICE]
    assert order == ["chunks:batch", "drafts"]
    page_chunks = [c for c in run.sink.rows("chunks:batch") if c["document_id"] == C.DOC_INVOICE]
    assert "".join(c["text"] for c in page_chunks) == C.INVOICE_PAGE
    assert run.reports[C.DOC_INVOICE_UNKNOWN].reason_code == "supplier_unlinked"
    assert run.reports[C.DOC_INVOICE_OFFPAGE].reason_code == "value_not_on_page"


def test_quantity_and_unit_are_moved_out_of_a_description_and_a_leftover_digit_abstains() -> None:
    """DECISIONS 11 Oct (W3.2): a vision read that leaves "4 l" inside the unlinked line's description ships the bare
    words, with the numbers still the line's own spans; a linked line ships no description. Paired: words that still hold
    a digit after the move abstain (`description_has_number`), no draft."""
    read = json.loads(json.dumps(C.INVOICE_READ))
    read["lines"][0]["description"] = "Paneer 12 kg"
    read["lines"][1]["description"] = "Malai cream 4 l"
    d = invoice_draft(C.DOC_INVOICE, InvoiceRead.model_validate(read), ALIASES, "INR")
    assert d.body is not None
    lines = d.body["payload"]["lines"]
    assert [(ln["ingredient_id"], ln["description"]) for ln in lines] == [(C.INGREDIENT_PANEER, None), (None, "Malai cream")]
    assert [C.INVOICE_PAGE[s:e] for s, e in d.spans] == C.INVOICE_NUMBERS
    read["lines"][1]["description"] = "Malai cream 25% fat"
    page = C.INVOICE_PAGE.replace("Malai cream 4 l", "Malai cream 25% fat 4 l")
    bad = invoice_draft(C.DOC_INVOICE, InvoiceRead.model_validate({**read, "transcript": page}), ALIASES, "INR")
    assert (bad.body, bad.reason_code) == (None, "description_has_number")


def test_invoice_payload_is_the_registered_proposal_shape(run: Run) -> None:
    """core's own zod DraftsRequest (tests/tools/zod_check.mts) over the draft: 0 issues — numbers are doc-span refs,
    ids and strings as the command wants, and `based_on` [] is admitted for this workflow draftable because every
    numeric leaf is a document span (DECISIONS 11 Oct, W3.2). A bare number at a numeric leaf is refused (paired)."""
    node = shutil.which("node")
    assert node, "node is required: core-api's zod contracts check the draft"
    [d] = [b for p, b in run.sink.posts if p == "drafts"]
    bare = json.loads(json.dumps(d))
    bare["payload"]["lines"][0]["unit_price_minor"] = 34000
    out = subprocess.run(
        [node, str(INTEL_TESTS / "tools" / "zod_check.mts")],
        input=json.dumps({"drafts": [d, bare], "snapshots": []}),
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    issues = json.loads(out.stdout.strip().splitlines()[-1])["drafts"]
    print("zod issues:", issues)
    assert issues[0] == []
    assert "payload/lines/0/unit_price_minor" in issues[1]


# -- embeddings ------------------------------------------------------------------------------------------------------


def test_embeddings_are_768_integer_millionths_and_503_is_unavailable(run: Run) -> None:
    """Client side only (UNVERIFIED against pgvector): the 503 core gives without pgvector is a typed `unavailable`, the
    run goes on; with a sink that stores vectors, 120 chunks go as 2 batches (≤ 100) of 768 integers each."""
    assert {r.embeddings.status for k, r in run.reports.items() if k in C.DOCS or k == "messages"} == {"unavailable"}
    sink = FakeSink(vectors=True)
    chunks = [(C.vid(0x1000 + i), f"chunk {i}") for i in range(120)]
    out = asyncio.run(write_embeddings(sink, RecordedEmbedder(), chunks))
    batches = [b["embeddings"] for p, b in sink.posts if p == "embeddings:batch"]
    assert (out.status, out.inserted, [len(b) for b in batches]) == ("stored", 120, [100, 20])
    assert all(
        len(e["embedding_micro"]) == DIMENSIONS and all(isinstance(x, int) for x in e["embedding_micro"]) for b in batches for e in b
    )


# -- (4) a mapping with arithmetic is refused ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("entry", "code"),
    [
        ({"source": "Qty * Rate", "target": "line_total"}, "source_not_in_header"),
        ({"source": "Line Amount - Rate", "target": "line_discount"}, "source_not_in_header"),
        ({"source": "Line Amount", "target": "line_total", "formula": "qty * unit_price"}, "not_a_rename"),
        ({"source": "Rate", "target": "unit_price", "unit": "minor_x100"}, "not_a_rename"),
        ({"source": "Rate", "target": "rate_times_qty"}, "unknown_target"),
    ],
)
def test_a_mapping_with_arithmetic_is_refused(entry: dict[str, str], code: str) -> None:
    header = columns.read_header(C.POS_BILLS_CSV)
    with pytest.raises(columns.MappingRefused, match=code):
        columns.check_renames("pos_bills", header, [*C.EXPECTED_RENAMES, entry] if code != "unknown_target" else [entry])


def test_a_mapping_of_plain_renames_is_accepted_and_a_field_used_twice_is_refused() -> None:
    header = columns.read_header(C.POS_BILLS_CSV)
    columns.check_renames("pos_bills", header, C.EXPECTED_RENAMES)
    with pytest.raises(columns.MappingRefused, match="duplicate_target"):
        columns.check_renames("pos_bills", header, [*C.EXPECTED_RENAMES, {"source": "Remarks", "target": "qty"}])


# -- (5) map.columns sends headers only ------------------------------------------------------------------------------


def _ctx() -> RunContext:
    return RunContext(run_id=C.RUN, tenant_id=C.TENANT, outlet_scope=("*",), trigger="ask", actor=C.vid(0x8), expires_at=2**40, token="")


def _router() -> LlmMimic:
    Spy.seen = []
    return LlmMimic(Spy(model="recorded/router", fixtures_dir=mimic.FIXTURES_DIR), adapter="recorded")


def test_map_columns_egress_holds_headers_only() -> None:
    """Every request the router received carries exactly {header, headers}, every string a header cell, and 0 of the
    file's data cells anywhere in the request. The suggestion is the recorded answers (hand copy)."""
    rows = [r.split(",") for r in C.POS_BILLS_CSV.strip().splitlines()]
    header, cells = rows[0], {c for r in rows[1:] for c in r if c}
    s = asyncio.run(columns.suggest(_ctx(), _router(), "pos_bills", columns.read_header(C.POS_BILLS_CSV)))
    assert len(Spy.seen) == len(header)
    wires = [
        json.dumps([c.model_dump(mode="json") for c in r.contents], ensure_ascii=False) + str(r.config.system_instruction) for r in Spy.seen
    ]
    leaked = sum(1 for w in wires for c in cells if c in w)
    print(f"router requests {len(Spy.seen)}, data cells {len(cells)}, cells on the wire {leaked}")
    assert leaked == 0
    for req in Spy.seen:
        payload = json.loads((req.contents[-1].parts or [types.Part()])[0].text or "")
        assert set(payload) == {"header", "headers"}
        assert payload["header"] in header and payload["headers"] == header
    assert (s.entries, s.unmapped, s.ignored) == (C.EXPECTED_RENAMES, C.EXPECTED_UNMAPPED, [])


def test_a_planted_sample_is_refused_before_any_question() -> None:
    """A headerless export (its first row is data) is refused with 0 router requests; so is a sample field in the
    decision state (the T-081 egress allow-list). Paired accept: the real header passes the same check."""
    data_first = C.POS_BILLS_CSV.split("\n", 1)[1]
    with pytest.raises(columns.SampleRefused):
        asyncio.run(columns.suggest(_ctx(), _router(), "pos_bills", columns.read_header(data_first)))
    assert Spy.seen == []
    for planted in (["Bill No", "9876543210"], ["Bill No", "owner@example.test"], ["Bill No", "180.00"]):
        with pytest.raises(columns.SampleRefused):
            columns.check_header(planted)
    columns.check_header(columns.read_header(C.POS_BILLS_CSV))
    q = MAP_COLUMNS["pos_bills"]
    with pytest.raises(EgressRefused, match="not_allow_listed"):
        egress_payload(q, {"header": "Qty", "headers": ("Qty",), "sample": ("2",)})


# -- traces carry no untrusted text ----------------------------------------------------------------------------------


def _untrusted_tokens() -> set[str]:
    texts = [*C.DOCS.values(), *(b for _, b in C.MESSAGES), C.INVOICE_PAGE, C.INVOICE_UNKNOWN_READ["transcript"]]
    for cl in [*C.SUPPLY_CLAIMS, *C.GREENS_CLAIMS, *C.INJECT_MIXED_CLAIMS]:
        texts += [v for v in cl.values() if isinstance(v, str)]
    for call in (C.INJECT_CALL, C.INJECT_MIXED_CALL, C.MSG_INJECT_CALL, C.INVOICE_INJECT_CALL):
        texts += [call["name"], json.dumps(call["args"])]
    return {t for text in texts for t in re.findall(r"[A-Za-z0-9_.:/@-]{5,}", text)}


#: Hand list of the closed codes a T-056 trace may carry (agents, steps, statuses, refusal codes). Anything else in a
#: payload must be an id or a count.
TRACE_CODES = {
    "extractor",
    "vision",
    "embeddings",
    "messages",
    "proposed",
    "abstained",
    "stored",
    "unavailable",
    "none",
    "tool_call_attempted",
    "response_not_schema",
    "ai_budget_cap",
    "supplier_unlinked",
    "value_not_on_page",
    "invoice_no_not_on_page",
    "invoice_date_unreadable",
    "amount_unreadable",
    "unit_unreadable",
}
ID_OR_COUNT = re.compile(r"^((doc|msg):)?[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^[0-9]+$")


def test_traces_carry_no_untrusted_text(run: Run) -> None:
    """Every trace event the run sent to core carries only ids, counts and codes from the hand list — so no quote, name,
    predicate, transcript or model text — and none of the sources' or models' tokens (canaries such as CANARY-INV-0D9E
    and the invoice number included) appears in any value that is not one of those codes. At least one event per
    source was traced."""
    events = [e for req in run.traces_sent for e in req.events]
    values = [
        v for e in events if isinstance(e.payload, dict) for raw in e.payload.values() for v in (raw if isinstance(raw, list) else [raw])
    ]
    texts = [str(getattr(v, "root", v)) for v in values]
    other = sorted({v for v in texts if v not in TRACE_CODES and not ID_OR_COUNT.match(v)})
    tokens = _untrusted_tokens()
    hits = sorted({t for t in tokens for v in texts if v not in TRACE_CODES and t in v})
    print(f"trace events {len(events)}, payload values {len(texts)}, untrusted tokens {len(tokens)}, unlisted values {other}, hits {hits}")
    assert len(events) >= len(C.DOCS) + len(C.MESSAGES) + len(C.IMAGES)
    assert {"CANARY-INV-0D9E", "INV-1042", "propose_purchasing_po_create", "delivers"} <= tokens
    assert other == [] and hits == []


def test_vision_request_carries_the_image_only() -> None:
    req = vision_request(RecordedLlm(model="recorded/vision", fixtures_dir=FIXTURES_DIR), C.IMAGES[C.DOC_INVOICE], "image/png")
    [part] = req.contents[0].parts or []
    assert part.inline_data is not None and part.text is None


# -- R-C F5: invoice numbers are whole tokens; the unit follows its quantity ------------------------------------------

#: Hand-made page and reads: the line prints 12 ml at 320.00 with 16.00 tax.
F5_PAGE = C.INVOICE_PAGE.replace("Malai cream 4 l 180.00 36.00", "Malai cream 12 ml 320.00 16.00")


def _malai(qty: str, unit: str, price: str, tax: str) -> InvoiceDraft:
    read = json.loads(json.dumps(C.INVOICE_READ))
    read["transcript"] = F5_PAGE
    read["lines"][1] = {"description": "Malai cream", "qty": qty, "unit": unit, "unit_price": price, "tax": tax}
    return invoice_draft(C.DOC_INVOICE, InvoiceRead.model_validate(read), ALIASES, "INR")


@pytest.mark.parametrize(
    "qty,unit,price,tax,reason",
    [
        # The reviewer's read: every value is a substring of the printed line ("2" in "12", "l" in "ml" and "Malai").
        ("2", "l", "20.00", "6.00", "value_not_on_page"),
        ("12", "l", "320.00", "16.00", "unit_unreadable"),
        ("12", "ml", "20.00", "16.00", "value_not_on_page"),
        ("12", "ml", "320.00", "6.00", "value_not_on_page"),
    ],
)
def test_a_value_inside_another_number_or_a_unit_not_after_its_quantity_abstains(
    qty: str, unit: str, price: str, tax: str, reason: str
) -> None:
    d = _malai(qty, unit, price, tax)
    assert (d.body, d.reason_code) == (None, reason)


def test_the_true_read_of_that_line_is_a_draft_of_whole_tokens() -> None:
    """Paired accept: 12 ml at 320.00, tax 16.00 — each span is exactly the printed token."""
    d = _malai("12", "ml", "320.00", "16.00")
    assert d.body is not None, d.reason_code
    assert [F5_PAGE[s:e] for s, e in d.spans] == ["12", "340.00", "204.00", "12", "320.00", "16.00"]
    assert d.body["payload"]["lines"][1]["unit"] == "ml"


# -- R-C F6: quarantined calls spend the run's budget; provider errors leave as codes ---------------------------------


class _Echo(RecordedLlm):
    """A stand-in provider (no fixtures): answers every extraction with no claims, or raises a provider-style error that
    quotes a secret and the prompt."""

    raise_with: str | None = None
    #: What the provider reports it counted (None: no count, as a recorded replay).
    usage: types.GenerateContentResponseUsageMetadata | None = None
    calls: ClassVar[int] = 0

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        _Echo.calls += 1
        if self.raise_with is not None:
            raise RuntimeError(self.raise_with)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text='{"claims": []}')]), usage_metadata=self.usage)


def _ingest_with(llm: RecordedLlm, budget: Budget) -> tuple[Ingest, RunState, FakeSink, list[InternalTracesBatchRequest]]:
    state, sent = new_state()
    state.budget = budget
    sink = FakeSink()
    ing = Ingest(state=state, sink=sink, extract_llm=llm, vision_llm=llm, embedder=RecordedEmbedder(), aliases=ALIASES)
    return ing, state, sink, sent


def test_a_one_megabyte_document_stops_at_the_budget() -> None:
    """1 MB of text = 525 chunks of 2000 characters (hand: 1,048,576 / 2000 → 524 full + 1 partial, every cut at a line
    break of the 2000-character lines below). With a budget of 3 model calls, exactly 3 extractions run, the rest of the
    document is one `ai_budget_cap` abstain, and every chunk is still stored (in batches of at most 500)."""
    line = ("Steady Dairy note " * 111)[:1999] + "\n"
    text = (line * 525)[: 1024 * 1024]
    _Echo.calls = 0
    ing, state, sink, _ = _ingest_with(_Echo(model="echo/extract"), Budget(max_model_calls=3))
    report = asyncio.run(ing.document(C.vid(0xD8), text))
    batches = [len(b["chunks"]) for p, b in sink.posts if p == "chunks:batch"]
    print(f"1 MB: chunks {report.chunks} in batches {batches}; model calls {_Echo.calls}; refused {report.refused}")
    assert report.chunks == 525 and batches == [500, 25]
    assert _Echo.calls == 3 and state.budget.model_calls == 3
    assert report.refused == {"ai_budget_cap": 1}
    # Paired: a budget that covers the document reads every chunk.
    _Echo.calls = 0
    ing, _, _, _ = _ingest_with(_Echo(model="echo/extract"), Budget(max_model_calls=525))
    assert asyncio.run(ing.document(C.vid(0xD8), text)).refused == {} and _Echo.calls == 525


def test_a_provider_error_never_surfaces_its_text() -> None:
    secret = "sk-live-NOT-A-REAL-KEY-7731"
    raw = f"400 Bad Request: invalid key {secret} for prompt 'Steady Dairy delivers paneer'"
    llm = _Echo(model="echo/extract", raise_with=raw)
    state, _ = new_state()
    with pytest.raises(quarantine.ModelUnavailable) as e:
        asyncio.run(quarantine.call(llm, extract_request(llm, C.SUPPLY_TEXT), ExtractedClaims, state))
    assert e.value.code == "model_error:RuntimeError" and str(e.value) == "model_error:RuntimeError"
    assert e.value.__cause__ is None and e.value.__context__ is None
    ing, _, _, sent = _ingest_with(llm, Budget(max_model_calls=5))
    report = asyncio.run(ing.document(C.vid(0xD7), C.SUPPLY_TEXT))
    asyncio.run(ing.state.traces.flush())
    dumped = json.dumps([e.model_dump(mode="json") for req in sent for e in req.events]) + repr(report)
    assert report.refused == {"model_error:RuntimeError": 1}
    assert secret not in dumped and "Bad Request" not in dumped and "Steady Dairy delivers" not in dumped


def test_a_spent_budget_makes_no_call() -> None:
    _Echo.calls = 0
    llm = _Echo(model="echo/extract")
    state, _ = new_state()
    state.budget = Budget(max_model_calls=1, model_calls=1)
    with pytest.raises(quarantine.ModelUnavailable) as e:
        asyncio.run(quarantine.call(llm, extract_request(llm, C.SUPPLY_TEXT), ExtractedClaims, state))
    assert e.value.code == "ai_budget_cap" and _Echo.calls == 0 and state.budget.model_calls == 1
    state.budget = Budget(max_model_calls=1)
    asyncio.run(quarantine.call(llm, extract_request(llm, C.SUPPLY_TEXT), ExtractedClaims, state))
    assert _Echo.calls == 1 and state.budget.model_calls == 1


def test_every_quarantined_call_that_reaches_the_provider_is_one_spend_row() -> None:
    """C1 S2-6 (R47, 04 §10): charged on the run's meter buffer as `extract` or `vision` (never the meter's own role), at
    the provider's count when it reports one (thinking billed as output), else the request-size estimate; a provider error
    is still one row; a spent budget makes no call and no row. Rows = calls that reached the provider (_Echo.calls)."""
    posted: list[InternalSpendRequest] = []

    async def sink(req: InternalSpendRequest) -> object:
        posted.append(req)
        return None

    buffer = SpendBuffer(sink, "INR")
    state, _ = new_state()
    state.meter = Meter(buffer, "reason", "gemini", "recorded/reason", None)
    _Echo.calls = 0
    counted = types.GenerateContentResponseUsageMetadata(prompt_token_count=120, candidates_token_count=30, thoughts_token_count=5)
    extract = extract_request(_Echo(model="echo/extract"), C.SUPPLY_TEXT)
    asyncio.run(quarantine.call(_Echo(model="echo/extract", usage=counted), extract, ExtractedClaims, state))
    asyncio.run(quarantine.call(_Echo(model="echo/vision"), extract, ExtractedClaims, state, role="vision"))
    with pytest.raises(quarantine.ModelUnavailable):
        asyncio.run(quarantine.call(_Echo(model="echo/extract", raise_with="boom"), extract, ExtractedClaims, state))
    state.budget = Budget(max_model_calls=3, model_calls=3)
    with pytest.raises(quarantine.ModelUnavailable, match="ai_budget_cap"):
        asyncio.run(quarantine.call(_Echo(model="echo/extract"), extract, ExtractedClaims, state))
    asyncio.run(buffer.flush())
    rows = [(e["role"], e["model_id"], e["input_tokens"], e["output_tokens"]) for r in posted for e in r.model_dump(mode="json")["entries"]]
    print(f"calls {_Echo.calls}; rows {rows}")
    estimate = estimate_input_tokens(extract)
    assert _Echo.calls == 3 and estimate > 0
    assert rows == [("extract", "echo/extract", 120, 35), ("vision", "echo/vision", estimate, 0), ("extract", "echo/extract", estimate, 0)]


# -- R-C F10: a claim's quote names its subject and object --------------------------------------------------------------

F10_SOURCE = "Note: X supplies paneer to the Indiranagar kitchen. The order is due on Friday."


@pytest.mark.parametrize(
    "claim",
    [
        {"quote": "the", "predicate": "supplies", "subject": "X", "object": "paneer"},
        # Names its subject, but 10 characters cannot state who supplies what.
        {"quote": "X supplies", "predicate": "supplies", "subject": "X", "object": None},
        {"quote": "the Indiranagar kitchen", "predicate": "supplies", "subject": "X", "object": "paneer"},
        {"quote": "X supplies paneer to the Indiranagar kitchen", "predicate": "supplies", "subject": "Y", "object": "paneer"},
        {"quote": "X supplies paneer to the Indiranagar kitchen", "predicate": "supplies", "subject": "X", "object": "pan"},
    ],
)
def test_a_claim_whose_quote_does_not_carry_it_is_dropped(claim: dict[str, Any]) -> None:
    kept = claims_mod.claim_rows([ExtractedClaim(**claim)], F10_SOURCE, chunk_id=C.vid(0xC9), message_id=None, aliases=ALIASES)
    assert (kept.rows, kept.dropped) == ([], 1)


def test_a_claim_whose_quote_names_both_is_kept_after_normalising() -> None:
    claim = ExtractedClaim(quote="X supplies paneer to the Indiranagar kitchen", predicate="supplies", subject=" x ", object="PANEER")
    kept = claims_mod.claim_rows([claim], F10_SOURCE, chunk_id=C.vid(0xC9), message_id=None, aliases=ALIASES)
    assert kept.dropped == 0 and [(r["span_start"], r["quote"]) for r in kept.rows] == [(6, "X supplies paneer to the Indiranagar kitchen")]


# -- T-127 (T-125's open items 2 and 3): a live extraction falls back to THIS package's recorded fixtures, and says so -------

LIVE_ROLES = {
    "items": [
        {
            "role": "extract",
            "model_id": "gemini-3.5-flash-lite",
            "provider": "gemini",
            "location": "global",
            "probed_at": None,
            "updated_at": "2026-10-10T00:00:00Z",
            "input_price_per_mtok_minor": 2_700,
            "output_price_per_mtok_minor": 22_500,
            "price_currency": "INR",
        },
    ]
}


class _Roles:
    async def model_roles(self) -> PlatformModelRoles:
        return PlatformModelRoles.model_validate(LIVE_ROLES)


def _live(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Live mode with a fake key; the provider planted in place of the network answers every call 429 (free tier), so each
    model call is two requests: the try and its one retry (llm/providers.retrying, C3)."""
    calls: list[str] = []

    async def rate_limited(_llm: Gemini, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        calls.append(llm_request.model or "")
        raise ClientError(429, {"error": {"code": 429, "message": "PLANTED quota exceeded", "status": "RESOURCE_EXHAUSTED"}})
        yield LlmResponse()  # pragma: no cover — an async generator

    monkeypatch.setattr(Gemini, "generate_content_async", rate_limited)
    return calls


def _routes(sent: list[InternalTracesBatchRequest]) -> list[tuple[str, dict[str, Any]]]:
    """(actor, payload) of every `route` event the run flushed."""
    events = [e.model_dump(mode="json") for req in sent for e in req.events]
    return [(e["actor"], e["payload"]) for e in events if e["kind"] == "route"]


def _rows_and_routes(llm: Any) -> tuple[list[dict[str, Any]], list[tuple[str, dict[str, Any]]], Report]:
    state, sent = new_state()
    sink = FakeSink()
    ing = Ingest(
        state=state,
        sink=sink,
        extract_llm=llm,
        vision_llm=llm,
        embedder=RecordedEmbedder(),
        aliases=ALIASES,
        actor="specialist:inventory_purchasing",
    )

    async def go() -> Report:
        out = await ing.document(C.DOC_SUPPLY, C.SUPPLY_TEXT)
        await state.traces.flush()
        return out

    report = asyncio.run(go())
    return sink.rows("claims:batch"), _routes(sent), report


def test_a_live_extraction_that_fails_is_served_from_the_ingest_fixtures_and_traced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The recorded claims of the supply document (this package's fixtures, read by recorded mode) are what a rate-limited live
    run stores, and its one call is traced `recorded-fallback` under the run's actor. Paired: recorded mode traces no path."""
    recorded_rows, recorded_routes, _ = _rows_and_routes(RecordedLlm(model="recorded/extract", fixtures_dir=FIXTURES_DIR))
    assert recorded_rows and recorded_routes == [], "recorded mode: claims, and no path label (traces unchanged)"
    calls = _live(tmp_path, monkeypatch)
    cfg = load_config(env={"MUNIM_MODEL_MODE": "live", "GEMINI_API_KEY": GEMINI_KEY}, run_dir=tmp_path)
    llm = asyncio.run(quarantine.quarantined_llm("extract", cfg, _Roles()))
    assert isinstance(llm, TimedGemini) and llm.fallback is not None and llm.fallback.fixtures_dir == FIXTURES_DIR
    rows, routes, report = _rows_and_routes(llm)
    assert rows == recorded_rows and report.refused == {}
    assert routes == [("specialist:inventory_purchasing", {"model_path": "recorded-fallback"})] and len(calls) == 2


def test_a_live_extraction_with_no_fixture_abstains_as_before_and_is_traced_abstained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _live(tmp_path, monkeypatch)
    cfg = load_config(env={"MUNIM_MODEL_MODE": "live", "GEMINI_API_KEY": GEMINI_KEY}, run_dir=tmp_path)
    llm = asyncio.run(quarantine.quarantined_llm("extract", cfg, _Roles()))
    state, sent = new_state()
    with pytest.raises(quarantine.ModelUnavailable) as e:
        asyncio.run(quarantine.call(llm, extract_request(llm, "A note nobody recorded: X supplies paneer."), ExtractedClaims, state))
    asyncio.run(state.traces.flush())
    assert e.value.code == "model_error:ClientError" and len(calls) == 2
    assert _routes(sent) == [("manager", {"model_path": "abstained"})]

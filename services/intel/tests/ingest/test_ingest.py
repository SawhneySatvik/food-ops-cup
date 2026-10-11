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
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from munim_intel.contracts_gen.models import InternalBatchResponse, InternalDraftsResponse, InternalTracesBatchRequest
from munim_intel.decide import mimic
from munim_intel.decide.mimic import LlmMimic
from munim_intel.decide.port import EgressRefused, egress_payload
from munim_intel.decide.questions import MAP_COLUMNS
from munim_intel.ingest import columns, quarantine
from munim_intel.ingest.claims import ExtractedClaims, extract_request
from munim_intel.ingest.embed import DIMENSIONS, RecordedEmbedder, write_embeddings
from munim_intel.ingest.invoice import COMMAND, vision_request
from munim_intel.ingest.link import Alias, AliasTable, normalize_alias
from munim_intel.ingest.pipeline import Ingest, Report
from munim_intel.ingest.quarantine import FIXTURES_DIR, QuarantineBreach, tool_count
from munim_intel.ingest.sink import BATCHES
from munim_intel.llm.recorded import RecordedLlm
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.internal_client import CoreError
from munim_intel.runtime.state import RunState
from munim_intel.trace.buffer import TraceBuffer

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
    assert subjects["Steady Dairy"] == C.vid(0xA1) and subjects["Tomatoes wil"] == C.vid(0xA3)


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


def test_any_extraction_taints_the_run_even_when_it_fails() -> None:
    """Taint is set before the call: a clean document taints, and so does a call that never returns (missing fixture)."""
    for text in (C.SUPPLY_TEXT, "a document with no recorded answer"):
        state, _ = new_state()
        assert state.tainted is False
        ing = ingest(state, FakeSink())
        try:
            asyncio.run(ing.document(C.vid(0xD9), text))
        except Exception as e:  # noqa: BLE001 — the missing fixture is the point
            assert type(e).__name__ == "RecordedFixtureMissing"
        assert state.tainted is True, text[:20]


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


def test_invoice_payload_is_the_registered_proposal_shape(run: Run) -> None:
    """core's own zod DraftsRequest (tests/tools/zod_check.mts) over the draft: the payload has 0 issues — numbers are
    refs, ids and strings as the command wants. `based_on` is the one issue: a document-sourced draft cites no snapshot
    cell and core requires ≥ 1 (reported to i-1). A bare number at a numeric leaf is refused (paired)."""
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
    assert issues[0] == ["based_on"]
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

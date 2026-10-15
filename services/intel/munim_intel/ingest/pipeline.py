"""The ingestion runs: a document, a batch of chat messages, an invoice image. Each takes its input as arguments (intel
has no route to fetch a document's bytes or a message's body; the caller hands them over) and writes only through the
sink — chunks, then claims, then embeddings; for an invoice, its transcript's chunks and then the draft.

Traces carry ids, counts and codes only (rule 8; ADR-014 §6.4 rule 5): never a quote, a name, a transcript or any
other text that came from the source or from the model.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from google.adk.models import BaseLlm

from munim_intel.ingest import claims as claims_mod
from munim_intel.ingest.embed import Embedder, EmbedOutcome, write_embeddings
from munim_intel.ingest.invoice import invoice_draft, read_invoice
from munim_intel.ingest.link import AliasTable
from munim_intel.ingest.quarantine import ModelUnavailable, QuarantineBreach, Unreadable
from munim_intel.ingest.sink import IngestSink
from munim_intel.mapping import uuid7_ms
from munim_intel.runtime.state import RunState, check_actor
from munim_intel.tools.generated import uuid7


def _doc_chunks(document_id: str, text: str) -> list[dict[str, Any]]:
    ts = uuid7_ms(document_id)
    return [
        {
            "id": uuid7(ts, f"{document_id}/chunk/{seq}"),
            "document_id": document_id,
            "message_id": None,
            "seq": seq,
            "char_start": at,
            "text": t,
        }
        for seq, (at, t) in enumerate(claims_mod.chunk_text(text))
    ]


@dataclass
class Report:
    chunks: int = 0
    claims: int = 0
    #: Claims the extractor returned whose quote is not the source's text.
    dropped: int = 0
    #: Sources whose extraction was refused: the model tried a function call (`tool_call_attempted`), answered outside
    #: the schema, failed (`model_error:<class>`) or was not called because the run's budget is spent (`ai_budget_cap`).
    #: Nothing from such a source becomes a claim, and no call is executed.
    refused: dict[str, int] = field(default_factory=dict)
    embeddings: EmbedOutcome = EmbedOutcome("none")
    draft_id: str | None = None
    draft_status: str | None = None
    reason_code: str | None = None


@dataclass
class Ingest:
    state: RunState
    sink: IngestSink
    extract_llm: BaseLlm
    vision_llm: BaseLlm
    embedder: Embedder
    aliases: AliasTable
    actor: str = "manager"

    def __post_init__(self) -> None:
        check_actor(self.actor)

    async def _trace(self, kind: str, **labels: str) -> None:
        payload: dict[str, str | list[str]] = dict(labels)
        await self.state.traces.append(kind, self.actor, payload)

    async def _extract(self, agent: str, source: str, text: str, report: Report) -> list[claims_mod.ExtractedClaim] | None:
        await self._trace("subagent_start", agent=agent, source=source)
        try:
            out = await claims_mod.extract(self.extract_llm, text, self.state, self.actor)
        except (QuarantineBreach, ModelUnavailable, Unreadable) as e:
            code = "response_not_schema" if isinstance(e, Unreadable) else e.code
            report.refused[code] = report.refused.get(code, 0) + 1
            await self._trace("abstain", agent=agent, source=source, reason_code=code)
            return None
        return out

    async def document(self, document_id: str, text: str) -> Report:
        report = Report()
        chunks = _doc_chunks(document_id, text)
        if not chunks:
            return report
        report.chunks = await self._chunks(chunks)
        rows: list[dict[str, Any]] = []
        for c in chunks:
            if self.state.budget.models_exhausted():
                # The rest of the document is not read: one abstain, not one per chunk (a long document has hundreds).
                report.refused["ai_budget_cap"] = report.refused.get("ai_budget_cap", 0) + 1
                await self._trace("abstain", agent="extractor", source=f"doc:{document_id}", reason_code="ai_budget_cap")
                break
            got = await self._extract("extractor", f"doc:{document_id}", c["text"], report)
            if got is None:
                continue
            kept = claims_mod.claim_rows(got, c["text"], chunk_id=c["id"], message_id=None, aliases=self.aliases)
            rows += kept.rows
            report.dropped += kept.dropped
            await self._trace(
                "subagent_end", agent="extractor", source=f"doc:{document_id}", claims=str(len(kept.rows)), dropped=str(kept.dropped)
            )
        report.claims = await self._claims(rows)
        report.embeddings = await write_embeddings(self.sink, self.embedder, [(c["id"], c["text"]) for c in chunks])
        await self._trace("tool_result", step="embeddings", source=f"doc:{document_id}", status=report.embeddings.status)
        return report

    async def messages(self, messages: Sequence[tuple[str, str]]) -> Report:
        """(message_id, body) of core.message rows. A message's claims cite the message; its chunk feeds search."""
        report = Report()
        chunks: list[dict[str, Any]] = [
            {
                "id": uuid7(uuid7_ms(mid), f"{mid}/chunk/{seq}"),
                "document_id": None,
                "message_id": mid,
                "seq": seq,
                "char_start": at,
                "text": t,
            }
            for mid, body in messages
            for seq, (at, t) in enumerate(claims_mod.chunk_text(body))
        ]
        report.chunks = await self._chunks(chunks)
        rows: list[dict[str, Any]] = []
        for mid, body in messages:
            if self.state.budget.models_exhausted():
                report.refused["ai_budget_cap"] = report.refused.get("ai_budget_cap", 0) + 1
                await self._trace("abstain", agent="extractor", source="messages", reason_code="ai_budget_cap")
                break
            got = await self._extract("extractor", f"msg:{mid}", body, report)
            if got is None:
                continue
            kept = claims_mod.claim_rows(got, body, chunk_id=None, message_id=mid, aliases=self.aliases)
            rows += kept.rows
            report.dropped += kept.dropped
            await self._trace("subagent_end", agent="extractor", source=f"msg:{mid}", claims=str(len(kept.rows)), dropped=str(kept.dropped))
        report.claims = await self._claims(rows)
        report.embeddings = await write_embeddings(self.sink, self.embedder, [(c["id"], c["text"]) for c in chunks])
        await self._trace("tool_result", step="embeddings", source="messages", status=report.embeddings.status)
        return report

    async def _chunks(self, chunks: list[dict[str, Any]]) -> int:
        """In batches of 500 (contracts ChunksBatchRequest): a long document has more chunks than one batch takes."""
        inserted = 0
        for i in range(0, len(chunks), 500):
            inserted += (await self.sink.batch("chunks:batch", {"chunks": chunks[i : i + 500]})).inserted
        return inserted

    async def _claims(self, rows: list[dict[str, Any]]) -> int:
        inserted = 0
        for i in range(0, len(rows), 500):
            inserted += (await self.sink.batch("claims:batch", {"claims": rows[i : i + 500]})).inserted
        return inserted

    async def invoice(self, document_id: str, image: bytes, mime_type: str, currency: str) -> Report:
        report = Report()
        source = f"doc:{document_id}"
        await self._trace("subagent_start", agent="vision", source=source)
        try:
            read = await read_invoice(self.vision_llm, image, mime_type, self.state, self.actor)
        except (QuarantineBreach, ModelUnavailable, Unreadable) as e:
            code = "response_not_schema" if isinstance(e, Unreadable) else e.code
            report.refused[code] = 1
            report.reason_code = code
            await self._trace("abstain", agent="vision", source=source, reason_code=code)
            return report
        draft = invoice_draft(document_id, read, self.aliases, currency)
        if draft.body is None:
            report.reason_code = draft.reason_code
            await self._trace("abstain", agent="vision", source=source, reason_code=draft.reason_code or "abstained")
            return report
        # The draft's spans resolve against the document's chunks, so they are stored first.
        chunks = _doc_chunks(document_id, read.transcript)
        report.chunks = await self._chunks(chunks)
        r = await self.sink.draft(draft.body)
        report.draft_id, report.draft_status = r.draft_id.root, r.status
        report.reason_code = r.reason_code.root if r.reason_code else None
        await self._trace("draft", agent="vision", source=source, draft_id=report.draft_id, status=r.status)
        return report

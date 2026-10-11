"""compile_wiki: entities -> pages -> core's `wiki:batch` (R25: intel never writes Postgres).

Dirty tracking: a page is rebuilt only when its input fingerprint differs from the one recorded with the version last
stored. `state` (page id -> version + fingerprint) is the caller's to keep between runs: core has no read route for it
yet, and without it every page is first-time (version 1; core answers `conflict` for a page already at version 1 with other
content). Ids derive from the entity and the content, never the run, so a retry after a lost response is `existing`.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from munim_intel.contracts_gen.models import InternalWikiBatchRequest, InternalWikiBatchResponse
from munim_intel.runtime.internal_client import InternalClient
from munim_intel.tools.generated import uuid7
from munim_intel.tools.grammar import typed_bracket
from munim_intel.wiki import pages as P
from munim_intel.wiki.prose import Narrator, expand, split_sentences

BATCH = 50  # contracts: WikiBatchRequest max pages


@dataclass(frozen=True)
class PageState:
    version: int
    fingerprint: str


@dataclass
class Report:
    pages: int = 0  # entities of a page kind
    unchanged: int = 0
    posted: int = 0
    stored: int = 0
    existing: int = 0
    abstained: int = 0
    dropped: int = 0  # sentences dropped before posting


class WikiSink(Protocol):
    async def post(self, req: InternalWikiBatchRequest) -> InternalWikiBatchResponse: ...


class CoreWikiSink:
    def __init__(self, client: InternalClient) -> None:
        self._client = client

    async def post(self, req: InternalWikiBatchRequest) -> InternalWikiBatchResponse:
        return await self._client.write_wiki(req)


def page_id(entity_id: str) -> str:
    return uuid7(int(entity_id.replace("-", "")[:12], 16), f"wiki:{entity_id}")


def _page(e: P.EntityIn, prior: PageState | None, body: list[dict[str, object]]) -> dict[str, Any]:
    pid = page_id(e.id)
    version = (prior.version if prior else 0) + 1
    digest = hashlib.sha256(repr(body).encode()).hexdigest()
    return {
        "page_id": pid,
        "entity_id": e.id,
        "kind": e.kind,
        "slug": f"{e.kind}-{e.id}",
        "title": P.title(e),
        "version_id": uuid7(int(pid.replace("-", "")[:12], 16), f"wiki:{pid}:{version}:{digest}"),
        "version": version,
        "body": body,
    }


async def _body(e: P.EntityIn, narrator: Narrator | None, report: Report) -> tuple[list[dict[str, object]], bool]:
    """(body, used_model). Model sentences first, then the template sentences whose refs they did not already cite."""
    allowed = P.allowed_refs(e)
    template, _ = P.segments(P.template_sentences(e), allowed)  # code-written: a drop here is a bug, so it is not counted
    if narrator is None:
        return template, False
    table = P.handles(e)
    said = split_sentences(await narrator.prose(e))
    # A ref the model typed itself (⟨…⟩) is never kept, even one this page minted: refs come only from its handles.
    raw = [expand(s, table) for s in said if not typed_bracket(s)]
    model, dropped = P.segments(raw, allowed)
    report.dropped += dropped + len(said) - len(raw)
    if not model:
        return template, False
    cited = {r for s in model for r in s["refs"]}  # type: ignore[attr-defined]
    rest = [s for s in template if not set(s["refs"]) <= cited]  # type: ignore[call-overload]
    return model + rest, True


async def compile_wiki(
    entities: Sequence[P.EntityIn], state: dict[str, PageState], sink: WikiSink, *, narrator: Narrator | None = None
) -> Report:
    """Posts the dirty pages and updates `state` for every page core stored or already held."""
    report = Report()
    todo: list[tuple[P.EntityIn, str, dict[str, Any], bool]] = []
    for e in entities:
        if e.kind not in P.KINDS:
            continue
        report.pages += 1
        fp = P.fingerprint(e)
        prior = state.get(page_id(e.id))
        if prior and prior.fingerprint == fp:
            report.unchanged += 1
            continue
        body, used_model = await _body(e, narrator, report)
        if not body:  # an empty body passes core's validator and would store an empty version
            continue
        todo.append((e, fp, _page(e, prior, body), used_model))

    async def send(batch: list[tuple[P.EntityIn, str, dict[str, Any], bool]]) -> list[tuple[P.EntityIn, str, dict[str, Any], bool]]:
        """Posts; returns the model-written pages core abstained (they get one template-only retry)."""
        retry: list[tuple[P.EntityIn, str, dict[str, Any], bool]] = []
        for i in range(0, len(batch), BATCH):
            chunk = batch[i : i + BATCH]
            res = await sink.post(InternalWikiBatchRequest.model_validate({"pages": [c[2] for c in chunk]}))
            report.posted += len(chunk)
            for item, out in zip(chunk, res.pages, strict=True):
                if out.status == "abstained":
                    report.abstained += 1
                    if item[3]:
                        retry.append(item)
                    continue
                if out.status == "stored":
                    report.stored += 1
                else:
                    report.existing += 1
                state[item[2]["page_id"]] = PageState(item[2]["version"], item[1])
        return retry

    retry = await send(todo)
    redo = []
    for e, fp, page, _ in retry:
        report.abstained -= 1  # counted again only if the template page is refused too
        body, _ = P.segments(P.template_sentences(e), P.allowed_refs(e))
        redo.append((e, fp, _page(e, state.get(page["page_id"]), body), False))
    await send(redo)
    return report

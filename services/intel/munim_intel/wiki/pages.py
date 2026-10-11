"""Page inputs, template sentences, the drop rule and the input fingerprint (04 §4: cite-or-abstain, no free digits).

Core abstains a whole page when any one sentence fails its validator, so the drop rule runs here, per sentence, before
posting: a sentence stays only if every `⟨…⟩` token in it is one this page minted, there is at least one, nothing outside
the tokens is a digit, a brace or a quotation mark, and it passes core's number grammar (tools/grammar.py: number words,
magnitude suffixes after a ref, R-E 1-A) — so one bad sentence costs only itself. `refs[]` is computed from the text.
A title is shown text too: it passes the same grammar or falls back to the kind.
The prose never contains untrusted text: claims and neighbours are cited by id and rendered by the ref, never quoted.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

from munim_intel.tools.grammar import check_grammar

KINDS = ("supplier", "ingredient", "item", "outlet")
#: intel.entity.kind CHECK; a neighbour's kind outside it reads as "record" (the value is a graph row, not code).
ENTITY_KINDS = frozenset({"business", "outlet", "brand", "channel", "item", "ingredient", "supplier", "person", "customer", "day", "other"})
MAX_PER_SOURCE = 20  # a page stays far below the body cap of 200 segments

_TOKEN = re.compile(r"⟨[^⟩]*⟩")
_SNAP = re.compile(r"^⟨(snap:[0-9a-f-]{36})·\d+·[a-z_][a-z0-9_]*⟩$")
_CITE = re.compile(r"^⟨cite:(row:[a-z_]+\.[a-z_]+:[0-9a-f-]{36}|(?:doc|msg|claim|snapshot):[0-9a-f-]{36})(?:·\d+-\d+)?⟩$")
_QUOTES = set("\"“”„‟«»‹›「」『』'‘’‚`")


@dataclass(frozen=True)
class ClaimIn:
    id: str


@dataclass(frozen=True)
class Neighbour:
    entity_id: str
    kind: str


@dataclass(frozen=True)
class CellIn:
    """A snapshot cell. `key` and `value` fingerprint it (the snapshot id changes on every mint; the value does not);
    `phrase` is code-written lead-in prose, digit-free."""

    ref: str
    key: str
    value: str | int | None
    phrase: str


@dataclass(frozen=True)
class EntityIn:
    id: str
    kind: str
    name: str
    claims: tuple[ClaimIn, ...] = ()
    neighbours: tuple[Neighbour, ...] = ()
    cells: tuple[CellIn, ...] = ()


def claim_ref(claim_id: str) -> str:
    return f"⟨cite:claim:{claim_id}⟩"


def entity_ref(entity_id: str) -> str:
    return f"⟨cite:row:intel.entity:{entity_id}⟩"


def _claims(e: EntityIn) -> list[ClaimIn]:
    return sorted(e.claims, key=lambda c: c.id)[:MAX_PER_SOURCE]


def _neighbours(e: EntityIn) -> list[Neighbour]:
    return sorted(e.neighbours, key=lambda n: n.entity_id)[:MAX_PER_SOURCE]


def _cells(e: EntityIn) -> list[CellIn]:
    return sorted(e.cells, key=lambda c: c.key)[:MAX_PER_SOURCE]


def handles(e: EntityIn) -> dict[str, str]:
    """Handle -> canonical ref for what the model may cite: {C1} claims, {N1} neighbours, {K1} cells."""
    out: dict[str, str] = {}
    for i, c in enumerate(_claims(e), 1):
        out[f"C{i}"] = claim_ref(c.id)
    for i, n in enumerate(_neighbours(e), 1):
        out[f"N{i}"] = entity_ref(n.entity_id)
    for i, k in enumerate(_cells(e), 1):
        out[f"K{i}"] = k.ref
    return out


def template_sentences(e: EntityIn) -> list[str]:
    out = [f"{k.phrase.rstrip('. ')} {k.ref}." for k in _cells(e)]
    out += [f"The records hold a claim about this {e.kind}: {claim_ref(c.id)}." for c in _claims(e)]
    for n in _neighbours(e):
        out.append(f"This {e.kind} is linked to the {n.kind if n.kind in ENTITY_KINDS else 'record'} {entity_ref(n.entity_id)}.")
    return out


def keep(sentence: str, allowed: set[str]) -> list[str] | None:
    """The sentence's RefIds when it passes the drop rule, else None."""
    tokens = _TOKEN.findall(sentence)
    if not tokens or any(t not in allowed for t in tokens):
        return None
    rest = _TOKEN.sub(" ", sentence)
    if any(ch.isnumeric() or ch.isdigit() or ch in "{}⟨⟩%#₹$" or ch in _QUOTES for ch in rest):
        return None
    if len(sentence) > 2000 or check_grammar(sentence) is not None:
        return None
    ids: list[str] = []
    for t in tokens:
        m = _SNAP.match(t) or _CITE.match(t)
        if m is None:
            return None
        if m.group(1) not in ids:
            ids.append(m.group(1))
    return ids


def segments(sentences: list[str], allowed: set[str]) -> tuple[list[dict[str, object]], int]:
    """(segments, dropped). Duplicates collapse."""
    out: list[dict[str, object]] = []
    seen: set[str] = set()
    dropped = 0
    for s in sentences:
        s = s.strip()
        refs = keep(s, allowed)
        if refs is None:
            dropped += 1
        elif s not in seen:
            seen.add(s)
            out.append({"text": s, "refs": refs})
    return out, dropped


def allowed_refs(e: EntityIn) -> set[str]:
    return set(handles(e).values())


def fingerprint(e: EntityIn) -> str:
    """Over what the page says, never over what mints change: no snapshot id, run id or time. A cell is its key and value."""
    doc = {
        "kind": e.kind,
        "name": e.name,
        "claims": [c.id for c in _claims(e)],
        "neighbours": [[n.entity_id, n.kind] for n in _neighbours(e)],
        "cells": [[k.key, k.value, k.phrase] for k in _cells(e)],
    }
    return hashlib.sha256(json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


_SAFE_TITLE = re.compile(r"^[A-Za-z][A-Za-z '&.-]{0,79}$")


def title(e: EntityIn) -> str:
    """Core does not validate titles. The entity's name is shown only when it is plain letters with no number word (the
    grammar); else the kind alone."""
    return e.name if _SAFE_TITLE.match(e.name) and check_grammar(e.name) is None else e.kind.capitalize()

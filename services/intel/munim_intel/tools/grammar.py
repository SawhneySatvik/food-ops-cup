"""The number grammar, as core judges it: a port of `packages/core-domain/envelope/grammar.ts` `checkGrammar` (R-E 1-A,
1-B, 2-B). intel runs it before it posts any model prose, so one bad line falls back to its template instead of core
abstaining the whole answer, brief or page. Verdicts must equal core's on every string, rule and match included;
tests/tools/test_grammar_parity.py runs both over one probe table.

Rules, in core's order (first failure wins):
  malformed_ref     a ⟨…⟩ token that is not a well-formed ref (the contracts `Ref` pattern)
  numeric_char      any Unicode numeric character (category N*) outside a ref
  number_symbol     a percent sign (the shared list)
  magnitude_suffix  `k`, `L`, `Cr` right after a ref, not followed by a letter, mark or number (`⟩kg` is a unit)
  number_word       an English or Devanagari number word (case-folded, NFC; hyphenated compounds by their parts)
  typed_quotation   a double quote, unless it wraps one cite ref alone; a single-quote pair that is not an apostrophe
The word and symbol lists are the shared file (packages/contracts/src/shared/grammar/number-words.json).

`typed_bracket` is a separate check on what a model typed, before its handles are expanded: a model never types ⟨ or ⟩
(refs come only from handle expansion). Core does not refuse a lone bracket, so it is not part of the parity function.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from munim_intel.contracts_gen.models import Ref

WORDS_FILE = Path(__file__).resolve().parents[4] / "packages" / "contracts" / "src" / "shared" / "grammar" / "number-words.json"

#: The contracts' one ref pattern (anchored): what core's `parseRef` accepts.
_REF = re.compile(str(Ref.model_json_schema()["pattern"]))
#: Every ref-shaped token, well-formed or not (core's `anyRefTokens`).
ANY_REF = re.compile(r"⟨[^⟩]*⟩")
#: Private-use stand-ins for refs: not letters, marks or numerics, so they bound words and never match a rule.
_CITE = ""
_SNAP = ""
_DQ = '"“”„‟«»‹›「」『』'
_QUOTED_CITE = re.compile(rf"[{_DQ}]\s*{_CITE}\s*[{_DQ}]")
_OPEN_SINGLE = "'‘‚"
_CLOSE_SINGLE = "'’"
_ANY_SINGLE = "'‘’‚"


@dataclass(frozen=True)
class Violation:
    rule: str
    match: str


@cache
def _lists() -> tuple[frozenset[str], tuple[str, ...], tuple[str, ...]]:
    data = json.loads(WORDS_FILE.read_text("utf8"))
    words = frozenset(unicodedata.normalize("NFC", w).lower() for w in [*data["english_cardinals"], *data["devanagari"]])
    return words, tuple(data["symbols"]), tuple(data["magnitude_suffixes"])


def _lm(c: str) -> bool:
    return unicodedata.category(c)[0] in ("L", "M")


def _lmn(c: str) -> bool:
    return unicodedata.category(c)[0] in ("L", "M", "N")


def is_ref(token: str) -> bool:
    return _REF.fullmatch(token) is not None


def _words(s: str) -> list[str]:
    """Core's WORD: maximal runs of letters and marks, hyphen-joined runs being one compound."""
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        if not _lm(s[i]):
            i += 1
            continue
        j = i
        while True:
            while j < n and _lm(s[j]):
                j += 1
            if j + 1 < n and s[j] == "-" and _lm(s[j + 1]):
                j += 1
                continue
            break
        out.append(s[i:j])
        i = j
    return out


def _suffix(prose: str, suffixes: tuple[str, ...]) -> str | None:
    for i, c in enumerate(prose):
        if c not in (_CITE, _SNAP):
            continue
        for suf in suffixes:
            end = i + 1 + len(suf)
            if prose.startswith(suf, i + 1) and (end >= len(prose) or not _lmn(prose[end])):
                return suf
    return None


def _single_pairs(s: str) -> list[str]:
    """The contents of core's SINGLE_PAIR matches, in order (global, non-overlapping)."""
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        if s[i] in _OPEN_SINGLE and (i == 0 or not _lmn(s[i - 1])):
            j = i + 1
            while j < n and s[j] not in _ANY_SINGLE:
                j += 1
            if j > i + 1 and j < n and s[j] in _CLOSE_SINGLE and (j + 1 >= n or not _lmn(s[j + 1])):
                out.append(s[i + 1 : j])
                i = j + 1
                continue
        i += 1
    return out


def check_grammar(text: str) -> Violation | None:
    """Core's verdict on `text`: None when it passes, else the rule and the match core reports."""
    words, symbols, suffixes = _lists()
    s = unicodedata.normalize("NFC", text)
    for m in ANY_REF.finditer(s):
        if not is_ref(m.group(0)):
            return Violation("malformed_ref", m.group(0))
    prose = ANY_REF.sub(lambda m: _SNAP if m.group(0).startswith("⟨snap:") else _CITE, s)
    num = next((c for c in prose if unicodedata.category(c)[0] == "N"), None)
    if num is not None:
        return Violation("numeric_char", num)
    sym = next((x for x in symbols if x in prose), None)
    if sym is not None:
        return Violation("number_symbol", sym)
    suf = _suffix(prose, suffixes)
    if suf is not None:
        return Violation("magnitude_suffix", suf)
    for w in _words(prose):
        lw = w.lower()
        if lw in words or any(p in words for p in lw.split("-")):
            return Violation("number_word", w)
    unquoted = _QUOTED_CITE.sub(_CITE, prose)
    dq = next((c for c in unquoted if c in _DQ), None)
    if dq is not None:
        return Violation("typed_quotation", dq)
    if any(inner.strip() != _CITE for inner in _single_pairs(unquoted)):
        return Violation("typed_quotation", "'")
    return None


def reason_code(v: Violation) -> str:
    """The reason code core's validator gives the rule (validateSegments)."""
    return "unresolved_ref" if v.rule == "malformed_ref" else "number_grammar"


def typed_bracket(model_text: str) -> bool:
    """True when a model typed a ref delimiter itself (checked before any handle is expanded)."""
    return "⟨" in model_text or "⟩" in model_text


def ref_ids(text: str) -> list[str]:
    """The bare RefIds core expects in a segment's `refs[]`, for every well-formed ref in `text`, first-seen order:
    ⟨snap:<id>·r·c⟩ → snap:<id>; ⟨cite:<kind>:<id>[·span]⟩ → <kind>:<id>."""
    out: list[str] = []
    for m in ANY_REF.finditer(unicodedata.normalize("NFC", text)):
        t = m.group(0)
        if not is_ref(t):
            continue
        inner = t[1:-1]
        rid = inner.split("·")[0] if inner.startswith("snap:") else inner.removeprefix("cite:").split("·")[0]
        if rid not in out:
            out.append(rid)
    return out

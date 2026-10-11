"""The number grammar over the chooser's message prose (03-architecture §1.7; packages/core-domain/envelope/grammar.ts).

The words and symbols are the single shared list (packages/contracts/src/shared/grammar/number-words.json); this is the
matcher for prose that carries no refs at all — a note to a simulated supplier is never shown as a fact, so it may
not cite, and the only numbers in a message are the ones code renders after the note. Rules, as core's: any Unicode
numeric character (category N*: digits of every script, ½, ², Ⅻ), a percent sign, a number word (whole words, case-
folded, NFC; hyphenated compounds by their parts), a typed quotation. Magnitude suffixes apply only beside a ref, so
never here.
"""

from __future__ import annotations

import json
import re
import unicodedata
from functools import cache
from pathlib import Path

WORDS_FILE = Path(__file__).resolve().parents[4] / "packages" / "contracts" / "src" / "shared" / "grammar" / "number-words.json"

_DQ = '"“”„‟«»‹›「」『』'
_SINGLE_PAIR = re.compile(r"(?<!\w)['‘‚]([^'‘’‚]+?)['’](?!\w)")


@cache
def _lists() -> tuple[frozenset[str], tuple[str, ...]]:
    data = json.loads(WORDS_FILE.read_text("utf8"))
    words = frozenset(unicodedata.normalize("NFC", w).lower() for w in [*data["english_cardinals"], *data["devanagari"]])
    return words, tuple(data["symbols"])


def _letter(c: str) -> bool:
    return unicodedata.category(c)[0] in ("L", "M")


def _words(text: str) -> list[str]:
    out: list[str] = []
    cur = ""
    for c in text:
        if _letter(c):
            cur += c
        else:
            if cur:
                out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def violation(text: str) -> str | None:
    """The rule the prose breaks (`numeric_char`, `number_symbol`, `number_word`, `typed_quotation`), or None."""
    words, symbols = _lists()
    s = unicodedata.normalize("NFC", text)
    if any(unicodedata.category(c)[0] == "N" for c in s):
        return "numeric_char"
    if any(x in s for x in symbols):
        return "number_symbol"
    if any(w.lower() in words for w in _words(s)):
        return "number_word"
    if any(c in _DQ for c in s) or _SINGLE_PAIR.search(s):
        return "typed_quotation"
    return None

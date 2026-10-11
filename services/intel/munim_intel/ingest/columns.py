"""`map.columns` for a new import layout (ADR-014 §4.3; R28): the decision model sees each column's header text and the
other headers — never a cell value, a sample row or a file name — and picks the Munim field the column is a plain
rename of. The result is a rename suggestion for the member's mapping form (`/v1/imports/formats:propose`); units are
the member's to declare, and intel can never propose `imports.*` itself (core refuses it from every specialist).

Only the header row is ever read from a file. A header row that is really data (a headerless export) is refused before
any question is asked: a cell with digits and no letters, an `@`, or a long run of digits is a value, not a name.
"""

from __future__ import annotations

import csv
import io
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from munim_intel.decide.port import DecisionModel, answer_or_fallback
from munim_intel.decide.questions import IMPORT_FIELDS, MAP_COLUMNS
from munim_intel.runtime.context import RunContext

_DIGIT_RUN = re.compile(r"[0-9]{6,}")
ENTRY_KEYS = frozenset({"source", "target"})


class SampleRefused(Exception):
    """A header cell that is a value. The message names the column index, never the cell."""

    def __init__(self, index: int) -> None:
        super().__init__(f"header cell {index} looks like a value, not a column name")
        self.index = index


class MappingRefused(Exception):
    """Not a pure rename (R28). The message is the code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def read_header(csv_text: str) -> list[str]:
    """The first record of a CSV file and nothing else."""
    return [c.strip() for c in next(csv.reader(io.StringIO(csv_text)), [])]


def check_header(header: Sequence[str]) -> None:
    for i, cell in enumerate(header):
        letters = any(ch.isalpha() for ch in cell)
        if not cell or "@" in cell or _DIGIT_RUN.search(cell) or (not letters and any(ch.isdigit() for ch in cell)):
            raise SampleRefused(i)


def check_renames(kind: str, header: Sequence[str], entries: Sequence[dict[str, str]]) -> None:
    """Every entry is {source, target}: a header cell verbatim renamed to one of the kind's fields, each field once. An
    expression ("Qty * Rate"), a formula key or a unit is refused — a calculation has nowhere to live."""
    fields = IMPORT_FIELDS[kind]
    cells = set(header)
    for e in entries:
        if set(e) != ENTRY_KEYS:
            raise MappingRefused("not_a_rename")
        if e["source"] not in cells:
            raise MappingRefused("source_not_in_header")
        if e["target"] not in fields:
            raise MappingRefused("unknown_target")
    if any(n > 1 for n in Counter(e["target"] for e in entries).values()):
        raise MappingRefused("duplicate_target")


@dataclass(frozen=True)
class Suggestion:
    kind: str
    #: Renames to prefill: [{source, target}].
    entries: list[dict[str, str]]
    #: Columns left for a person: below threshold, or two columns picked the same field.
    unmapped: list[str]
    #: Columns the model judged to be no field's plain rename.
    ignored: list[str]


async def suggest(ctx: RunContext, dm: DecisionModel, kind: str, header: Sequence[str]) -> Suggestion:
    check_header(header)
    q = MAP_COLUMNS[kind]
    headers = tuple(header)
    picks: dict[str, str | None] = {}
    for h in headers:
        [r] = await dm.decide(ctx, {"header": h, "headers": headers}, [q])
        picks[h] = answer_or_fallback(q, r)
    taken = Counter(t for t in picks.values() if t not in (None, "ignore"))
    entries = [{"source": h, "target": t} for h, t in picks.items() if t not in (None, "ignore") and taken[t] == 1]
    unmapped = [h for h, t in picks.items() if t is None or (t != "ignore" and taken[t] > 1)]
    check_renames(kind, header, entries)
    return Suggestion(kind, entries, unmapped, [h for h, t in picks.items() if t == "ignore"])

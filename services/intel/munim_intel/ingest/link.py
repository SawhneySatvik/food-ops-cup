"""Exact-alias entity linking (04-agent-framework §8; ADR-014 §13.3): a name links to an entity only when its normalised
form equals exactly one entity's alias. No decision model, no fuzzy match, no personal name leaves the process; zero
or several matches leave the name unlinked.

The normalisation is core's `normalizeAlias` (internal/batches.ts) — NFKC, trimmed, inner whitespace collapsed, lower
case — with JavaScript's whitespace set, so a name links here exactly when core would store the same `normalized`.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

#: JavaScript's `\s` (and what `String.prototype.trim` removes).
_JS_WS = "\t\n\v\f\r    -     　﻿"
_TRIM = re.compile(f"^[{_JS_WS}]+|[{_JS_WS}]+$")
_RUN = re.compile(f"[{_JS_WS}]+")


def normalize_alias(s: str) -> str:
    return _RUN.sub(" ", _TRIM.sub("", unicodedata.normalize("NFKC", s))).lower()


@dataclass(frozen=True)
class Alias:
    entity_id: str
    #: intel.entity.kind (supplier, ingredient, item …).
    kind: str
    #: `core.<table>:<uuid>` when the entity stands for a core row.
    core_ref: str | None
    alias: str


@dataclass(frozen=True)
class Entity:
    entity_id: str
    kind: str
    core_ref: str | None

    def core_id(self, table: str) -> str | None:
        """The core row id when this entity stands for a row of `core.<table>`."""
        prefix = f"core.{table}:"
        return self.core_ref[len(prefix) :] if self.core_ref and self.core_ref.startswith(prefix) else None


class AliasSource(Protocol):
    """The tenant's aliases (intel_ro.entity_alias). intel has no read path to it yet (reported); tests inject one."""

    async def aliases(self) -> list[Alias]: ...


class AliasTable:
    def __init__(self, aliases: Iterable[Alias]) -> None:
        self._index: dict[str, set[Entity]] = {}
        for a in aliases:
            self._index.setdefault(normalize_alias(a.alias), set()).add(Entity(a.entity_id, a.kind, a.core_ref))

    def link(self, name: str | None, kind: str | None = None) -> Entity | None:
        if not name:
            return None
        hits = {e for e in self._index.get(normalize_alias(name), set()) if kind is None or e.kind == kind}
        return next(iter(hits)) if len(hits) == 1 else None

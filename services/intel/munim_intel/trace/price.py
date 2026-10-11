"""An operator's per-role model price (ledger R47 D1). A leaf module: the llm layer puts it on the models it builds and
trace/spend.py charges it, and neither may import the other's side (pyproject `intel runtime layers`)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Price:
    """Minor units of `currency` per 1M input and per 1M output tokens."""

    input_per_mtok_minor: int
    output_per_mtok_minor: int
    currency: str

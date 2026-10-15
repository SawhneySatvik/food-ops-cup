"""Which path served a live-mode model call (T-125, ledger R56 G-4): the provider (`live`); the recorded fixture of that
exact call, after the provider failed, was rate-limited or the month's AI budget was spent (`recorded-fallback`); or
neither (`abstained`: the call fails as it did before, and its caller degrades — rule 11).

A label only, never text. llm/providers.py puts it on each response's `custom_metadata` and on the exception of a call
that abstained; trace/plugin.py traces it, and the DecisionModel carries it to the ask's route trace. A leaf module (as
price.py): the llm layer and the trace layer both import it, and neither imports the other.
"""

from __future__ import annotations

from typing import Literal

ModelPath = Literal["live", "recorded-fallback", "abstained"]
PATHS: tuple[ModelPath, ...] = ("live", "recorded-fallback", "abstained")
#: The `custom_metadata` key on a response, and the attribute on an exception.
KEY = "munim_model_path"


def served_by(x: object) -> ModelPath | None:
    """The label on a response or an exception; None on anything else (a recorded replay, a test double)."""
    meta = getattr(x, "custom_metadata", None)
    label = meta.get(KEY) if isinstance(meta, dict) else getattr(x, KEY, None)
    return next((p for p in PATHS if p == label), None)

"""The Manager's path table and binding rule (ADR-014 §3.3, §4.3, §5.1, §6.5; 04 §2; ledger R45 F3, F8, F9 a).

`route.intent` (the DecisionModel, `router` role) picks the path; it never picks packs. A leading `@Name` (core parses
it; intel receives `addressed_to`) picks the skill: that specialist's skill is loaded in code — the model has no
`load_skill` — and the answer is that specialist's ("Finance · via Manager", composed by core).

  lookup / explain / out_of_scope   answer        the Manager with `load_skill` (≤ 2 skills), or the addressed skill
  investigate                       fan_out       unaddressed, scored band: `fan_out` binds (F5, T-053: ≤ 4 read-only
                                                  branches); unaddressed, band `unscored` → answer, the Manager alone,
                                                  and the answer offers follow_up `dig_deeper` (ledger R47 D5); the
                                                  member's `deep` (that offer, tapped) → `fan_out` whatever the band;
                                                  addressed: the named specialist alone, single agent
  draft_request                     draft         exactly one skill, loaded in code, with its `propose_*` tools;
                                                  unaddressed → abstain `specialist_needed`, no Manager model call
  certification_request             certificate   abstain `not_a_certificate`, no model call
  (DM abstained / low band)         → explain     §4.3's fallback

Draft binding (§5.1): `propose_*` only on `draft_request`, only with exactly one skill loaded in code. Unaddressed, no
code path picks that skill (`route.intent` does not pick packs) and no model may (DECISIONS 11 Oct, W3.3), so an
unaddressed draft request abstains `specialist_needed` and the console offers the specialists to @mention. A tainted run
keeps its `propose_*` tools bound and the plugin refuses each call (§5.3: "Drafts are unavailable after reading
untrusted text in this run"), so the refusal is a traced, gated call rather than an unknown tool.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PathName = Literal["answer", "fan_out", "draft", "certificate"]


@dataclass(frozen=True)
class Path:
    name: PathName
    #: `propose_*` may be bound on this path (still only with one addressed skill).
    propose: bool
    #: The reason code of a path that answers without a model.
    abstain: str | None = None


ANSWER = Path("answer", propose=False)
FAN_OUT = Path("fan_out", propose=False)
DRAFT = Path("draft", propose=True)
CERTIFICATE = Path("certificate", propose=False, abstain="not_a_certificate")

#: An answer's one-tap follow-up when an unscored `investigate` was answered without fanning out (R47 D5; contracts
#: `FollowUp`): the member may ask the Manager to dig deeper across the specialists.
DIG_DEEPER = "dig_deeper"

#: route.intent option → path. The options are decide/questions.py's ROUTE_INTENT (six; a test checks they match).
PATHS: dict[str, Path] = {
    "lookup": ANSWER,
    "explain": ANSWER,
    "out_of_scope": ANSWER,
    "investigate": FAN_OUT,
    "draft_request": DRAFT,
    "certification_request": CERTIFICATE,
}

#: packs/kitchen.md §1: "Shop: not applicable — the pack is off for outlet.kind = 'store'". The only specialist off for
#: an outlet kind (every other pack md §1 has a shop line).
NOT_FOR_KINDS: dict[str, frozenset[str]] = {"kitchen": frozenset({"store"})}


@dataclass(frozen=True)
class Binding:
    """What one ask's Manager context binds. `skill` set → loaded in code before the first model step."""

    path: Path
    skill: str | None
    loadable: bool
    propose: bool
    #: Set: the ask is answered by this abstention with no model call.
    abstain: str | None = None


def not_applicable(addressed_to: str | None, outlet_kinds: frozenset[str]) -> bool:
    """The addressed specialist has nothing to say about any outlet in scope (e.g. @Kitchen on a shop-only scope)."""
    off = NOT_FOR_KINDS.get(addressed_to or "")
    return off is not None and bool(outlet_kinds) and outlet_kinds <= off


def path_for(intent: str, band: str, addressed_to: str | None, deep: bool = False) -> tuple[Path, str | None]:
    """(the path, the follow-up its answer offers). R47 D5: fanning out costs one model context per branch, so it waits
    for a scored routing guess; on an unscored `investigate` the Manager answers alone and offers to dig deeper — unless
    the member already asked to (`deep`: they tapped that offer), when it fans out. `deep` widens nothing else."""
    path = PATHS[intent]
    if path is FAN_OUT and addressed_to is None and band == "unscored" and not deep:
        return ANSWER, DIG_DEEPER
    return path, None


def bind(path: Path, addressed_to: str | None) -> Binding:
    if path.abstain is not None:
        return Binding(path, None, loadable=False, propose=False, abstain=path.abstain)
    if addressed_to is not None:
        return Binding(path, addressed_to, loadable=False, propose=path.propose)
    if path.propose:
        return Binding(path, None, loadable=False, propose=False, abstain="specialist_needed")
    return Binding(path, None, loadable=True, propose=False)

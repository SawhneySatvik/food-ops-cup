"""The projector: findings, claims and entities -> graph nodes and edges, as the two batch requests core accepts.

Pure and deterministic. Ids derive from the source rows (never the run), so a re-run produces the same ids and core's
`ON CONFLICT DO NOTHING` adds 0 rows (gate 3). Claim and finding nodes are `intel.entity` rows of kind 'other' that
reuse the claim's / finding's own uuid and are named `claim:<id>` / `finding:<id>` (the entity.kind CHECK has no
claim/finding kind — migrator request). Every edge carries provenance: a claim, a core row, or both.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from munim_intel.contracts_gen.models import Edge, Entity
from munim_intel.tools.generated import run_start_ms, uuid7

#: Claim predicates that are themselves a graph edge between the claim's subject and object.
PREDICATE_EDGES = {"uses": "uses", "supplies": "supplies"}


@dataclass(frozen=True)
class ClaimIn:
    id: str
    subject_entity_id: str | None
    object_entity_id: str | None
    predicate: str
    contradicts: tuple[str, ...] = ()


@dataclass(frozen=True)
class FindingIn:
    id: str
    #: The core row the finding is about (`core.<table>:<uuid>`): the edge's provenance when no claim is.
    source_ref: str
    about: tuple[str, ...] = ()
    supported_by: tuple[str, ...] = ()


@dataclass(frozen=True)
class CoreEdgeIn:
    kind: str  # uses | supplies | sold | quoted | wasted | works_at
    src: str
    dst: str
    source_ref: str


@dataclass(frozen=True)
class Projection:
    nodes: list[Entity]
    edges: list[Edge]


def _edge(kind: str, src: str, dst: str, claim_id: str | None, source_ref: str | None) -> Edge:
    # The id's clock is the source row's own (a uuid7 carries its creation ms), so the same input is the same id.
    seed = f"edge:{kind}:{src}:{dst}:{claim_id or ''}:{source_ref or ''}"
    return Edge.model_validate(
        {
            "id": uuid7(run_start_ms(claim_id or src), seed),
            "kind": kind,
            "src_entity_id": src,
            "dst_entity_id": dst,
            "claim_id": claim_id,
            "source_ref": source_ref,
            "valid_from": None,
            "valid_to": None,
        }
    )


def _node(id_: str, label: str) -> Entity:
    return Entity.model_validate({"id": id_, "kind": "other", "core_ref": None, "name": f"{label}:{id_}"})


def project(
    entities: Sequence[Entity],
    claims: Sequence[ClaimIn] = (),
    findings: Sequence[FindingIn] = (),
    core_edges: Sequence[CoreEdgeIn] = (),
) -> Projection:
    """`entities` are already resolved (ids that exist in intel.entity, core_ref -> id); the projector mints none."""
    nodes: dict[str, Entity] = {e.id.root: e for e in entities}
    edges: dict[str, Edge] = {}

    def add(e: Edge) -> None:
        edges[e.id.root] = e

    for c in claims:
        nodes.setdefault(c.id, _node(c.id, "claim"))
        for end in (c.subject_entity_id, c.object_entity_id):
            if end is not None:
                add(_edge("mentions", c.id, end, c.id, None))
        kind = PREDICATE_EDGES.get(c.predicate)
        if kind and c.subject_entity_id and c.object_entity_id:
            add(_edge(kind, c.subject_entity_id, c.object_entity_id, c.id, None))
        for other in c.contradicts:
            add(_edge("contradicts", c.id, other, c.id, None))
    for f in findings:
        nodes.setdefault(f.id, _node(f.id, "finding"))
        for ent in f.about:
            add(_edge("about", f.id, ent, None, f.source_ref))
        for cid in f.supported_by:
            add(_edge("supported_by", f.id, cid, cid, f.source_ref))
    for ce in core_edges:
        add(_edge(ce.kind, ce.src, ce.dst, None, ce.source_ref))
    return Projection(list(nodes.values()), list(edges.values()))

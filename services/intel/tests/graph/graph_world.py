"""The hand-built graph and its hand-computed answers (no value here comes from the code under test).

Tenant A: two outlets, two dishes (Chutney is a sub-recipe of Dosa, and Dosa also "uses" Chutney's output the other way:
a planted cycle), three ingredients, three suppliers (Rice has two), two claims (C2 contradicts C1) and one finding.
Tenant B reuses A's entity ids 1..10 (hostile on purpose: entity keys are (tenant_id, id)) under other names, and adds an
item of its own that uses the same Rice id. A query that loses its tenant predicate sees B.
"""

from __future__ import annotations

from typing import Any

from munim_intel.contracts_gen.models import Entity
from munim_intel.graph import ClaimIn, CoreEdgeIn, FindingIn


def uid(n: int) -> str:
    return f"01930000-0000-7000-8000-{n:012d}"


O1, O2, DOSA, CHUTNEY, RICE, COCO, OIL, S1, S2, S3, C1, C2, F1, IDLI = (uid(n) for n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 21))
RECIPE_LINE = f"core.recipe_line:{uid(901)}"
INVOICE = f"core.supplier_invoice:{uid(902)}"

BASE = [
    (O1, "outlet", "Koramangala"),
    (O2, "outlet", "Indiranagar"),
    (DOSA, "item", "Dosa"),
    (CHUTNEY, "item", "Chutney"),
    (RICE, "ingredient", "Rice"),
    (COCO, "ingredient", "Coconut"),
    (OIL, "ingredient", "Oil"),
    (S1, "supplier", "Sri Grains"),
    (S2, "supplier", "Kerala Coco"),
    (S3, "supplier", "Backup Grains"),
]


def entities(suffix: str = "", extra: tuple[tuple[str, str, str], ...] = ()) -> list[Entity]:
    named = [(i, k, n + suffix) for i, k, n in BASE]
    return [Entity.model_validate({"id": i, "kind": k, "core_ref": None, "name": n}) for i, k, n in (*named, *extra)]


CORE_A = [
    CoreEdgeIn(k, s, d, RECIPE_LINE)
    for k, s, d in (
        ("uses", DOSA, RICE),
        ("uses", DOSA, CHUTNEY),
        ("uses", DOSA, OIL),
        ("uses", CHUTNEY, COCO),
        ("uses", CHUTNEY, DOSA),
        ("sold", O1, DOSA),
        ("sold", O2, CHUTNEY),
        ("supplies", S1, RICE),
        ("supplies", S3, RICE),
        ("supplies", S2, COCO),
    )
]
CORE_B = [
    CoreEdgeIn("uses", IDLI, RICE, RECIPE_LINE),
    CoreEdgeIn("uses", DOSA, RICE, RECIPE_LINE),
    CoreEdgeIn("supplies", S2, RICE, RECIPE_LINE),
]
CLAIMS = [ClaimIn(C1, S1, RICE, "raised_price"), ClaimIn(C2, S1, None, "denies_price_rise", contradicts=(C1,))]
FINDING = FindingIn(F1, INVOICE, about=(RICE,), supported_by=(C1,))

# Hand count: 10 core edges + C1 mentions S1, RICE (2) + C2 mentions S1, contradicts C1 (2) + F1 about RICE, supported_by C1 (2).
# raised_price / denies_price_rise are not uses/supplies, so a claim adds no typed edge.
EDGES_A = 16
NODES_A = 13  # 10 entities + claim:C1, claim:C2, finding:F1


def claim_rows(message: str, body: str) -> list[dict[str, Any]]:
    quote = body[:6]
    return [
        {
            "id": c.id,
            "chunk_id": None,
            "message_id": message,
            "span_start": 0,
            "span_end": 6,
            "quote": quote,
            "subject_entity_id": c.subject_entity_id,
            "predicate": c.predicate,
            "object": None,
            "object_entity_id": c.object_entity_id,
        }
        for c in CLAIMS
    ]


def claim(c: str) -> str:
    return f"claim:{c}"


# template -> (args, rows) for tenant A. Rows are (columns in the SQL's order); hand-derived from the edges above.
# price_shock_path(Rice): reverse over uses+sold. d1 Dosa; d2 Chutney (Chutney uses Dosa: the plant), Koramangala (sold Dosa);
#   d3 Indiranagar (sold Chutney); Dosa again is in the path, so it is not re-entered.
# dish_margin_drivers(Dosa): d1 Rice, Oil, Chutney (not an ingredient); d2 Coconut. Rice has two suppliers, Oil none.
# supplier_dependency(Sri Grains): Rice, with Backup Grains as the other source.
# claim_support(F1): C1 supports, mentioning S1 and Rice; C2 contradicts, mentioning S1.
# neighbourhood(Rice, 2): d1 Dosa, Sri Grains, Backup Grains, claim C1, finding F1; d2 Chutney, Oil, Koramangala, claim C2.
EXPECTED: dict[str, tuple[dict[str, object], list[tuple[object, ...]]]] = {
    "price_shock_path": (
        {"ingredient_id": RICE},
        [(DOSA, "item", "Dosa", 1), (CHUTNEY, "item", "Chutney", 2), (O1, "outlet", "Koramangala", 2), (O2, "outlet", "Indiranagar", 3)],
    ),
    "dish_margin_drivers": (
        {"item_id": DOSA},
        [
            (OIL, "Oil", 1, None, None),
            (RICE, "Rice", 1, S3, "Backup Grains"),
            (RICE, "Rice", 1, S1, "Sri Grains"),
            (COCO, "Coconut", 2, S2, "Kerala Coco"),
        ],
    ),
    "supplier_dependency": ({"supplier_id": S1}, [(RICE, "Rice", S3, "Backup Grains")]),
    "claim_support": (
        {"finding_id": F1},
        [
            (C1, claim(C1), "supports", RICE, "Rice"),
            (C1, claim(C1), "supports", S1, "Sri Grains"),
            (C2, claim(C2), "contradicts", S1, "Sri Grains"),
        ],
    ),
    "neighbourhood": (
        {"entity_id": RICE, "depth": 2},
        [
            (DOSA, "item", "Dosa", 1),
            (S3, "supplier", "Backup Grains", 1),
            (S1, "supplier", "Sri Grains", 1),
            (C1, "other", claim(C1), 1),
            (F1, "other", f"finding:{F1}", 1),
            (CHUTNEY, "item", "Chutney", 2),
            (O1, "outlet", "Koramangala", 2),
            (OIL, "ingredient", "Oil", 2),
            (C2, "other", claim(C2), 2),
        ],
    ),
}
COLUMNS = {
    "price_shock_path": ("node_id", "kind", "name", "depth"),
    "dish_margin_drivers": ("ingredient_id", "ingredient_name", "depth", "supplier_id", "supplier_name"),
    "supplier_dependency": ("ingredient_id", "ingredient_name", "other_supplier_id", "other_supplier_name"),
    "claim_support": ("claim_id", "claim_name", "relation", "entity_id", "entity_name"),
    "neighbourhood": ("node_id", "kind", "name", "depth"),
}

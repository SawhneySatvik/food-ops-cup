"""T-058 gates. The contract suite over the Postgres-edges adapter (embedded Postgres + core-api's own batch writers).
Expected values are the hand-computed ones in graph_world.py."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, cast

import pytest

import graph_world as fx
from bridge import Bridge, BridgeReader, BridgeWriter
from munim_intel.contracts_gen.models import Edge
from munim_intel.graph import Graph, GraphError, PostgresGraph, project
from munim_intel.runtime.internal_client import CoreError


def run(coro: Any) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


@dataclass
class Backend:
    name: str
    a: Graph
    b: Graph


def load(g: Graph, ents: list[Any], core_edges: list[Any], claims: Any = None, with_claims: bool = False) -> Any:
    """Entities, then (Postgres) claims, then the projection. Returns the second upsert's result."""
    run(g.upsert(ents, []))
    if claims:
        claims()
    p = project(ents, fx.CLAIMS if with_claims else (), [fx.FINDING] if with_claims else (), core_edges)
    return run(g.upsert(p.nodes, p.edges))


@pytest.fixture(scope="module")
def bridge() -> Iterator[Bridge]:
    b = Bridge()
    yield b
    b.stop()


@pytest.fixture(scope="module")
def first_load(bridge: Bridge) -> Any:
    """The first load of tenant A and B. buildWorld already put a few intel rows in each tenant, so counts are deltas."""
    before = {w: (bridge.count(w, "entity"), bridge.count(w, "edge")) for w in "AB"}
    wa = BridgeWriter(bridge, "A")
    ga = PostgresGraph(wa, BridgeReader(bridge, "A"))
    body = bridge.ready["A"]["message_body"]
    res = load(ga, fx.entities(), fx.CORE_A, lambda: wa.write_claims(fx.claim_rows(bridge.ready["A"]["message"], body)), with_claims=True)
    gb = PostgresGraph(BridgeWriter(bridge, "B"), BridgeReader(bridge, "B"))
    load(gb, fx.entities(" (B)", ((fx.IDLI, "item", "Idli (B)"),)), fx.CORE_B)
    after = {w: (bridge.count(w, "entity"), bridge.count(w, "edge")) for w in "AB"}
    return res, {w: (after[w][0] - before[w][0], after[w][1] - before[w][1]) for w in "AB"}


@pytest.fixture(params=["postgres"])
def backend(request: pytest.FixtureRequest, bridge: Bridge, first_load: Any) -> Iterator[Backend]:
    yield Backend(
        "postgres",
        PostgresGraph(BridgeWriter(bridge, "A"), BridgeReader(bridge, "A")),
        PostgresGraph(BridgeWriter(bridge, "B"), BridgeReader(bridge, "B")),
    )


def tuples(template: str, rows: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    return sorted((tuple(r[c] for c in fx.COLUMNS[template]) for r in rows), key=repr)


@pytest.mark.parametrize("template", list(fx.EXPECTED))
def test_template_equals_the_hand_computed_rows(backend: Backend, template: str) -> None:
    args, expected = fx.EXPECTED[template]
    got = tuples(template, run(backend.a.query(template, args)))
    assert expected, "a template with no expected rows proves nothing"
    assert got == sorted(expected, key=repr)


def test_depth_is_capped_by_the_argument_and_the_cap(backend: Backend) -> None:
    one = run(backend.a.query("price_shock_path", {"ingredient_id": fx.RICE, "depth": 1}))
    assert tuples("price_shock_path", one) == [(fx.DOSA, "item", "Dosa", 1)]
    for bad in (0, 4, True, "2"):
        with pytest.raises(GraphError):
            run(backend.a.query("price_shock_path", {"ingredient_id": fx.RICE, "depth": bad}))


def test_a_tenant_id_or_any_other_argument_is_refused(backend: Backend) -> None:
    bad: list[dict[str, Any]] = [
        {"ingredient_id": fx.RICE, "tenant_id": fx.uid(99)},
        {"ingredient_id": "not-a-uuid"},
        {"ingredient_id": fx.RICE, "x": 1},
        {},
    ]
    for args in bad:
        with pytest.raises(GraphError):
            run(backend.a.query("price_shock_path", args))
    with pytest.raises(GraphError):
        run(backend.a.query("no_such_template", {"entity_id": fx.RICE}))


def test_tenant_b_sees_only_its_own_graph(backend: Backend) -> None:
    got = tuples("price_shock_path", run(backend.b.query("price_shock_path", {"ingredient_id": fx.RICE})))
    assert got == sorted([(fx.DOSA, "item", "Dosa (B)", 1), (fx.IDLI, "item", "Idli (B)", 1)], key=repr)
    a_rows = run(backend.a.query("price_shock_path", {"ingredient_id": fx.RICE}))
    assert len(a_rows) == 4
    assert not [r for r in a_rows if "(B)" in str(r["name"]) or r["node_id"] == fx.IDLI]


def test_a_second_upsert_of_the_same_projection_adds_nothing(backend: Backend) -> None:
    p = project(fx.entities(), fx.CLAIMS, [fx.FINDING], fx.CORE_A)
    res = run(backend.a.upsert(p.nodes, p.edges))
    assert (res.entities_inserted, res.edges_inserted) == (0, 0)
    assert (res.entities_existing, res.edges_existing) == (fx.NODES_A, fx.EDGES_A)


# -- Postgres-only: which layer proves what --------------------------------------------------------------------------------


def test_first_load_counts(first_load: Any) -> None:
    res, delta = first_load
    assert (res.entities_inserted, res.edges_inserted) == (3, fx.EDGES_A)  # the 10 base entities went in a step before
    assert delta == {"A": (fx.NODES_A, fx.EDGES_A), "B": (11, 3)}


def test_projector_rerun_adds_zero_edges(bridge: Bridge, first_load: Any) -> None:
    """Gate 3, measured twice: the adapter's `inserted` and an independent SQL count."""
    g = PostgresGraph(BridgeWriter(bridge, "A"), BridgeReader(bridge, "A"))
    before = bridge.count("A", "edge")
    assert before >= fx.EDGES_A
    p1 = project(fx.entities(), fx.CLAIMS, [fx.FINDING], fx.CORE_A)
    res = run(g.upsert(p1.nodes, p1.edges))
    assert res.edges_inserted == 0
    assert bridge.count("A", "edge") == before
    p2 = project(fx.entities(), fx.CLAIMS, [fx.FINDING], fx.CORE_A)
    assert [e.id.root for e in p1.edges] == [e.id.root for e in p2.edges]


def test_every_projected_edge_has_provenance() -> None:
    p = project(fx.entities(), fx.CLAIMS, [fx.FINDING], fx.CORE_A)
    assert len(p.edges) == fx.EDGES_A
    assert all(isinstance(e, Edge) and (e.claim_id is not None or e.source_ref is not None) for e in p.edges)


@pytest.mark.parametrize("template", list(fx.EXPECTED))
def test_the_sql_predicate_alone_isolates_tenants(bridge: Bridge, first_load: Any, template: str) -> None:
    """Gate 2. Run as the superuser, which bypasses RLS: only the template's own `tenant_id = :tenant_id` isolates A from B.
    Strip those predicates and this goes red (redproof.sh)."""
    args, expected = fx.EXPECTED[template]
    g = PostgresGraph(BridgeWriter(bridge, "A"), BridgeReader(bridge, "A", role="admin"))
    got = tuples(template, run(g.query(template, args)))
    assert got == sorted(expected, key=repr)
    assert "(B)" not in repr(got)


@pytest.mark.parametrize("template", list(fx.EXPECTED))
def test_rls_isolates_tenants_under_the_service_role(bridge: Bridge, first_load: Any, template: str) -> None:
    """The other layer: munim_svc under SET LOCAL app.tenant_id. Stays green with the predicate stripped — which is why
    the test above exists."""
    args, expected = fx.EXPECTED[template]
    g = PostgresGraph(BridgeWriter(bridge, "A"), BridgeReader(bridge, "A", role="svc"))
    assert tuples(template, run(g.query(template, args))) == sorted(expected, key=repr)


def test_core_refuses_what_check_args_refuses_and_another_tenant_gets_no_rows(bridge: Bridge, first_load: Any) -> None:
    """The real `graph:query` route, bypassing intel's own check_args: core refuses a tenant_id (or any other key) by
    itself (422), and tenant B asking about A's finding and A's dosa gets 200 with 0 rows. Paired: A gets its rows."""
    a, b = BridgeReader(bridge, "A"), BridgeReader(bridge, "B")
    with pytest.raises(CoreError) as e:
        run(a.graph_query("price_shock_path", {"ingredient_id": fx.RICE, "tenant_id": bridge.ready["B"]["tenant"]}))
    assert e.value.status == 422
    args, expected = fx.EXPECTED["claim_support"]
    assert len(run(a.graph_query("claim_support", cast(dict[str, str | int], args)))) == len(expected) > 0
    assert run(b.graph_query("claim_support", cast(dict[str, str | int], args))) == []


def test_an_id_seen_again_with_other_content_is_refused(backend: Backend) -> None:
    """The port's rule (graph/port.py): idempotent by id; the same id with other content is an error — core's 409 for
    Postgres (the bridge raises it), never a silent overwrite. Paired:
    the same content again is `existing`."""
    [rice] = [e for e in fx.entities() if e.id.root == fx.RICE]
    again = run(backend.a.upsert([rice], []))
    assert (again.entities_inserted, again.entities_existing) == (0, 1)
    with pytest.raises((GraphError, AssertionError), match="conflict"):
        run(backend.a.upsert([rice.model_copy(update={"name": "Rice (renamed)"})], []))

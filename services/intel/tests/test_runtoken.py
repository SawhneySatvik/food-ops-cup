"""Gate: RunContext comes only from a run token signed by core (Ed25519, public key only). Every refusal is paired
with an acceptance on the other side of the one condition that changes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from munim_intel.config import ConfigError
from munim_intel.contracts_gen.models import Cloudevent
from munim_intel.runtime.context import RunTokenRefused, context_for_event, load_public_key, verify_run_token

INTEL_SRC = Path(__file__).resolve().parents[1] / "munim_intel"


def event(tenant: str, token: str, source_tenant: str | None = None) -> Cloudevent:
    return Cloudevent.model_validate(
        {
            "specversion": "1.0",
            "id": "01920000-0000-7000-8000-0000000000e1",
            "time": "2026-10-10T10:00:00Z",
            "datacontenttype": "application/json",
            "tenantid": tenant,
            "munimrun": token,
            "source": f"/tenants/{source_tenant or tenant}/orders",
            "type": "munim.orders.order.placed.v1",
            "subject": "01920000-0000-7000-8000-0000000000e2",
            "data": {},
        }
    )


def test_core_minted_token_builds_the_context(minted: dict[str, Any]) -> None:
    key = load_public_key(minted["public_key_pem"].encode())
    claims = minted["claims"]["valid"]
    ctx = verify_run_token(minted["tokens"]["valid"], key)
    assert (ctx.run_id, ctx.tenant_id, ctx.outlet_scope, ctx.trigger, ctx.actor, ctx.expires_at) == (
        claims["run_id"],
        minted["tenant_a"],
        ("*",),
        "event",
        "watcher:smoke",
        claims["exp"],
    )
    assert minted["tokens"]["valid"] not in repr(ctx)
    ask = verify_run_token(minted["tokens"]["ask"], key)
    assert (ask.trigger, ask.outlet_scope) == ("ask", (minted["outlet"],))


@pytest.mark.parametrize(
    ("token", "reason"),
    [
        ("other_key", "bad_signature"),
        ("tampered_to_b", "bad_signature"),
        ("alg_none", "malformed"),
        ("expired", "expired"),
    ],
)
def test_forged_and_expired_tokens_are_refused(minted: dict[str, Any], token: str, reason: str) -> None:
    key = load_public_key(minted["public_key_pem"].encode())
    assert verify_run_token(minted["tokens"]["valid"], key).tenant_id == minted["tenant_a"]
    with pytest.raises(RunTokenRefused) as refused:
        verify_run_token(minted["tokens"][token], key)
    assert refused.value.reason == reason
    assert minted["tokens"][token] not in str(refused.value)


@pytest.mark.parametrize("garbage", ["", "a.b", "a.b.c.d", "not.a.token", "eyJhbGciOiJFZERTQSJ9.e30=.AA"])
def test_garbage_is_malformed(minted: dict[str, Any], garbage: str) -> None:
    with pytest.raises(RunTokenRefused) as refused:
        verify_run_token(garbage, load_public_key(minted["public_key_pem"].encode()))
    assert refused.value.reason == "malformed"


def test_expiry_boundary(minted: dict[str, Any]) -> None:
    key = load_public_key(minted["public_key_pem"].encode())
    exp = minted["claims"]["valid"]["exp"]
    assert verify_run_token(minted["tokens"]["valid"], key, now=lambda: exp - 1).run_id
    with pytest.raises(RunTokenRefused, match="expired"):
        verify_run_token(minted["tokens"]["valid"], key, now=lambda: exp)


def test_the_fixture_tokens_outlive_a_slow_suite(minted: dict[str, Any]) -> None:
    """The session mints once; with core's own 15-minute ask lifetime a suite slower than that failed on "expired" (C3).
    Every fixture token must still verify hours after issue, and the expired one must stay refused."""
    key = load_public_key(minted["public_key_pem"].encode())
    assert set(minted["claims"]) == {"valid", "ask", "brief", "ingest", "auto_step"}

    def run_id_at(name: str, at: int) -> str:
        return verify_run_token(minted["tokens"][name], key, now=lambda: at).run_id

    for name, claims in minted["claims"].items():
        assert run_id_at(name, claims["iat"] + 4 * 3600) == claims["run_id"], name
    with pytest.raises(RunTokenRefused, match="expired"):
        verify_run_token(minted["tokens"]["expired"], key)


def test_a_token_of_another_tenant_is_refused(minted: dict[str, Any]) -> None:
    key = load_public_key(minted["public_key_pem"].encode())
    assert verify_run_token(minted["tokens"]["tenant_b"], key, tenant_id=minted["tenant_b"]).tenant_id == minted["tenant_b"]
    with pytest.raises(RunTokenRefused) as refused:
        verify_run_token(minted["tokens"]["tenant_b"], key, tenant_id=minted["tenant_a"])
    assert refused.value.reason == "wrong_tenant"


def test_an_event_binds_its_token_to_its_tenant(minted: dict[str, Any]) -> None:
    key = load_public_key(minted["public_key_pem"].encode())
    a, b = minted["tenant_a"], minted["tenant_b"]
    assert context_for_event(event(a, minted["tokens"]["valid"]), key).tenant_id == a
    for bad in (event(a, minted["tokens"]["tenant_b"]), event(a, minted["tokens"]["valid"], source_tenant=b)):
        with pytest.raises(RunTokenRefused) as refused:
            context_for_event(bad, key)
        assert refused.value.reason == "wrong_tenant"


def test_intel_holds_the_public_key_only() -> None:
    sources = list(INTEL_SRC.rglob("*.py"))
    assert len(sources) > 5
    assert [p for p in sources if "run-token-ed25519.pem" in p.read_text("utf8")] == []
    ec_key = ec.generate_private_key(ec.SECP256R1()).public_key()
    pem = ec_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    with pytest.raises(ConfigError, match="Ed25519"):
        load_public_key(pem)

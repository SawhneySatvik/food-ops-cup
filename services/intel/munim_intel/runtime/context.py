"""RunContext: the only source of tenant and outlet scope inside intel (04-agent-framework §1, rule 15).

Built solely from a run token core-api signed with its Ed25519 private key; intel holds the public key, so it
cannot mint. The checks mirror core's `runtoken/index.ts`: three strict-base64url parts, header alg EdDSA,
signature over `header.payload`, claims parsed with the generated contract, `exp` after now. core-api also
checks the `intel.run` row on every internal call — intel cannot, having no database (R25).
Every refusal carries a reason code only; the token itself is never put in a message or a log line.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from pydantic import ValidationError

from munim_intel.config import ConfigError
from munim_intel.contracts_gen.models import Cloudevent, RunTokenClaims

RefusalReason = Literal["malformed", "bad_signature", "bad_claims", "expired", "wrong_tenant"]
Trigger = Literal["event", "watch_sweep", "ask", "brief", "ingest", "auto_step"]

_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")


class RunTokenRefused(Exception):
    def __init__(self, reason: RefusalReason) -> None:
        super().__init__(f"run token refused: {reason}")
        self.reason: RefusalReason = reason


@dataclass(frozen=True)
class RunContext:
    run_id: str
    tenant_id: str
    #: ("*",) = every outlet of the tenant; otherwise the outlet ids the run may see (W1 fix #18: narrowest).
    outlet_scope: tuple[str, ...]
    trigger: Trigger
    #: "watcher:<pack>" | "brief" | a member id.
    actor: str
    #: Unix seconds.
    expires_at: int
    token: str = field(repr=False)


def load_public_key(pem: bytes) -> Ed25519PublicKey:
    key = load_pem_public_key(pem)
    if not isinstance(key, Ed25519PublicKey):
        raise ConfigError("run-token public key must be Ed25519")
    return key


def _b64u(segment: str) -> bytes | None:
    """Strict base64url (no padding): decoding must round-trip, so no alternative encoding of the same bytes passes."""
    if not _B64URL.match(segment):
        return None
    try:
        raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    except (binascii.Error, ValueError):
        return None
    return raw if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() == segment else None


def verify_run_token(
    token: str,
    public_key: Ed25519PublicKey,
    *,
    tenant_id: str | None = None,
    now: Callable[[], float] = time.time,
) -> RunContext:
    """The RunContext of a valid token; RunTokenRefused otherwise. `tenant_id` (when the caller knows which
    tenant the work belongs to, e.g. a CloudEvent's `tenantid`) must equal the token's tenant."""
    parts = token.split(".")
    if len(parts) != 3:
        raise RunTokenRefused("malformed")
    h, p, s = parts
    header, payload, sig = _b64u(h), _b64u(p), _b64u(s)
    if header is None or payload is None or sig is None:
        raise RunTokenRefused("malformed")
    try:
        alg = json.loads(header).get("alg")
    except (ValueError, AttributeError):
        raise RunTokenRefused("malformed") from None
    if alg != "EdDSA":
        raise RunTokenRefused("malformed")
    try:
        public_key.verify(sig, f"{h}.{p}".encode())
    except InvalidSignature:
        raise RunTokenRefused("bad_signature") from None
    try:
        claims = RunTokenClaims.model_validate_json(payload, strict=True)
    except ValidationError:
        raise RunTokenRefused("bad_claims") from None
    if claims.exp <= now():
        raise RunTokenRefused("expired")
    if tenant_id is not None and claims.tenant_id.root != tenant_id:
        raise RunTokenRefused("wrong_tenant")
    return RunContext(
        run_id=claims.run_id.root,
        tenant_id=claims.tenant_id.root,
        outlet_scope=tuple(o if isinstance(o, str) else o.root for o in claims.outlet_scope.root),
        trigger=claims.trigger,
        actor=claims.actor,
        expires_at=claims.exp,
        token=token,
    )


def context_for_event(event: Cloudevent, public_key: Ed25519PublicKey, *, now: Callable[[], float] = time.time) -> RunContext:
    """An event's run: its `munimrun` token must belong to the tenant named by both `tenantid` and `source`."""
    source_tenant = event.source.split("/")[2]
    if source_tenant != event.tenantid.root:
        raise RunTokenRefused("wrong_tenant")
    return verify_run_token(event.munimrun, public_key, tenant_id=event.tenantid.root, now=now)

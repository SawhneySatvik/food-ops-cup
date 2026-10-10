"""intel's HTTP surface (03-architecture §1.9). Every POST needs core's service secret; every run needs a run token.

/health       liveness and model mode
/events       core's publisher (CloudEvents batch): each event's run token must verify for its own tenant;
              accepted and acknowledged — handling lands with T-043
/watch:sweep  core-worker fan-out: token verified, acknowledged (T-043)
/brief        core-worker fan-out: token verified, acknowledged (T-054)
/smoke        one trivial recorded ADK run through the echo tool: RunContext end to end

Bodies are parsed by hand, so no framework validation error ever echoes a request back. Every refusal of a
caller is the same 401; no response carries model text, a token, or an exception message.
"""

from __future__ import annotations

import hmac
import json
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from munim_intel.config import Config, ConfigError
from munim_intel.contracts_gen.models import Cloudevent
from munim_intel.runtime.context import RunContext, RunTokenRefused, context_for_event, load_public_key, verify_run_token
from munim_intel.runtime.internal_client import SERVICE_SECRET_HEADER, InternalClient
from munim_intel.runtime.runner import RunFailed
from munim_intel.smoke import smoke_run

log = logging.getLogger("munim_intel.app")


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": code, "reason_code": None}}, status_code=status)


class _Refused(Exception):
    def __init__(self, response: JSONResponse) -> None:
        self.response = response


def create_app(
    cfg: Config,
    *,
    now: Callable[[], float] = time.time,
    core_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    app = FastAPI(title="munim-intel", docs_url=None, redoc_url=None, openapi_url=None)
    keys: dict[str, Ed25519PublicKey] = {}

    # Read lazily: core-api creates the key and the secret on its first start, which may follow intel's.
    def public_key() -> Ed25519PublicKey:
        if "k" not in keys:
            keys["k"] = load_public_key(cfg.run_token_public_key_pem())
        return keys["k"]

    def authenticate_service(request: Request) -> None:
        try:
            secret = cfg.service_secret()
            public_key()
        except ConfigError as e:
            log.error("intel: refusing requests — %s", e)
            raise _Refused(_error(503, "unavailable")) from None
        given = request.headers.get(SERVICE_SECRET_HEADER, "")
        if not hmac.compare_digest(given.encode(), secret.encode()):
            raise _Refused(_error(401, "unauthenticated"))

    def run_context(request: Request) -> RunContext:
        authenticate_service(request)
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise _Refused(_error(401, "unauthenticated"))
        try:
            return verify_run_token(auth[7:], public_key(), now=now)
        except RunTokenRefused as e:
            log.info("intel: %s on %s", e, request.url.path)
            raise _Refused(_error(401, "unauthenticated")) from None

    async def json_body(request: Request) -> Any:
        try:
            return json.loads(await request.body() or b"{}")
        except ValueError:
            raise _Refused(_error(400, "bad_request")) from None

    @app.exception_handler(_Refused)
    async def refused(_: Request, exc: _Refused) -> Response:
        return exc.response

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "intel", "model_mode": cfg.model_mode}

    @app.post("/events")
    async def events(request: Request) -> Response:
        authenticate_service(request)
        body = await json_body(request)
        try:
            batch = [Cloudevent.model_validate(e) for e in (body if isinstance(body, list) else [body])]
        except ValidationError:
            return _error(400, "bad_request")
        try:
            for event in batch:
                context_for_event(event, public_key(), now=now)
        except RunTokenRefused as e:
            log.info("intel: /events %s", e)
            return _error(401, "unauthenticated")
        log.info("intel: /events acknowledged %s", [e.id.root for e in batch])
        return JSONResponse({"accepted": len(batch)}, status_code=202)

    @app.post("/watch:sweep")
    async def watch_sweep(request: Request) -> Response:
        ctx = run_context(request)
        return JSONResponse({"run_id": ctx.run_id}, status_code=202)

    @app.post("/brief")
    async def brief(request: Request) -> Response:
        ctx = run_context(request)
        return JSONResponse({"run_id": ctx.run_id}, status_code=202)

    @app.post("/smoke")
    async def smoke(request: Request) -> Response:
        ctx = run_context(request)
        body = await json_body(request)
        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not 0 < len(text) <= 200:
            return _error(400, "bad_request")
        client = InternalClient(ctx, base_url=cfg.core_url, service_secret=cfg.service_secret(), transport=core_transport)
        try:
            return JSONResponse(await smoke_run(ctx, cfg, client, client, text))
        except RunFailed as e:
            log.error("intel: smoke run %s failed: %s", ctx.run_id, e)
            return _error(502, "internal")
        finally:
            await client.aclose()

    return app

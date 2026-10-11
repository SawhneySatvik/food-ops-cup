"""intel's HTTP surface (03-architecture §1.9). Every POST needs core's service secret; every run needs a run token.

/health       liveness and model mode
/events       core's publisher (CloudEvents batch): each event's run token must verify for its own tenant; then each
              event runs under its own token (T-043: events:claim, then the detectors watching its type)
/watch:sweep  core-worker fan-out: every registered detector over the run's outlets (T-043)
/brief        core-worker fan-out: token verified, acknowledged (T-054)
/ask          core's AskPort (T-088a; T-082b): one Manager ask under an `ask` run token → {answer_id, tainted}; the answer
              is stored through core's internal API under core's answer id, before this returns
/smoke        one trivial recorded ADK run through the echo tool: RunContext end to end

Bodies are parsed by hand, so no framework validation error ever echoes a request back. Every refusal of a
caller is the same 401; no response carries model text, a token, or an exception message.
"""

from __future__ import annotations

import hmac
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from google.adk.models import BaseLlm
from pydantic import ValidationError

from munim_intel.config import Config, ConfigError
from munim_intel.contracts_gen.models import Cloudevent, ThreadsIntelAskRequest
from munim_intel.events import handle_event
from munim_intel.llm import llm_for_role
from munim_intel.llm.providers import ProviderUnavailable
from munim_intel.manager.ask import ModelsFactory, answer_ask, default_models, fetch_run_frame
from munim_intel.runtime.context import RunContext, RunTokenRefused, context_for_event, load_public_key, verify_run_token
from munim_intel.runtime.internal_client import SERVICE_SECRET_HEADER, CoreError, InternalClient
from munim_intel.runtime.runner import RunFailed
from munim_intel.smoke import smoke_run
from munim_intel.watch import sweep
from munim_intel.watch.frame import Frame, FrameSource, core_frame_source
from munim_intel.watch.pipeline import Report

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
    frame_source: FrameSource | None = None,
    ask_models: ModelsFactory | None = None,
) -> FastAPI:
    app = FastAPI(title="munim-intel", docs_url=None, redoc_url=None, openapi_url=None)
    keys: dict[str, Ed25519PublicKey] = {}
    # T-040b: core's run-frame by default; a test may pass its own source.
    frame_of = frame_source or core_frame_source(cfg, core_transport)
    # T-082b: the route.intent decision model and the Manager's model; a test may pass recorded ones of its own.
    models_of = ask_models or default_models(cfg)

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
            runs = [(event, context_for_event(event, public_key(), now=now)) for event in batch]
        except RunTokenRefused as e:
            log.info("intel: /events %s", e)
            return _error(401, "unauthenticated")
        # The detectors run inside the push request (04 §5). A failed event is logged and the rest go on: the
        # 15-minute sweep is the trailing coverage for anything an event run missed.
        for event, ctx in runs:

            async def one(
                client: InternalClient, frame: Frame, llm: BaseLlm | None, e: Cloudevent = event, c: RunContext = ctx
            ) -> Report | None:
                return await handle_event(e, c, client, frame, cfg, llm=llm)

            await watch(ctx, one)
        log.info("intel: /events handled %s", [e.id.root for e in batch])
        return JSONResponse({"accepted": len(batch)}, status_code=202)

    async def watch(ctx: RunContext, work: Callable[[InternalClient, Frame, BaseLlm | None], Awaitable[Report | None]]) -> dict[str, Any]:
        """One watcher run: its Frame (or nothing, fail closed), the narrate model when the Frame allows it, the work."""
        frame = await frame_of(ctx)
        if frame is None:
            log.info("intel: run %s frame_unavailable", ctx.run_id)
            return {"status": "frame_unavailable"}
        client = InternalClient(ctx, base_url=cfg.core_url, service_secret=cfg.service_secret(), transport=core_transport)
        try:
            llm: BaseLlm | None = None
            if frame.narration == "model":
                try:
                    llm = await llm_for_role("narrate", cfg, client)
                except (ProviderUnavailable, CoreError, httpx.HTTPError) as e:
                    # Rule 11: AI surfaces degrade to the template, never to an error.
                    log.warning("intel: run %s narrates by template: %s", ctx.run_id, type(e).__name__)
            report = await work(client, frame, llm)
        except (CoreError, httpx.HTTPError) as e:
            log.error("intel: watch run %s failed: %s", ctx.run_id, type(e).__name__)
            return {"status": "failed"}
        finally:
            await client.aclose()
        return {"status": "redelivery"} if report is None else {"status": "done", **report.as_json()}

    @app.post("/watch:sweep")
    async def watch_sweep(request: Request) -> Response:
        ctx = run_context(request)

        async def run(client: InternalClient, frame: Frame, llm: BaseLlm | None) -> Report:
            return await sweep(ctx, client, frame, cfg, llm=llm)

        out = await watch(ctx, run)
        return JSONResponse({"run_id": ctx.run_id, **out}, status_code=202)

    @app.post("/brief")
    async def brief(request: Request) -> Response:
        ctx = run_context(request)
        return JSONResponse({"run_id": ctx.run_id}, status_code=202)

    @app.post("/ask")
    async def ask(request: Request) -> Response:
        ctx = run_context(request)
        # Only an ask token buys an ask (an event or sweep token must not spend model calls here).
        if ctx.trigger != "ask":
            return _error(401, "unauthenticated")
        try:
            req = ThreadsIntelAskRequest.model_validate(await json_body(request))
        except ValidationError:
            return _error(400, "bad_request")
        frame = await fetch_run_frame(ctx, cfg, core_transport)
        if frame is None:
            return _error(503, "unavailable")
        client = InternalClient(ctx, base_url=cfg.core_url, service_secret=cfg.service_secret(), transport=core_transport)
        try:
            out = await answer_ask(ctx, req, frame, client, cfg, await models_of(client))
        except (CoreError, httpx.HTTPError, ProviderUnavailable) as e:
            # Nothing usable was stored: core answers its member 503 and writes no turn.
            log.error("intel: ask run %s failed: %s", ctx.run_id, type(e).__name__)
            return _error(502, "internal")
        finally:
            await client.aclose()
        return JSONResponse(out.model_dump(mode="json"))

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

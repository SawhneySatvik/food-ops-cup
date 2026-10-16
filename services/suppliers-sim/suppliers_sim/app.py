"""The ASGI app: one A2A agent per personality, each at `/<key>` (JSON-RPC) with its card at
`/<key>/.well-known/agent-card.json`. The card's interface URL is `<public_url>/<key>`: the public URL is required
and never defaulted, so a card can never advertise localhost by accident (gotcha 6). A request body over
MAX_BODY_BYTES is refused 413 before any handler reads it (public, no secret: C1 S3-5, R64 X-4).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types.a2a_pb2 import AgentCapabilities, AgentCard, AgentInterface, AgentProvider, AgentSkill
from a2a.utils.constants import AGENT_CARD_WELL_KNOWN_PATH
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from suppliers_sim.agent import SupplierAgent, load_data

#: An RFQ or counter is a few hundred bytes.
MAX_BODY_BYTES = 64 * 1024
TOO_LARGE = JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request too large"}}, status_code=413)


class BodyLimit:
    """413 by the declared Content-Length (the server delivers no more than it declares); a body sent without one
    (chunked) is read here, at most `limit` bytes, and handed on whole — the JSON-RPC handler catches any error raised
    while it reads, so the limit is judged before it runs."""

    def __init__(self, app: ASGIApp, limit: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None:
            if not declared.isdigit() or int(declared) > self.limit:
                await TOO_LARGE(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return
        body = b""
        while True:
            msg = await receive()
            if msg["type"] != "http.request":
                return
            body += msg.get("body", b"")
            if len(body) > self.limit:
                await TOO_LARGE(scope, receive, send)
                return
            if not msg.get("more_body", False):
                break
        whole: list[Message] = [{"type": "http.request", "body": body, "more_body": False}]

        async def replay() -> Message:
            return whole.pop() if whole else await receive()

        await self.app(scope, replay, send)


class PublicUrlError(ValueError):
    pass


def check_public_url(url: str | None) -> str:
    if not url:
        raise PublicUrlError("SUPPLIERS_SIM_PUBLIC_URL is required: the agent cards advertise it (gotcha 6)")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.query or parts.fragment:
        raise PublicUrlError("SUPPLIERS_SIM_PUBLIC_URL must be an http(s) origin with an optional path")
    return url.rstrip("/")


def card(p: dict[str, Any], label: str, public_url: str) -> AgentCard:
    return AgentCard(
        name=f"{p['name']} ({label})",
        description=f"{label}: synthetic quotes from a simulated agent ({p['style']}). Not a real business; quotes are non-binding "
        "and no order is placed or paid.",
        version="1",
        provider=AgentProvider(organization=f"Munim ({label})", url=public_url),
        supported_interfaces=[AgentInterface(url=f"{public_url}/{p['key']}", protocol_binding="JSONRPC")],
        capabilities=AgentCapabilities(streaming=False),
        default_input_modes=["application/json"],
        default_output_modes=["text/plain"],
        skills=[
            AgentSkill(
                id="quote",
                name=f"Quote ({label})",
                description=f"{label}: answers an RFQ and counters with a price.",
                tags=["simulated", "quote"],
            )
        ],
    )


def build_app(public_url: str | None, *, data: dict[str, Any] | None = None, clause: int | None = None) -> Starlette:
    base = check_public_url(public_url)
    data = data or load_data()
    label = str(data["label"])
    routes: list[Any] = []
    cards: list[AgentCard] = []
    for p in data["personalities"]:
        c = card(p, label, base)
        cards.append(c)
        handler = DefaultRequestHandler(
            agent_executor=SupplierAgent(p, label, data["moq_clauses"], clause), task_store=InMemoryTaskStore(), agent_card=c
        )
        routes += create_agent_card_routes(c, card_url=f"/{p['key']}{AGENT_CARD_WELL_KNOWN_PATH}")
        routes += create_jsonrpc_routes(handler, f"/{p['key']}")

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "label": label, "agents": len(cards)})

    app = Starlette(routes=[Route("/health", health), *routes], middleware=[Middleware(BodyLimit)])
    app.state.cards = cards
    return app

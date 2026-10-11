"""SupplierPort (ADR-008 as amended by F4; ADR-014 §10): plain `a2a-sdk` client, deterministic on our side.

A message to a simulated supplier is a typed data part (`rfq`, `counter`, `accept`, `walk`) plus the message text
(code-rendered numbers after any model note). The reply comes back as text and is untrusted: the caller hands it only to
the no-tools extractor. Suppliers are `core.supplier` rows of kind `simulated` (R22); `card_url` is the agent-card URL
the row records (the card the simulated agent publishes).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from a2a.client import A2ACardResolver, Client, ClientConfig, ClientFactory
from a2a.helpers import get_message_text, new_data_part, new_message, new_text_part
from a2a.types.a2a_pb2 import Role, SendMessageRequest

#: Hard rule 5: how every supplier is named on our side (trace payloads carry the slug — labels have no spaces).
LABEL = "Simulated supplier"
LABEL_SLUG = "simulated_supplier"


@dataclass(frozen=True)
class Supplier:
    id: str
    card_url: str


class SupplierPort(Protocol):
    async def send(self, supplier: Supplier, context_id: str, data: dict[str, Any], text: str) -> str: ...


class A2aSuppliers:
    """One A2A client per supplier card, over the caller's httpx client (its timeouts and transport)."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._clients: dict[str, Client] = {}

    async def _client(self, s: Supplier) -> Client:
        if s.id not in self._clients:
            card = await A2ACardResolver(self._http, s.card_url, agent_card_path="").get_agent_card()
            self._clients[s.id] = ClientFactory(ClientConfig(httpx_client=self._http, streaming=False)).create(card)
        return self._clients[s.id]

    async def send(self, supplier: Supplier, context_id: str, data: dict[str, Any], text: str) -> str:
        client = await self._client(supplier)
        msg = new_message([new_data_part(data), new_text_part(text)], context_id=context_id, role=Role.ROLE_USER)
        out: list[str] = []
        async for r in client.send_message(SendMessageRequest(message=msg)):
            if r.HasField("message"):
                out.append(get_message_text(r.message))
        return "\n".join(out)

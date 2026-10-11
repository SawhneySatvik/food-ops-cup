"""SupplierPort (ADR-008 as amended by F4; ADR-014 §10): plain `a2a-sdk` client, deterministic on our side.

A message to a simulated supplier is a typed data part (`rfq`, `counter`, `accept`, `walk`) plus the message text
(code-rendered numbers after any model note). The reply comes back as text and is untrusted: the caller hands it only to
the no-tools extractor. Suppliers are `core.supplier` rows of kind `simulated` (R22); `card_url` is the agent-card URL
the row records (the card the simulated agent publishes).

Simulated only, checked before anything is sent (R-C F4; DECISIONS 11 Oct, "W3.2 review ruling"): a `Supplier` carries
the row's `kind` (`simulated_suppliers` keeps only `simulated` rows of a core read), and `check` refuses a supplier whose
kind is not `simulated`, whose card URL is not on the configured suppliers-sim origin (`SUPPLIERS_SIM_PUBLIC_URL`), or
whose published card is not named "Simulated supplier" or advertises an interface on another origin. 0024 adds the same
rule to the database (`a2a_card_url IS NULL OR kind = 'simulated'`).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

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
    #: `core.supplier.kind` as core read it; only `simulated` is ever sent anything.
    kind: str


class NotSimulated(Exception):
    """A supplier that is not a labelled simulated agent on the configured origin. The message is the code, never a URL."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def simulated_suppliers(rows: Iterable[Mapping[str, Any]]) -> list[Supplier]:
    """Suppliers from a core read of `core.supplier` (`supplier_id`, `kind`, `a2a_card_url`): simulated rows with a card."""
    return [
        Supplier(str(r["supplier_id"]), str(r["a2a_card_url"]), str(r["kind"]))
        for r in rows
        if r["kind"] == "simulated" and r["a2a_card_url"]
    ]


def origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


class SupplierPort(Protocol):
    async def check(self, supplier: Supplier) -> None: ...

    async def send(self, supplier: Supplier, context_id: str, data: dict[str, Any], text: str) -> str: ...


class A2aSuppliers:
    """One A2A client per supplier card, over the caller's httpx client (its timeouts and transport). `sim_url` is the
    configured `SUPPLIERS_SIM_PUBLIC_URL`: no card is fetched and nothing is sent anywhere else."""

    def __init__(self, http: httpx.AsyncClient, sim_url: str) -> None:
        self._http = http
        self._origin = origin(sim_url)
        self._clients: dict[str, Client] = {}

    async def check(self, s: Supplier) -> None:
        """Refuses (NotSimulated) unless the supplier is a labelled simulated agent on the configured origin."""
        if s.kind != "simulated":
            raise NotSimulated("not_simulated")
        if origin(s.card_url) != self._origin:
            raise NotSimulated("card_off_origin")
        if s.id not in self._clients:
            card = await A2ACardResolver(self._http, s.card_url, agent_card_path="").get_agent_card()
            if LABEL not in card.name:
                raise NotSimulated("card_not_labelled")
            if not card.supported_interfaces or any(origin(i.url) != self._origin for i in card.supported_interfaces):
                raise NotSimulated("interface_off_origin")
            self._clients[s.id] = ClientFactory(ClientConfig(httpx_client=self._http, streaming=False)).create(card)

    async def _client(self, s: Supplier) -> Client:
        await self.check(s)
        return self._clients[s.id]

    async def send(self, supplier: Supplier, context_id: str, data: dict[str, Any], text: str) -> str:
        client = await self._client(supplier)
        msg = new_message([new_data_part(data), new_text_part(text)], context_id=context_id, role=Role.ROLE_USER)
        out: list[str] = []
        async for r in client.send_message(SendMessageRequest(message=msg)):
            if r.HasField("message"):
                out.append(get_message_text(r.message))
        return "\n".join(out)

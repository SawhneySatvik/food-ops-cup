# services/suppliers-sim

Three **simulated** supplier agents behind A2A (agent-to-agent). No real supplier, price, order or payment exists here. Every
agent card and every reply says "Simulated supplier". The agents are deterministic: a personality is data
(`suppliers_sim/personalities.json`) and no model is called.

intel's negotiation (`services/intel/munim_intel/negotiate/`) is the only client. It sends typed data parts (`rfq`, `counter`,
`accept`, `walk`) and reads plain-text replies through a tool-less extractor.

## The three suppliers

Prices are basis points of the reference price the buyer's request carries (the lowest last price any of the tenant's
suppliers holds for the item).

| Key | Name | First quote | Concedes per round | Floor | Minimum order | Payment |
|---|---|---|---|---|---|---|
| `steady` | Steady Wholesale | 102 percent | 1.5 percent | 99 percent | none | 15 days |
| `discounter` | Bargain Bulk Traders | 90 percent | 0.5 percent | 88 percent | 3 times the quantity asked, stated only in the terms sentence | 7 days |
| `premium` | Premium Provisions | 112 percent | 2 percent | 106 percent | none | 30 days |

## Entry points

- `suppliers_sim/__main__.py`: `python -m suppliers_sim` serves all three. `SUPPLIERS_SIM_PUBLIC_URL` is required, because each
  agent card advertises it and a card must never advertise localhost by accident. `SUPPLIERS_SIM_HOST` and
  `SUPPLIERS_SIM_PORT` default to `127.0.0.1:8090`. It reads no environment file and no secret.
- `suppliers_sim/app.py` builds the ASGI app: one A2A agent per personality at `/<key>` (JSON-RPC), with its card at
  `/<key>/.well-known/agent-card.json`. A request body over the cap is refused `413` before any handler reads it.
- `suppliers_sim/agent.py` is one supplier: prices from its personality, state per A2A context. Every input is bounded, a
  field out of range gets a "did not understand" reply that echoes nothing the buyer sent, and an open offer lives at most
  `OFFER_TTL_S`, with at most `MAX_OFFERS` held.

The service is public and holds no secret and no data.

## Run and test

```bash
SUPPLIERS_SIM_PUBLIC_URL=http://127.0.0.1:8090 uv run --locked --directory services/suppliers-sim python -m suppliers_sim
uv run --locked --directory services/suppliers-sim --with pytest==9.1.1 pytest -q
```

`tests/test_sim.py` runs in process over A2A and checks that every card and reply carries the label, that the card URL is the
configured public URL, that prices follow the personalities worked out by hand, and that the discounter's minimum order sits
only in its terms sentence.

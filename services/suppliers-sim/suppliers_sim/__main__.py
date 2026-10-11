"""`python -m suppliers_sim`: serve the three simulated suppliers. SUPPLIERS_SIM_PUBLIC_URL is required (the cards
advertise it); SUPPLIERS_SIM_HOST / SUPPLIERS_SIM_PORT default to 127.0.0.1:8090. Reads no `.env` and no secret.
"""

from __future__ import annotations

import os

import uvicorn

from suppliers_sim.app import build_app


def main() -> None:
    app = build_app(os.environ.get("SUPPLIERS_SIM_PUBLIC_URL"))
    uvicorn.run(app, host=os.environ.get("SUPPLIERS_SIM_HOST", "127.0.0.1"), port=int(os.environ.get("SUPPLIERS_SIM_PORT", "8090")))


if __name__ == "__main__":
    main()

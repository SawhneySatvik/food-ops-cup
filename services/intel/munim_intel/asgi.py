"""ASGI entry for a host that imports the app instead of running `python -m munim_intel` (`uvicorn
munim_intel.asgi:app`; a serverless Python runtime imports it). Config comes from the process
environment only: no `.env` file is read (the service secret, the run-token public key and provider keys are env
vars there). Log lines pass through the config's redaction, as under `__main__`."""

from __future__ import annotations

import logging

from munim_intel.app import create_app
from munim_intel.config import RedactingFilter, load_config

cfg = load_config()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
for handler in logging.getLogger().handlers:
    handler.addFilter(RedactingFilter(cfg))
app = create_app(cfg)

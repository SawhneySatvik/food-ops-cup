"""`python -m munim_intel`: serve intel on MUNIM_INTEL_URL's host and port (default 127.0.0.1:8081, where
core-api's publisher and core-worker's fan-out already point). Logs pass through the config's redaction."""

from __future__ import annotations

import logging
from pathlib import Path

import uvicorn

from munim_intel.app import create_app
from munim_intel.config import RedactingFilter, load_repo_config


def main() -> None:
    cfg = load_repo_config(Path(__file__).resolve().parents[3])
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for handler in logging.getLogger().handlers:
        handler.addFilter(RedactingFilter(cfg))
    logging.getLogger("munim_intel").info("intel: model mode %s, listening on %s:%s", cfg.model_mode, cfg.host, cfg.port)
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_config=None)


if __name__ == "__main__":
    main()

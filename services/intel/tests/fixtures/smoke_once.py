"""One recorded smoke run in a fresh process: stdin {token, public_key_pem, secret} -> the /smoke response bytes."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from munim_intel.app import create_app
from munim_intel.config import load_config


def main() -> None:
    args = json.load(sys.stdin)
    with tempfile.TemporaryDirectory() as d:
        run = Path(d)
        (run / "keys").mkdir()
        (run / "keys" / "run-token-ed25519.pub.pem").write_text(args["public_key_pem"])
        cfg = load_config(env={"MUNIM_RUN_DIR": str(run), "MUNIM_SERVICE_SECRET": args["secret"]})
        r = TestClient(create_app(cfg)).post(
            "/smoke",
            json={"text": "ping"},
            headers={"x-munim-service-secret": args["secret"], "authorization": f"Bearer {args['token']}"},
        )
        sys.stdout.buffer.write(f"{r.status_code}\n".encode() + r.content)


if __name__ == "__main__":
    main()

"""intel's one config module (project rule 20).

Reads provider keys by their exact `.env.example` names, holds Munim-internal settings (defaults in code,
generated files under the run directory) and redacts every secret value from error text and log lines.
`.env` is read only when a caller passes `env_file` — `load_repo_config` (the process entry) does; tests
never do. Nothing here writes `os.environ`: keys are handed to the model clients explicitly.
"""

from __future__ import annotations

import logging
import os
import traceback
from collections.abc import Mapping
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from dotenv import dotenv_values

# The provider keys of `.env.example` (no OPENAI key there: the openai provider is skipped loudly).
PROVIDER_KEY_NAMES = ("GEMINI_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY")
ProviderKeyName = Literal["GEMINI_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY"]
ModelMode = Literal["recorded", "live"]

DEFAULT_INTEL_URL = "http://127.0.0.1:8081"
#: Per-role ceiling on one live provider call, in seconds (W3 close ruling). A call past it fails like any provider error
#: (the ask abstains, a narration keeps its template). Override with MUNIM_MODEL_TIMEOUT_<ROLE>_S (not a secret).
DEFAULT_MODEL_TIMEOUTS_S = {"router": 20.0, "narrate": 30.0, "reason": 60.0, "vision": 90.0, "extract": 30.0, "embed": 15.0}
PUBLIC_KEY_FILE = "run-token-ed25519.pub.pem"


class ConfigError(Exception):
    """A configuration problem. Its message names variables and paths, never their values."""


class Config:
    def __init__(self, env: Mapping[str, str | None], file_values: Mapping[str, str | None], run_dir: Path) -> None:
        self._env = env
        self._keys: dict[str, str] = {}
        for name in PROVIDER_KEY_NAMES:
            v = (env.get(name) or file_values.get(name) or "").strip()
            if v:
                self._keys[name] = v
        self._secrets: list[tuple[str, str]] = []
        for name, v in self._keys.items():
            self._register(name, v)

        mode = env.get("MUNIM_MODEL_MODE") or "recorded"
        if mode not in ("recorded", "live"):
            raise ConfigError('MUNIM_MODEL_MODE must be "recorded" or "live"')
        self.model_mode: ModelMode = "live" if mode == "live" else "recorded"
        self.run_dir = Path((env.get("MUNIM_RUN_DIR") or "").strip() or run_dir)
        # Where `python -m munim_intel` listens. A URL without a port (an https base on a host that routes for us)
        # takes the scheme's default; the ASGI entry (munim_intel.asgi) never listens.
        intel = urlsplit((env.get("MUNIM_INTEL_URL") or "").strip() or DEFAULT_INTEL_URL)
        if not intel.hostname or intel.scheme not in ("http", "https"):
            raise ConfigError("MUNIM_INTEL_URL must be http(s)://<host>[:<port>]")
        self.host: str = intel.hostname
        self.port: int = intel.port or (443 if intel.scheme == "https" else 80)
        core = (env.get("MUNIM_CORE_URL") or "").strip()
        self.core_url = core or f"http://127.0.0.1:{(env.get('PORT') or '8787').strip()}"
        # The one origin a negotiation may reach (negotiate/port.py A2aSuppliers); defaults as the Makefile does.
        # Not a secret, so never read from `.env`.
        sim = (env.get("SUPPLIERS_SIM_PUBLIC_URL") or "").strip()
        self.suppliers_sim_public_url = sim or f"http://127.0.0.1:{(env.get('SUPPLIERS_SIM_PORT') or '8090').strip()}"
        # Live call timeouts per role; not secrets, so never read from `.env`.
        self.model_timeouts_s: dict[str, float] = {}
        for role, default in DEFAULT_MODEL_TIMEOUTS_S.items():
            name = f"MUNIM_MODEL_TIMEOUT_{role.upper()}_S"
            raw = (env.get(name) or "").strip()
            try:
                seconds = float(raw) if raw else default
            except ValueError:
                raise ConfigError(f"{name} must be a number of seconds") from None
            if not 0 < seconds <= 600:
                raise ConfigError(f"{name} must be in (0, 600] seconds")
            self.model_timeouts_s[role] = seconds
        # The whole ask's own time limit (`MUNIM_ASK_BUDGET_S`, seconds; not a secret): past it the Manager stops and the ask
        # stores "cannot verify", so intel answers before core stops waiting (core's MUNIM_ASK_TIMEOUT_S, set above it). Unset:
        # no limit (each call keeps its per-role timeout).
        raw = (env.get("MUNIM_ASK_BUDGET_S") or "").strip()
        try:
            budget = float(raw) if raw else None
        except ValueError:
            raise ConfigError("MUNIM_ASK_BUDGET_S must be a number of seconds") from None
        if budget is not None and not 0 < budget <= 600:
            raise ConfigError("MUNIM_ASK_BUDGET_S must be in (0, 600] seconds")
        self.ask_budget_s: float | None = budget

    def _register(self, label: str, value: str) -> None:
        if len(value) >= 4 and (label, value) not in self._secrets:
            self._secrets.append((label, value))
            # Longest first, so a secret that contains another is replaced whole.
            self._secrets.sort(key=lambda s: -len(s[1]))

    def provider_key(self, name: ProviderKeyName) -> str | None:
        return self._keys.get(name)

    def service_secret(self) -> str:
        """The core <-> intel shared secret: `MUNIM_SERVICE_SECRET`, else `<run dir>/service-secret`.

        core-api generates the file; intel only reads it, and refuses (fails closed) when there is none.
        """
        v = (self._env.get("MUNIM_SERVICE_SECRET") or "").strip()
        if not v:
            f = self.run_dir / "service-secret"
            v = f.read_text("utf8").strip() if f.is_file() else ""
        if not v:
            raise ConfigError(f"no service secret: set MUNIM_SERVICE_SECRET or start core-api to create {self.run_dir}/service-secret")
        self._register("service secret", v)
        return v

    def run_token_public_key_pem(self) -> bytes:
        """core's Ed25519 PUBLIC key: `MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM` (a literal `\\n` counts as a newline), else
        `<run dir>/keys/...pub.pem`. intel never reads the private key."""
        pem = (self._env.get("MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM") or "").strip().replace("\\n", "\n")
        if pem:
            return f"{pem}\n".encode()
        f = self.run_dir / "keys" / PUBLIC_KEY_FILE
        if not f.is_file():
            raise ConfigError(f"no run-token public key at {f}: start core-api once to create it")
        return f.read_bytes()

    def redact(self, text: str) -> str:
        for label, v in self._secrets:
            text = text.replace(v, f"[redacted:{label}]")
        return text


def load_config(env: Mapping[str, str | None] | None = None, env_file: Path | None = None, run_dir: Path = Path(".run")) -> Config:
    file_values: Mapping[str, str | None] = dotenv_values(env_file) if env_file is not None and env_file.is_file() else {}
    return Config(os.environ if env is None else env, file_values, run_dir)


def load_repo_config(root: Path) -> Config:
    """The process entry's config: `<root>/.env` (or `MUNIM_ENV_FILE`) and `<root>/.run`."""
    env_file = (os.environ.get("MUNIM_ENV_FILE") or "").strip()
    return load_config(os.environ, Path(env_file) if env_file else root / ".env", root / ".run")


class RedactingFilter(logging.Filter):
    """Attach to every handler: renders each record (traceback included) and redacts it before output."""

    def __init__(self, cfg: Config) -> None:
        super().__init__()
        self._cfg = cfg

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._cfg.redact(record.getMessage())
        record.args = None
        if record.exc_info:
            record.exc_text = self._cfg.redact("".join(traceback.format_exception(*record.exc_info)).rstrip())
            record.exc_info = None
        return True

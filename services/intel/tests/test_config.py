"""Gate: secrets are redacted in a raised error and in log lines; config reads `.env` only when told to."""

from __future__ import annotations

import asyncio
import logging
import traceback
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
from google.adk.agents import LlmAgent
from google.adk.models import BaseLlm, LlmCapabilities
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse

from conftest import GEMINI_KEY, SECRET
from munim_intel.config import Config, ConfigError, RedactingFilter, load_config
from munim_intel.runtime.context import RunContext
from munim_intel.runtime.runner import RunFailed, run_agent

CTX = RunContext(
    "01920000-0000-7000-8000-00000000000a", "01920000-0000-7000-8000-000000000002", ("*",), "ask", "brief", 2_000_000_000, "t.t.t"
)


class LeakyLlm(BaseLlm):
    """A provider whose error quotes the key, as an HTTP client error quoting a `?key=` URL would."""

    model: str = "leaky"

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities()

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        raise RuntimeError(f"401 Unauthorized for https://provider.example/v1?key={GEMINI_KEY}")
        yield LlmResponse()


class Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[tuple[str, str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append((record.name, self.format(record)))


def test_a_provider_error_leaves_the_run_redacted_and_unchained(cfg: Config) -> None:
    # The root handler as __main__ installs it: ADK logs the failing node itself, traceback included.
    capture = Capture()
    capture.addFilter(RedactingFilter(cfg))
    logging.getLogger().addHandler(capture)
    agent = LlmAgent(name="leaky", model=LeakyLlm(), instruction="x")
    try:
        with pytest.raises(RunFailed) as failed:
            asyncio.run(run_agent(agent, CTX, "hello", cfg))
    finally:
        logging.getLogger().removeHandler(capture)
    adk = [text for name, text in capture.records if name.startswith("google_adk")]
    assert adk and any("[redacted:GEMINI_API_KEY]" in t for t in adk)
    assert all(GEMINI_KEY not in t for _, t in capture.records)
    err = failed.value
    rendered = str(err) + repr(err) + "".join(traceback.format_exception(err))
    print(f"raised: {err}")
    assert "[redacted:GEMINI_API_KEY]" in str(err)
    assert GEMINI_KEY not in rendered
    assert err.__cause__ is None and err.__context__ is None


def test_log_lines_and_tracebacks_are_redacted(cfg: Config) -> None:
    cfg.service_secret()
    lines: list[str] = []

    class Sink(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(self.format(record))

    sink = Sink()
    sink.addFilter(RedactingFilter(cfg))
    log = logging.getLogger("munim_intel.test_redaction")
    log.addHandler(sink)
    try:
        try:
            raise ValueError(f"bad key {GEMINI_KEY}")
        except ValueError:
            log.exception("call failed with secret %s", SECRET)
    finally:
        log.removeHandler(sink)
    text = "\n".join(lines)
    assert "[redacted:GEMINI_API_KEY]" in text and "[redacted:service secret]" in text
    assert GEMINI_KEY not in text and SECRET not in text


def test_env_file_is_read_only_when_passed(tmp_path: Path) -> None:
    founder = tmp_path / "founder.env"
    founder.write_text(f"GEMINI_API_KEY={GEMINI_KEY}\n")
    assert load_config(env={}, run_dir=tmp_path).provider_key("GEMINI_API_KEY") is None
    from_file = load_config(env={}, env_file=founder, run_dir=tmp_path)
    assert from_file.provider_key("GEMINI_API_KEY") == GEMINI_KEY
    assert from_file.redact(f"x{GEMINI_KEY}x") == "x[redacted:GEMINI_API_KEY]x"


def test_mode_defaults_to_recorded_and_refuses_unknown_values(tmp_path: Path) -> None:
    assert load_config(env={}, run_dir=tmp_path).model_mode == "recorded"
    with pytest.raises(ConfigError):
        load_config(env={"MUNIM_MODEL_MODE": "replay"}, run_dir=tmp_path)


def test_no_service_secret_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="no service secret"):
        load_config(env={}, run_dir=tmp_path).service_secret()


def test_suppliers_sim_url_defaults_as_the_makefile_and_is_never_read_from_env_file(tmp_path: Path) -> None:
    assert load_config(env={}, run_dir=tmp_path).suppliers_sim_public_url == "http://127.0.0.1:8090"
    assert load_config(env={"SUPPLIERS_SIM_PORT": "9090"}, run_dir=tmp_path).suppliers_sim_public_url == "http://127.0.0.1:9090"
    sim = "https://sim.example"
    assert load_config(env={"SUPPLIERS_SIM_PUBLIC_URL": sim}, run_dir=tmp_path).suppliers_sim_public_url == sim
    founder = tmp_path / "founder.env"
    founder.write_text(f"SUPPLIERS_SIM_PUBLIC_URL={sim}\n")
    assert load_config(env={}, env_file=founder, run_dir=tmp_path).suppliers_sim_public_url == "http://127.0.0.1:8090"

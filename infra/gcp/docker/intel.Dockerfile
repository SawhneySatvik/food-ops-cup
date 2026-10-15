# intel (Python 3.12, Google ADK) on Cloud Run. Every route but /health needs the service secret; most also need a core-minted run token.
# Build from the repo root: docker build -f infra/gcp/docker/intel.Dockerfile .
# Dependencies come from uv.lock only (--locked); the workspace members' own code runs from source, so intel's
# repo-relative file reads keep working. uv is pinned to the version `uv sync --locked` was run with here (live probe
# 15 Oct: PyPI's latest is 0.13.1); raise it on purpose with --build-arg UV_VERSION.
FROM python:3.12-slim AS deps
ARG UV_VERSION=0.11.7
RUN pip install --no-cache-dir "uv${UV_VERSION:+==$UV_VERSION}"
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY services/intel/pyproject.toml services/intel/pyproject.toml
COPY services/suppliers-sim/pyproject.toml services/suppliers-sim/pyproject.toml
RUN uv sync --locked --no-dev --no-install-workspace --package munim-intel

FROM python:3.12-slim
WORKDIR /app
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
COPY --from=deps /app/.venv /app/.venv
COPY services/intel/munim_intel services/intel/munim_intel
COPY services/intel/fixtures services/intel/fixtures
# intel reads these two by repo-relative path (tools/grammar.py, negotiate/grammar.py, tools/ontology.py).
COPY packages/contracts/src/shared/grammar/number-words.json packages/contracts/src/shared/grammar/number-words.json
COPY packages/contracts/generated/ontology.json packages/contracts/generated/ontology.json
ENV PYTHONPATH=/app/services/intel
RUN useradd --system --no-create-home munim
USER munim
EXPOSE 8080
CMD ["sh", "-c", "exec python -m uvicorn munim_intel.asgi:app --host 0.0.0.0 --port ${PORT:-8080}"]

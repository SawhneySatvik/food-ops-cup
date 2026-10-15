# suppliers-sim on Cloud Run: three SIMULATED suppliers over A2A. Never real suppliers, never real money. It holds no secret and no data.
# Build from the repo root: docker build -f infra/gcp/docker/suppliers-sim.Dockerfile .
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
RUN uv sync --locked --no-dev --no-install-workspace --package munim-suppliers-sim

FROM python:3.12-slim
WORKDIR /app
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
COPY --from=deps /app/.venv /app/.venv
COPY services/suppliers-sim/suppliers_sim services/suppliers-sim/suppliers_sim
ENV PYTHONPATH=/app/services/suppliers-sim
RUN useradd --system --no-create-home munim
USER munim
EXPOSE 8080
ENV SUPPLIERS_SIM_HOST=0.0.0.0
CMD ["sh", "-c", "SUPPLIERS_SIM_PORT=${PORT:-8080} exec python -m suppliers_sim"]

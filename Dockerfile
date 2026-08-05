# syntax=docker/dockerfile:1
FROM python:3.14-slim

# uv for fast, reproducible dependency management.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install dependencies first for better layer caching.
COPY pyproject.toml ./
RUN uv sync --no-dev

COPY app ./app

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8000"]

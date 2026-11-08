# Sherlock WebUI — sherlock-project + a FastAPI web interface
#
# The container listens on port 80 (so `ports: "3101:80"` works in compose)
# and writes result exports to /opt/sherlock/results (mount it to persist).

FROM python:3.12-slim-bullseye

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SHERLOCK_RESULTS_DIR=/opt/sherlock/results

# sherlock-project is pinned to the upstream release this UI integrates with.
RUN pip install --no-cache-dir \
    sherlock-project==0.16.2 \
    fastapi \
    uvicorn

WORKDIR /app
COPY app/ /app/app/

RUN mkdir -p /opt/sherlock/results

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:80/healthz', timeout=3)" || exit 1

# Single worker: job state lives in process memory.
# Running as root because port 80 requires the capability in-container.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80", "--workers", "1"]

#!/bin/sh
# Re-records docs/demo.gif with VHS in Docker (no local install needed).
set -e
cd "$(dirname "$0")/.."
docker build -q -t leakfix-vhs - <<'DOCKERFILE'
FROM ghcr.io/charmbracelet/vhs
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
RUN apt-get update -q && apt-get install -yq --no-install-recommends git >/dev/null && rm -rf /var/lib/apt/lists/*
DOCKERFILE
docker run --rm -v "$PWD:/src" -w /src leakfix-vhs docs/demo.tape

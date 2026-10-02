# leakfix in a container: `docker run --rm -v "$PWD:/repo" leakfix scan /repo`.
# Also the image behind the GitHub Action (action.yml).

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:24-slim
# scan reads `git ls-files`; the mounted repo belongs to another user, so trust it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["scan", "/repo"]

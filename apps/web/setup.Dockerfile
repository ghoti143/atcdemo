# The one-shot setup service. Build context: the repo root.
#   docker build -f apps/web/setup.Dockerfile .

FROM oven/bun:1.4.5-alpine
WORKDIR /repo

# Every workspace's package.json must be present for the lockfile to match.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY tools/package.json tools/
RUN bun install --frozen-lockfile --production

COPY apps/web/db apps/web/db

WORKDIR /repo/apps/web
USER bun
CMD ["bun", "db/setup.ts"]

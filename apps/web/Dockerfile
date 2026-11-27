# The web app, for the `full` compose profile. Build context: the repo root.
#   docker build -f apps/web/Dockerfile .
#
# Three stages: the WASM package, built with Rust and wasm-pack; the web
# app, installed and built with Bun; and the runtime, which runs
# `next start`. No setting is read at build time: every one comes from the
# environment when the container starts (.env.example lists them), so one
# image serves any address.

FROM rust:1.100-slim-trixie AS wasm
# Kept in step with WASM_PACK_VERSION in .github/workflows/ci.yml.
ARG WASM_PACK_VERSION=0.15.1
# Extra flags for wasm-pack. `--no-opt` skips wasm-opt, which wasm-pack
# downloads, for a build on a network that cannot reach it.
ARG WASM_PACK_FLAGS=
RUN rustup target add wasm32-unknown-unknown
# Built from crates.io rather than downloaded, so the image builds on arm64
# as on x86_64 with nothing but cargo. A few minutes, once: the layer is
# cached until the version changes.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install wasm-pack --version "${WASM_PACK_VERSION}" --locked
WORKDIR /src
# rust-toolchain.toml is left out on purpose, as in the server's image: it
# asks for the lint components, which this build does not need.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# See crates/atc-server/Dockerfile for the cache mounts and the `touch`.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    find Cargo.toml Cargo.lock crates -type f -exec touch {} + \
    && wasm-pack build crates/atc-wasm --target web --no-pack \
       --out-dir ../../packages/atc-wasm ${WASM_PACK_FLAGS}

FROM oven/bun:1.4.5 AS build
WORKDIR /repo
# Every workspace's package.json must be present for the lockfile to match.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY tools/package.json tools/
RUN bun install --frozen-lockfile
COPY apps/web apps/web
COPY --from=wasm /src/packages/atc-wasm packages/atc-wasm
# `next build` reads no configuration; Better Auth warns that its secret is
# the default while the pages are collected, which is harmless here.
RUN cd apps/web && bun --bun next build

FROM oven/bun:1.4.5-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/apps/web apps/web
# The airspace route reads the baked files from here at run time.
COPY data/airspace data/airspace
WORKDIR /repo/apps/web
USER bun
EXPOSE 3000
CMD ["bun", "--bun", "next", "start", "--port", "3000", "--hostname", "0.0.0.0"]

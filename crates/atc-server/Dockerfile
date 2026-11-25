# Build context: the repo root.
#   docker build -f crates/atc-server/Dockerfile .

FROM rust:1.100-slim-trixie AS build
WORKDIR /src

# rust-toolchain.toml is left out on purpose: it asks for the WASM target and
# the lint components, which this image does not need.
COPY Cargo.toml Cargo.lock ./
COPY crates crates

# The cache mounts keep the registry and the compiled dependencies between
# builds. The binary is copied out because the target directory is a mount
# and does not exist in the image layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p atc-server \
    && cp target/release/atc-server /usr/local/bin/atc-server

FROM debian:trixie-slim
RUN useradd --system --no-create-home atc
COPY --from=build /usr/local/bin/atc-server /usr/local/bin/atc-server
# The recording the simulator replays. The server looks for it under its
# working directory unless ATC_SEED_FILE says otherwise.
WORKDIR /srv/atc
COPY data/seed data/seed
USER atc
EXPOSE 8080
CMD ["atc-server"]

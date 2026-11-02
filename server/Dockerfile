FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY server ./server
RUN cargo build --release -p ghost-control-server --bin ghost-control-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home ghostai
WORKDIR /home/ghostai
COPY --from=build /app/target/release/ghost-control-server /usr/local/bin/ghost-control-server
USER ghostai
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/ghostai.sqlite
VOLUME ["/data"]
EXPOSE 8787
CMD ["ghost-control-server"]

# bottleship-lan: the multiplayer relay (packages/lan-rust) as a small container.
# Build context is packages/lan-rust; see deploy/lan/docker-compose.yml.
FROM rust:1.94-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked && strip target/release/bottleship-lan

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home bslan
COPY --from=build /src/target/release/bottleship-lan /usr/local/bin/bottleship-lan
USER 10001
EXPOSE 9001
ENTRYPOINT ["/usr/local/bin/bottleship-lan", "--config", "/etc/bottleship-lan/server.json"]

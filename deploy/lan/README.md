# Self-hosting the multiplayer relay

This directory runs `bottleship-lan` (the Rust relay from [packages/lan-rust](../../packages/lan-rust/README.md)) in Docker behind an HTTPS reverse proxy. The example uses an external Docker network called `proxy` that the reverse proxy (for example Nginx Proxy Manager, Caddy or Traefik) is also attached to.

## 1. Configure

```sh
cd deploy/lan
cp server.example.json server.json
```

Edit `server.json`:

- `allowedOrigins`: the origin of the BottleShip site your players open, for example `https://games.example.org`. A browser on any other site is refused.
- `roomAccess`: `public` lets anyone who knows a room's name join it, which is what a server for friends or a demo usually wants. For private rooms with signed invitations, read [multiplayer-security.md](../../docs/multiplayer-security.md) and set `BOTTLESHIP_LAN_INVITE_KEY` in the environment (never in `server.json`).
- Do not add `gateway` routes to a server with public rooms.

## 2. Start

```sh
docker network create proxy   # once, if it does not exist yet
docker compose up -d --build
docker compose logs -f
```

The container publishes no port. It is read-only, runs as an unprivileged user and has no capabilities.

## 3. Reverse proxy

Point a host name at the server and forward it to `http://bottleship-lan:9001` with **WebSocket support on**. The relay serves both ordinary requests and WebSocket upgrades at `/socket.io/`. Pages served over HTTPS only connect to an HTTPS relay, so issue a certificate for the host name.

Check it:

```sh
curl https://lan.example.org/health
# {"service":"bottleship-lan","version":1}
```

The relay has no per-IP limits of its own. Limit connections and requests per client IP in the reverse proxy (for example nginx `limit_conn`/`limit_req`), and do not expose port 9001 directly.

## 4. Make it the default for your site

If you also build and host the BottleShip site, set `VITE_LAN_SERVER=https://lan.example.org` when building it. Your players then get your relay as the default server. Builds without this variable have no default, and players enter a server address themselves.

## Updating

```sh
git pull
docker compose up -d --build
```

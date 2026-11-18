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

## TURN for room voice

The standard setup supports direct WebRTC voice. For browsers that need a media relay, add the optional Linux coturn service. Its network, TLS, secret and verification steps are in the [voice operations guide](../../docs/multiplayer-voice-operations.md).

## Local TURN smoke

Run this from the repository root with Bun, Chrome or Chromium, and coturn
available on the same machine. The commands use OpenSSL and netcat. The
temporary coturn instance binds to
loopback. This test-only configuration allows loopback relay peers so two
synthetic microphones can exchange RTP through coturn.

```sh
(
  export BS_TURN_SMOKE_SECRET="$(openssl rand -hex 32)"
  export BS_TURN_SMOKE_URL='turn:127.0.0.1:34790?transport=tcp'
  export BS_TURN_SMOKE_CHROME=/path/to/chrome
  umask 077
  workdir="$(mktemp -d)"
  trap 'kill "${turn_pid:-}" 2>/dev/null || true; rm -rf -- "$workdir"' EXIT
  cat > "$workdir/turn.conf" <<EOF
realm=localhost
listening-ip=127.0.0.1
relay-ip=127.0.0.1
listening-port=34790
min-port=45000
max-port=45019
userdb=$workdir/turndb
pidfile=$workdir/turn.pid
log-file=stdout
no-cli
no-tls
no-dtls
no-tcp-relay
allow-loopback-peers
fingerprint
use-auth-secret
static-auth-secret=$BS_TURN_SMOKE_SECRET
EOF
  turnserver -c "$workdir/turn.conf" > "$workdir/turn.log" 2>&1 &
  turn_pid=$!

  # Start the smoke after coturn binds its listener.
  retries=50
  until nc -z 127.0.0.1 34790; do
    retries=$((retries - 1))
    if [ "$retries" -eq 0 ] || ! kill -0 "$turn_pid" 2>/dev/null; then
      cat "$workdir/turn.log" >&2
      exit 1
    fi
    sleep 0.1
  done

  bun --no-env-file deploy/lan/turn-smoke.ts
)
```

The browser uses the BottleShip chat and voice client with only TURN candidates
enabled. A passing report includes selected relay candidates and inbound and
outbound audio packets on each connection, plus chat, mute and leave. The
synthetic browser profile is created on each run. Set `BS_TURN_SMOKE_RUST` to
a built `bottleship-lan` executable to run the smoke against the Rust relay.
Two real clients on separate networks are needed to verify a production DNS,
firewall and TLS deployment.

## Updating

Use the same Compose files during updates as when starting the LAN server.

```sh
git pull
docker compose up -d --build
```

With TURN enabled, use the overlay for the update.

```sh
docker compose -f docker-compose.yml -f docker-compose.turn.yml up -d --build
```

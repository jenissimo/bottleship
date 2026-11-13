# Multiplayer

BottleShip can join several browser tabs or computers into one virtual LAN, so games
that offer LAN or "TCP/IP" multiplayer can find and join each other. Everyone connects
to the same small relay server and picks the same room name; the games then behave as
if they were on one local network.

How the networking stack works inside is described in
[multiplayer development](multiplayer-development.md).

## Play together

1. Open BottleShip (for example https://bottleship.happydog.games) and load the game.
2. In the game, open its LAN or TCP/IP multiplayer menu. The first time the game
   reaches for the network (it searches for games, hosts one or connects to an
   address), BottleShip pauses it and asks: **Create room**, **Join room** or
   **Not now**. Nothing is sent to the relay server before you choose.
3. Whoever creates the room sends the others **Copy link for a friend**. For a game
   from the library the link opens the same game and the same room; for a game you
   loaded yourself it carries only the room, and your friend needs their own copy.
   Opening the link preselects the room, so joining is one click. A room name typed
   or pasted into **Join room** works too.
4. One player hosts, the others look for games on the local network and join.

Rooms are public: anyone who knows the room name can join it. **Not now** leaves the
game as on a computer without a network (it finds no games, and connecting to
another address fails); BottleShip does not ask again until the page is reloaded.
**Remember for this game** keeps the answer for that game in this browser. Traffic
that stays inside the game itself (a launcher talking to its game, a single-player
game talking to its own local server) never asks. The network indicator in the top
bar shows the room and opens the same panel (copy the link, disconnect).
**Settings → Network** can also connect ahead of time; that counts as the answer.

The server is the deployment's default; **Advanced** in the dialog changes it.

Everyone needs the same game and the same game version. Each player gets a stable
virtual IPv4 (and IPX) address; games that ask you to type the host's address accept
the host's virtual IP, which the host's game usually shows in its lobby.

If the connection drops, the virtual address stays the same, but running games lose
their established connections. Rejoin the game after reconnecting.

## Run your own server

The LAN server is `bottleship-lan`, a small Rust program in
[packages/lan-rust](../packages/lan-rust/README.md). It needs Rust 1.94 or newer.
From the repository root:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --host 127.0.0.1 --port 9001 --public-rooms
```

These quick-start commands explicitly enable public, name-only rooms. The default is private rooms with signed invitations; see [multiplayer access and security](multiplayer-security.md) for mixed room policies, key setup and gateway permissions.

Then use `http://127.0.0.1:9001` as the server address. `GET /health` answers
`{"service":"bottleship-lan","version":1}`.

A BottleShip build offers a default server only when one is configured: set
`VITE_LAN_SERVER` (an HTTP(S) origin, for example `https://lan.example.org`) in the
build environment — for Cloudflare Pages, in the project's environment variables.
Without it the dialog asks for an address. The server must list the site's origin in
`allowedOrigins` (or `--origin`); a server that refuses the origin is reported as
"This server doesn't accept connections from this site" rather than as unreachable.

To let other machines on your network connect, listen on all interfaces and give the
others your machine's address:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --host 0.0.0.0 --port 9001 --public-rooms
```

For a server on the internet, [deploy/lan](../deploy/lan/README.md) has a Docker Compose
setup behind an HTTPS reverse proxy.

When BottleShip itself is served over HTTPS (as the public site is), the browser only
connects to an HTTPS server. Put the relay behind an HTTPS reverse proxy that forwards
both ordinary requests and WebSocket upgrades at `/socket.io/`. Origin restrictions,
resource limits and the optional gateway to native game servers are configured in a
JSON file; see the [server README](../packages/lan-rust/README.md).

To get a standalone copy of the server source, without the emulator:

```sh
bun tools/lan-conformance/export-rust-server.ts --out ../bottleship-lan
```

A TypeScript implementation of the same protocol is in
[packages/lan](../packages/lan/README.md) (`bun install`, then `bun run dev:lan`). It
is the reference implementation; the Rust server is the one to deploy.

The connection uses Socket.IO: it starts with HTTP long-polling and switches to
WebSocket when possible, so it still works where WebSocket is blocked.

## What works

- Games that use Winsock directly: TCP and UDP over IPv4 and IPv6, broadcast and
  IPv4 multicast on the virtual LAN, and IPX datagrams.
- DirectPlay 1 to 4 (dplayx) and DirectPlay 8 (dpnet) between BottleShip players:
  finding sessions, hosting, joining, players, groups, chat and messages, and the
  DirectPlay lobbies.
- Several programs of one game in the same session (launchers, lobby clients) share
  one network identity.
- Connecting to real Windows machines running DirectPlay 8 games, through a server
  gateway that you configure explicitly.

Games that have been played this way include Heroes of Might and Magic III, Worms
Armageddon, Quake II, Serious Sam, Re-Volt and Cossacks. Compatibility differs per
game; see [compatibility](compatibility.md).

## What does not work (yet)

- Online services and master servers of the original games. Only LAN and direct-IP
  modes work; an online backend would need its own implementation.
- Joining real Windows machines running DirectPlay 4 games (BottleShip-to-BottleShip
  works).
- DirectPlay security (secure sessions), NAT traversal and DirectPlay 8 host
  migration with real Windows peers.
- SPX, IPv6 multicast and some rarely used socket options.
- Reconnecting a game in place after the network connection was lost.

## Embedding

A page that embeds the emulator sets the network before loading a game:

```ts
worker.postMessage({
  type: "set_network",
  network: { serverUrl: "https://lan.example.org", room: "friends" }
});
```

The same `network` object can be passed with `load_bundle` or `load_pe`; `network: null`
disconnects. The server URL is an HTTP(S) origin without a path; a room name is 1–64
letters, digits, `_` or `-`. The worker reports progress with `network_state` messages
(offline, connecting, connected, disconnected or error). Invite links use
`?lanServer=<url-encoded server>&room=<room>`.

An embedder that wants the same ask-first behaviour sends
`{ type: "set_network_consent", mode: "ask" }`. The worker then answers the game's first
network operation with `{ type: "network_consent_request", id, api, operation, target? }`
and keeps the calling thread waiting until the page replies
`{ type: "network_consent_result", id, granted }` — after `set_network`, once
`network_state` is `connected`. Without `set_network_consent` (mode `off`) the network
follows `set_network` alone, as before. The BottleShip page answers the prompt
unattended with `?lanConsent=auto` (the URL's or saved room, else a new one); the
harness verb `networkConsent("create" | "join" | "offline")` answers an open one.

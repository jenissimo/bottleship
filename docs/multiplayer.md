# Multiplayer

BottleShip can join several browser tabs or computers into one virtual LAN, so games
that offer LAN or "TCP/IP" multiplayer can find and join each other. Everyone connects
to the same small relay server and picks the same room name; the games then behave as
if they were on one local network.

How the networking stack works inside is described in
[multiplayer development](multiplayer-development.md).

## Play together

1. Open BottleShip (for example https://bottleship.happydog.games) and load the game.
2. Open **Settings → Network**, enter the LAN server address and a room name, and
   connect. The status shows when the connection is ready.
3. Send the others an invite: **Copy invite link** puts the server and room into the
   page URL. Opening the link fills in the same settings.
4. In the game, use its LAN or TCP/IP multiplayer menu. One player hosts, the others
   look for games on the local network and join.

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
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --host 127.0.0.1 --port 9001
```

Then use `http://127.0.0.1:9001` as the server address. `GET /health` answers
`{"service":"bottleship-lan","version":1}`.

To let other machines on your network connect, listen on all interfaces and give the
others your machine's address:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --host 0.0.0.0 --port 9001
```

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

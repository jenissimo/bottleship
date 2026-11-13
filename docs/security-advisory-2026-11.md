# Multiplayer relay security advisory (November 2026)

**Affected:** the virtual-LAN relay servers in BottleShip 0.8.0: `packages/lan-rust` (the deployable server) and `packages/lan` (the TypeScript reference server, `bun run dev:lan`). The browser client and single-player games are not affected.

**Fixed in:** #308 (on `develop`; it ships with the next release).

A review of the relay against a hostile internet client found the issues below. A hostile client here is one that speaks Engine.IO/Socket.IO directly, forges `Origin` and opens many identities. No critical issue was confirmed. The relay forwards virtual-LAN traffic and does not validate any game's state, so cheating inside a game is out of scope (see "Limits" below).

| ID | Severity | Server | Issue | Fix |
| --- | --- | --- | --- | --- |
| SR-01 | high | Rust, TS | Knowing a room's name was enough to join it | Rooms are private by default and need a signed invitation (HMAC-SHA256: room, audience, expiry). Public rooms are an explicit operator choice. |
| SR-02 | high | Rust, TS | Every participant could use the operator's native gateway routes and listeners | Gateway permissions are granted per room and checked before any native operation. Public rooms get none by default. |
| SR-03 | high | Rust, TS | Disconnected clients' reconnect reservations could fill the room quota | Offline reservations are bounded separately from live capacity. |
| SR-04 | high | Rust, TS | Released-port state grew outside the queue memory budget | Per-participant and global slot budgets are reserved before insertion. A participant reuses its own oldest released slots. |
| SR-05 | high | TS | No connection limit before the handshake | Connection limit added. The TypeScript server is still meant for local use only. |
| SR-06 | medium | Rust, TS | DNS and some service messages bypassed the rate limit | Every event is charged before it is decoded. |
| SR-07 | medium | Rust | A non-ASCII byte at the start of a Socket.IO or Engine.IO packet panicked the connection task | Such packets are rejected before parsing. |
| SR-08 | medium | Rust, TS | Flooding a receiver's queue disconnected that receiver | The congesting sender is disconnected instead. |
| SR-09 | low | Rust dependencies | Tokio was pinned to a version with advisory RUSTSEC-2026-0386 | Tokio updated. CI audits the locked dependencies. |

## What operators need to do

- **Upgrade, and choose a room policy.** By default the server now refuses to start without an invitation key. Set one through `BOTTLESHIP_LAN_INVITE_KEY` for private rooms, or opt into name-only rooms with `--public-rooms` / `roomAccess.defaultVisibility: "public"`. See [multiplayer-security.md](multiplayer-security.md).
- **Grant gateway permissions only to rooms that need them.** Do not put routes into `defaultGateway` on a server with public rooms.
- **Deploy the Rust server behind a TLS reverse proxy.** Limit connections and requests per client IP there (for example nginx `limit_conn`/`limit_req`). The relay has no per-IP limits of its own. Do not expose the backend port directly.
- `bun run dev:lan` binds to loopback and keeps name-only rooms, so local play works as before.

## Limits

- The relay does not authenticate or validate game traffic. A participant admitted to a room can send anything a LAN peer could.
- With public rooms, a client that holds many live sockets can still exhaust the room and connection capacity. The per-IP limits on the proxy are the mitigation.
- A slow or stalled receiver can get the sender of reliable traffic to it disconnected before its own heartbeat timeout. Per-source receive queues are planned.

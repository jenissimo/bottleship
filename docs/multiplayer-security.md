# Multiplayer access and security

The BottleShip page connects to a relay only after the user agreed, when a game first needs the network (see [multiplayer](multiplayer.md)); until then the server never sees the visitor's address. Rust and TypeScript use the same room policy and HMAC-SHA256 invitation format. Rooms are **private by default**. A missing signing key causes startup to fail when private rooms are configured. Binding a listener to a public interface must not silently grant access to every room.

## Public rooms

To preserve name-only entry for an explicitly public installation:

```json
{ "roomAccess": { "defaultVisibility": "public" } }
```

Both CLIs also accept `--public-rooms`. Public rooms still have no native gateway permissions unless the operator grants them explicitly. A public room name is discoverable information, not a password.

Policies can mix public and private rooms:

```json
{
  "host": "127.0.0.1",
  "port": 9001,
  "allowedOrigins": ["https://bottleship.example"],
  "roomAccess": {
    "defaultVisibility": "private",
    "inviteKeyEnv": "BOTTLESHIP_LAN_INVITE_KEY",
    "audience": "bottleship-lan",
    "maxInviteTtlSeconds": 86400,
    "rooms": {
      "lobby": { "visibility": "public" },
      "friends": { "visibility": "private" }
    }
  },
  "gateway": {
    "routes": [{
      "id": "quake",
      "host": "127.0.0.1",
      "address": "203.0.113.10",
      "names": ["game.example"],
      "ports": [27910],
      "protocols": ["udp"]
    }]
  }
}
```

A named room policy inherits `defaultVisibility` when visibility is omitted. Its `gateway` permissions replace `defaultGateway`; an unlisted room uses both defaults. All gateway permission lists default to empty.

## Private rooms and invitations

Generate one installation key containing 32..64 random bytes, encode it as canonical base64, and provide it through the environment variable named by `inviteKeyEnv`. Keep the key in the service's secret store. Do not put it in JSON configuration, command-line arguments or the repository, and preserve it across restarts when existing invitations should remain valid.

For example, generate a key in PowerShell without printing it:

```powershell
$inviteBytes = New-Object byte[] 32
$inviteRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$inviteRng.GetBytes($inviteBytes)
$env:BOTTLESHIP_LAN_INVITE_KEY = [Convert]::ToBase64String($inviteBytes)
$inviteRng.Dispose()
```

Issue a one-hour invitation using the same configuration and key as the running server. These commands only issue an invitation; they do not start a listener:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --config server.json --invite friends --ttl 3600
bun packages/lan/src/cli.ts --config server.json --invite friends --ttl 3600
```

Paste the result into **Settings → Network → Invitation (private rooms)**, or pass `network.invite` when embedding. The client sends it in the Socket.IO auth object. **Copy invite link** carries it in the URL fragment `#lanInvite=...`, rather than the query string, to keep it out of ordinary HTTP request and Referer logs. The fragment does stay in the page address and browser history while connected, so a copied page URL or a screenshot of the address bar shares the invitation too. Persisted network preferences omit the invitation.

An invitation is a reusable bearer capability until its expiry. Give it only to intended participants. The server verifies the signature, exact room, installation audience, canonical payload, scope limits and expiry on entry. Expiry also retires an active connection; application messages cannot continue after the deadline. Server cleanup can lag the deadline by its normal tick interval. Restarting with a rotated key invalidates existing invitations and retires existing connections. Individual invitation revocation and one-use invitations are not implemented.

## Native gateway permissions

Room membership and native access are separate. An anonymous public participant cannot resolve or send to native routes or acquire native listeners. Ready exposes only permitted native addresses and listeners.

Grant an invitation access to selected route/listener IDs:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --config server.json --invite friends --ttl 3600 --gateway-routes quake --udp-listeners native-host --tcp-listeners game-tcp
```

The listener IDs here (`native-host`, `game-tcp`) stand for entries of `gateway.udpListeners` / `gateway.tcpListeners`, which the example configuration above does not define. The TS CLI accepts the same flags. Lists are comma-separated. Omit a flag to grant none of that permission. IDs are not checked against the configuration when signing, so a misspelled ID silently grants nothing. Use explicit route IDs in maintained configurations; routes without an ID have the compatibility ID `route-0`, `route-1`, etc., based on configuration order.

An operator can also grant common permissions to every admitted participant of a room:

```json
{
  "roomAccess": {
    "defaultVisibility": "private",
    "rooms": {
      "friends": {
        "visibility": "private",
        "gateway": { "routes": ["quake"], "udpListeners": [], "tcpListeners": [] }
      }
    }
  }
}
```

A valid invitation's gateway lists add to that room's common permissions. Native destination/port/protocol allowlists, source-IP listener ACLs, binding generations, ownership and quotas still apply. A permission does not create a route or listener absent from the server configuration. Listener permission should go only to intended hosts.

## Offline leases and port-state budgets

Both implementations accept the same top-level limits:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxOfflineRooms` | 32 | Completely offline rooms retained for reconnect |
| `maxOfflinePeersPerRoom` | 16 | Offline identities retained in each room |
| `maxBindingsPerPeer` | 1024 | Distinct protocol/local-port slots per connection |
| `maxBindingEntries` | `maxConnections` × `maxBindingsPerPeer` (262144) | Distinct slots across all live connections |

Reconnect ownership is a bounded cache, retained for at most `reconnectGraceMs`. Offline entries yield first when a new room or peer needs capacity; active peers and rooms are never evicted to make space. Set either offline quota to zero to disable that cache. Ownership is retained while its cache entry exists; public-room identities are not authenticated accounts.

A port slot includes active generations and release tombstones across relay, multicast and native operations. Reusing a slot with a newer generation does not consume another credit. A release tombstone rejects delayed traffic of the released generation. When a new slot would exceed either budget, the creating connection's oldest released slot is reclaimed instead: Core, the native gateway and the TS reference forget that tombstone, and the new slot takes its credit. Only when the connection holds no released slot (every slot is a live binding) is the creating connection retired, refunding all its credits. Global and per-peer limits therefore bound retained state even when clients send release messages without ever opening a port, while a game that cycles through the guest's 16384 ephemeral ports per protocol, closing more sockets than `maxBindingsPerPeer`, is never retired for it.

Reclaiming is a deliberate trade-off. A tombstone protects only its own participant from that participant's stale traffic, so the oldest-first reclaim keeps that protection for the most recently released `maxBindingsPerPeer` ports. A delayed packet of an older released generation could be admitted again, but only for the same participant; no other participant's state is affected.

Leaving `maxBindingEntries` unset makes the global budget `maxConnections` × `maxBindingsPerPeer`, so no group of connections staying within their own budgets can exhaust it for an honest peer. An explicit smaller value is a hard memory cap, and connections reclaim their own tombstones first when it is reached. A slot costs under 128 bytes across Core and the native gateway (measured 96 B, `core/tests/binding_memory.rs`), so the default budget of 262144 slots bounds this state to about 25 MiB.

## Message and connection admission

Every application event consumes one `maxFramesPerSecond` credit before decoding, including unknown events, malformed requests, DNS and cancellation. `maxBytesPerSecond` includes UTF-8 JSON, binary arguments, event names and frame envelopes. The shared per-connection window is one second; messages are charged once. Invalid transport framing retires that transport immediately.

Both servers cap Engine.IO sessions before room authentication (`maxConnections: 256`), raw TCP connections (`maxTcpConnections: 1024`) and unauthenticated session lifetime (`authorizationTimeoutMs: 5000`). An incomplete handshake retains capacity until timeout or close.

Reliable relay congestion retires the sending participant. The recipient remains connected; UDP still drops at capacity. The converse follows: a participant that reads slowly, or stalls on purpose until its heartbeat times out, retires the peers that send it reliable traffic (for example a game host). There is no per-source share of a recipient's queue yet. Departure notices have a separate bounded control reserve and identical notices coalesce only within the same source connection. Queued departures retain the departing session's admission credit until output drain, preventing reconnect churn from growing control state without bound. A slow recipient can therefore temporarily retain admission capacity; its normal transport heartbeat timeout eventually retires it.

## Operator statistics and privacy

Both servers can serve `GET /stats` next to `/health`. It is off by default: the path is 404 unless the environment variable named by `statsTokenEnv` (default `BOTTLESHIP_LAN_STATS_TOKEN`) holds a token of 16..512 visible ASCII characters. Generate it like the invite key (32 random bytes, base64) and keep it in the service's secret store, not in JSON, command-line arguments or the repository. Neither server logs the token or reports it in errors; only its SHA-256 digest stays in memory.

A request needs exactly one `Authorization: Bearer <token>` header. The presented value is hashed and its digest compared with the configured digest in constant time, so neither content nor length leaks through timing. A missing, repeated or wrong header gets an empty 401 with no detail. Responses are `Cache-Control: no-store` and carry no CORS headers, so a browser page on another origin cannot read them. The endpoint is a bearer capability: serve it over the deployment's HTTPS proxy, or restrict `/stats` at the proxy to operator addresses.

The response contains only process-wide totals: uptime, current/peak participants, active rooms, rooms with two or more participants, peak active rooms, accepted joins, relayed frames and bytes, configured `maxConnections`/`maxRooms` and the server version. It never contains room names, client IDs, nodes, IP addresses, invitations or per-room data.

`uniqueSessions {today, yesterday, approximate}` counts distinct handshake `clientId`s per UTC day. Each ID is immediately reduced to a truncated HMAC-SHA256 under a 32-byte random salt held only in memory; the salt is replaced at UTC midnight, so digests from different days cannot be linked and nothing can be recomputed after rotation or restart. Digests and salts are never written to disk, logged or rendered. The set is bounded at 100000 entries per day; it is checked before insertion, and once full it stops growing and the response reports `approximate: true` (the count is then a lower bound) for that day and, after midnight, for `yesterday`. Memory for the set is a few megabytes at most. If the OS random source fails at midnight, the new salt is derived from the previous in-memory salt instead.

The count is by `clientId`, not by IP address. Behind the HTTPS reverse proxy recommended above the relay sees only the proxy's address, and neither server trusts `X-Forwarded-For` (there is no trusted-proxy configuration), so an address-based count would be one visitor, and trusting a client-supplied header would let anyone inflate it. The browser client creates a random `clientId` for each emulator network session and keeps it in memory only, so the field is named `uniqueSessions`: one person with several tabs or page reloads counts several times, and a client may choose any ID. It is an approximate usage indicator, not an audience measurement.

Counters are relaxed integer increments on the existing join, departure and delivery paths. They do not allocate per message, are not charged to and do not change any rate limit, queue or admission budget. Only a join briefly locks the daily set. All values reset when the process restarts.

## Dependency audit and regression CI

`bun run audit:lan` queries OSV for every registry package in the five deployed Cargo lockfiles (including the upstream identity of the vendored Engine.IO fork) and the locked production dependency trees of Socket.IO server and client. It fails on every reported advisory, HTTP/lookup failure, malformed or incomplete response. There is no advisory allowlist. This scope excludes unrelated frontend/build dependencies and the unused upstream vendor lockfile.

The `LAN security` workflow runs the audit for pull requests, main/develop pushes and weekly. Its regression job builds native fixtures, runs all Rust LAN crates, TS security tests and the same real-client attack scenarios against both implementations over WebSocket and polling. Configure its status checks as required in repository branch protection when the workflow is published.

Tokio is pinned to 1.53.3 in the server, native, gateway and transport manifests and their lockfiles. The audit regression contains the actual pre-fix OSV response for `RUSTSEC-2026-0386`: Tokio 1.53.2 is reported; 1.53.3 is clean.

TLS terminates at the deployment's HTTPS/WSS proxy; keep the cleartext backend inaccessible from the internet. Origin lists are additional browser restrictions, not authentication. The relay does not validate game coordinates, damage or resources: authoritative gameplay validation belongs to the game server.

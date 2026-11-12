# Multiplayer access and security

Rust and TypeScript use the same room policy and HMAC-SHA256 invitation format. Rooms are **private by default**. A missing signing key causes startup to fail when private rooms are configured. Binding a listener to a public interface must not silently grant access to every room.

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

Paste the result into **Settings → Network → Invitation (private rooms)**, or pass `network.invite` when embedding. The client sends it in the Socket.IO auth object. **Copy invite link** carries it in the URL fragment `#lanInvite=...`, rather than the query string, to keep it out of ordinary HTTP request and Referer logs. Persisted network preferences omit the invitation.

An invitation is a reusable bearer capability until its expiry. Give it only to intended participants. The server verifies the signature, exact room, installation audience, canonical payload, scope limits and expiry on entry. Expiry also retires an active connection; application messages cannot continue after the deadline. Server cleanup can lag the deadline by its normal tick interval. Restarting with a rotated key invalidates existing invitations and retires existing connections. Individual invitation revocation and one-use invitations are not implemented.

## Native gateway permissions

Room membership and native access are separate. An anonymous public participant cannot resolve or send to native routes or acquire native listeners. Ready exposes only permitted native addresses and listeners.

Grant an invitation access to selected route/listener IDs:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --config server.json --invite friends --ttl 3600 --gateway-routes quake --udp-listeners native-host --tcp-listeners game-tcp
```

The TS CLI accepts the same flags. Lists are comma-separated. Omit a flag to grant none of that permission. Use explicit route IDs in maintained configurations; routes without an ID have the compatibility ID `route-0`, `route-1`, etc., based on configuration order.

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
| `maxBindingEntries` | 16384 | Distinct slots across all live connections |

Reconnect ownership is a bounded cache, retained for at most `reconnectGraceMs`. Offline entries yield first when a new room or peer needs capacity; active peers and rooms are never evicted to make space. Set either offline quota to zero to disable that cache. Ownership is retained while its cache entry exists; public-room identities are not authenticated accounts.

A port slot includes active generations and release tombstones across relay, multicast and native operations. Reusing a slot with a newer generation does not consume another credit. Tombstones stay until connection retirement, preserving rejection of delayed traffic. Exceeding either budget retires the creating connection and refunds all its credits. Global and per-peer limits bound retained state even when clients send release messages without ever opening a port.

## Message and connection admission

Every application event consumes one `maxFramesPerSecond` credit before decoding, including unknown events, malformed requests, DNS and cancellation. `maxBytesPerSecond` includes UTF-8 JSON, binary arguments, event names and frame envelopes. The shared per-connection window is one second; messages are charged once. Invalid transport framing retires that transport immediately.

Both servers cap Engine.IO sessions before room authentication (`maxConnections: 256`), raw TCP connections (`maxTcpConnections: 1024`) and unauthenticated session lifetime (`authorizationTimeoutMs: 5000`). An incomplete handshake retains capacity until timeout or close.

Reliable relay congestion retires the sending participant. The recipient remains connected; UDP still drops at capacity. Departure notices have a separate bounded control reserve and identical notices coalesce only within the same source connection. Queued departures retain the departing session's admission credit until output drain, preventing reconnect churn from growing control state without bound. A slow recipient can therefore temporarily retain admission capacity; its normal transport heartbeat timeout eventually retires it.

TLS terminates at the deployment's HTTPS/WSS proxy; keep the cleartext backend inaccessible from the internet. Origin lists are additional browser restrictions, not authentication. The relay does not validate game coordinates, damage or resources: authoritative gameplay validation belongs to the game server.

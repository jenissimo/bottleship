# bottleship-lan (Rust)

Standalone LAN relay and configured native game-server gateway for BottleShip. It speaks the existing LAN v1 events over Engine.IO v4 / Socket.IO v5, with WebSocket, HTTP long-polling and polling-to-WebSocket upgrade. Win32 Winsock and DirectPlay emulation runs in the emulator; this server transports its packets and owns native gateway sockets.

Rust 1.94 or newer is required. Dependencies are pinned in Cargo.lock.

```sh
cargo run --release --locked -- --host 127.0.0.1 --port 9001
cargo run --release --locked -- --config server.json
```

Set the emulator network configuration to the server URL and the same room for each participant. GET /health returns {"service":"bottleship-lan","version":1}. Stop the production CLI with Ctrl-C; shutdown waits for transport and native socket retirement. No publication or deployment is performed by this package.

## Configuration

```json
{
  "host": "127.0.0.1",
  "port": 9001,
  "allowedOrigins": ["https://bottleship.example"],
  "transports": ["polling", "websocket"],
  "gateway": {
    "routes": [
      {
        "host": "127.0.0.1",
        "address": "203.0.113.20",
        "names": ["game-server.example"],
        "ports": [2302],
        "protocols": ["udp", "tcp"]
      }
    ],
    "udpListeners": [
      {
        "id": "native-host",
        "bindHost": "127.0.0.1",
        "advertisedHost": "127.0.0.1",
        "port": 0,
        "allowedHosts": ["127.0.0.1"],
        "maxOwners": 1,
        "maxPeers": 64,
        "idleTimeoutMs": 60000
      }
    ]
  }
}
```

Route host is the configured native destination. Optional address is the address visible to the guest; optional names are guest DNS aliases. Unconfigured DNS names and native destinations are refused. IPv6 routes may use a numeric scopeId. RAW routes additionally declare protocols:["raw"], ipProtocols and, when appropriate, rawMode:"exclusive". Native destination ownership is shared across participants so exclusive raw capture cannot silently conflict with another participant.

Server limits retain the TS reference names and defaults: maxRooms128, maxPeersPerRoom64, maxBufferedFrames64, maxBufferedBytes1048576, maxFramesPerSecond2000, maxBytesPerSecond4194304 and reconnectGraceMs60000. Rust additionally bounds the process through maxConnections256, maxNativeParticipants256, maxDnsOperations64 and dnsTimeoutMs10000. All are JSON fields in camelCase. allowedOrigins defaults to "*", matching the reference; explicit origin lists are recommended for an installation with a known web client.

Guest DNS requests resolve only configured route hosts. Cancellation and timeout fence late results, but cannot interrupt an in-progress OS resolver call. The server's resolver permit stays held until that call finishes; repeated cancellation cannot create unlimited detached lookups. dnsTimeoutMs bounds the result wait, not the lifetime of the OS call.

During startup, a numeric bind host skips DNS. A bind hostname has one dnsTimeoutMs interval; configured route hostnames then share one further deadline, including time spent waiting for a resolver permit. A route timeout records TRY_AGAIN and allows ordinary rooms and /health to start. A bind-host timeout fails startup without opening a listener. Timed-out OS calls can still delay Tokio runtime destruction.

Ordinary UDP and TCP work without a helper. The optional gateway.nativeUdpHelperPath selects the measured bound-UDP helper with exact original-tuple asynchronous ICMP attribution. gateway.nativeHelperPath selects the native TCP urgent-data/options backend and RAW backend. These executables use the existing BottleShip helper protocols; their canonical C sources and build tools are in ../lan/native. They are optional OS capabilities, not a fabricated success when unavailable. The plain UDP backend records unattributed OS errors rather than blaming the most recent peer.

### Native UDP Host listeners

The optional gateway.udpListeners array authorizes native IPv4 ingress separately from outgoing routes. The example listens on loopback; use addresses reachable by the intended peers for an actual installation. There are at most 32 listener definitions. Each has a unique ASCII id (letters, digits, underscore or hyphen, 1..64 characters), numeric IPv4 bindHost (0.0.0.0 is allowed), unicast advertisedHost, port (0..65535) and 1..32 distinct unicast allowedHosts. maxOwners defaults to 1 (1..64), maxPeers to 64 (1..128) and idleTimeoutMs to 60000 (1..3600000).

port:0 requests an OS-selected port. The server sends READY only after the actual bind, reporting that port with advertisedHost. A listener lease is tied to the participant, binding generation and request/lease IDs; its global owner allowance is released after physical socket closure. Incoming datagrams must match the configured source-IP ACL. Replies require a live exact IP/port tuple learned from actual received traffic; an ACL entry alone does not invent a remote endpoint. No dummy datagram is needed to admit an incoming peer.

Select the native DirectPlay8 Host provider explicitly in the emulator configuration, using the same listener ID:

```json
{
  "network": {
    "serverUrl": "http://127.0.0.1:9001",
    "room": "example",
    "directPlay8": { "provider": "native", "hostListener": "native-host" }
  }
}
```

The policy is absent by default; the existing virtual room provider remains separate. Native Host requires the advertised udpHostListenV1 capability and a successful listener READY. Unsupported native modes return an error. The currently measured native Host scope is DirectPlay8 Peer Host plus one remote participant (maxPlayers=2); the option does not establish arbitrary mesh, classic DirectPlay or complete DirectPlay8 parity.

Set logConnections:true for bounded structured connection-close diagnostics. It is disabled by default.

## Virtual IPv4 UDP multicast

The ready event advertises udpMulticast4V1:true. UDP marker `3` uses a 20-byte binary
header carrying the exact group, virtual ingress interface and TTL; ordinary
marker `2` frames and Socket.IO event arguments stay unchanged. LAN interface 2 with
TTL >= 1 fans out once to each other live room participant. Loopback interface 1
and TTL 0 stay inside the sender's emulator process family. The server rewrites
the source from its authenticated participant identity, retains the original
group, and never forwards this envelope to a native gateway. Sender binding
generations reject stale/released multicast; recipients do not inherit that
sender generation.

This profile has actual JS client tests over WebSocket and polling with matching
TS/Rust transcripts, maximum/empty payloads, room isolation, stale generations,
malformed frames and reconnect without replay. It does not implement native NIC
multicast, IPv6 multicast, source-specific membership or RAW multicast.

## Ownership and checks

The core crate owns authentication, rooms, binding generations, request IDs, cancellation and wire leases. The gateway owns physical flows and destination policy. The transport reserves both records and bytes before parsing or serialization and keeps reservations through actual output ownership. Native receive envelopes retain their credits until core effects have been admitted. Forced retirement does not require a free data-queue slot.

```sh
cargo test --locked
cargo test --locked --manifest-path core/Cargo.toml
cargo test --locked --manifest-path native/Cargo.toml
cargo test --locked --manifest-path gateway/Cargo.toml
cargo test --locked --manifest-path transport/Cargo.toml
```

Gateway tests with the optional real bound helper require BOTTLESHIP_RUST_UDP_HELPER to name that measured executable. Native examples accept helper paths explicitly. The finite examples/conformance-server launcher is for the maintained tools/lan-conformance/compare-lan-servers.ts runner; production uses the normal CLI.

Current evidence includes real JS clients on both transports, controlled upgrade, native UDP/TCP loopback, helper lifetime/credit tests and the measured native DirectPlay8 Host scope above. Windows ICMP echo NAT passed for IPv4 and IPv6 with two participants using the same original identifier, with exact packet and checksum checks. RAW UDP IPv4/IPv6 returned native permission error 10013 on the measured host; their successful packet paths are not claimed. Generic raw protocols retain destination exclusivity and the documented classification/fragment limits. Check the conformance reports for the exact source/binary identity and tested scope. These checks do not establish complete Winsock, RAW or DirectPlay parity.

The vendored Engineioxide patch is MIT; transport/vendor/UPSTREAM.md records its source and changes. BottleShip-derived code is Apache-2.0; see LICENSE and NOTICE.

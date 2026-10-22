# bottleship-lan

Standalone virtual LAN relay for BottleShip. This directory can be moved into its
own repository: the server and its protocol have no emulator imports.

Requires Bun. Windows Worker development tests require **Bun 1.4.3 or newer**.
Bun 1.3.0 can crash during repeated Worker/SharedArrayBuffer teardown even without
BottleShip imports or sockets. The standalone reproduction is
`bun tools/lan-conformance/worker-finalization-minimal.mjs 100` from the repository
root. The same reproduction passed 100 cycles on Bun 1.4.3 and Node 22.14.0;
the full actor probe and three repeated composition suites also passed on 1.4.3.
See `tools/lan-conformance/worker-finalization-probe.ts` for the actor probe.
Check the selected runtime with `bun --version` before running Worker tests.

From this directory:

```sh
bun install
bun run start --host 127.0.0.1 --port 9001
bun test
bun run typecheck
```

From the BottleShip repository, use `bun run dev:lan`.

Set the emulator's network configuration to:

```json
{
  "network": {
    "serverUrl": "http://127.0.0.1:9001",
    "room": "friends"
  }
}
```

Players in the same room share a virtual 10.0.0.0/8 LAN and IPv6 ULA addresses
under `fd42:6273:6c61:6e00::/80`. Room names contain 1–64
ASCII letters, digits, underscores or hyphens. Different rooms cannot exchange
unicast or broadcast traffic, including when they use the same virtual addresses.

Socket.IO starts with HTTP long-polling and upgrades to WebSocket when available.
If WebSocket is blocked, polling remains active. TCP and DirectPlay channels use
ordered reliable delivery while the connection is alive. IPX/UDP retain datagram
boundaries and may lose packets under congestion. A reconnect does not replay old
datagrams or restore TCP streams: the emulator receives a disconnect notification,
and TCP connections must be established again.

The default listener is loopback. To listen on a LAN interface and restrict browser
origins, run:

```sh
bun run start --host 0.0.0.0 --port 9001 --origin https://bottleship.example
```

Multiple origins can be comma-separated. An HTTPS emulator page requires an HTTPS
relay URL: terminate TLS at a reverse proxy and forward both normal HTTP requests
and WebSocket upgrades under `/socket.io/`. The root path `/health` returns the
service name and protocol version. The relay does not host game files.

Rooms currently use knowledge of the room name as admission. There is no account
service or public room directory; use unguessable room names for private sessions.
The resume identity is random, lives in worker memory and only protects an
address lease from being claimed by another participant.

## Protocol

Protocol version 1 uses Socket.IO 4 over Engine.IO. This is not a raw WebSocket
endpoint. The handshake auth object is:

```ts
{ version: 1, room: string, clientId: string, node: number[6] }
```

A locally generated node has the form `02:00:00:a:b:c`, corresponding to IPv4
`10.a.b.c`. The relay verifies and reserves this address without changing it after
game sockets have bound. A reconnect by the same identity retains its lease for
60 seconds; a fresh identity cannot take an existing lease. The server emits
`ready { version, node, ipv4, gatewayIpv4, gatewayIpv6 }` after accepting the participant.

`frame(bytes, bindingGeneration?)` carries an optional nonzero uint32 generation
for the sender's local protocol/port binding. `releasePort(proto, port, generation)`
retires that generation when its last owner closes. Native replies and socket
errors carry the destination binding's generation; forwarded LAN peer frames do
not inherit the sender's generation. Releases share the reliable FIFO with DATA
and FIN, and stale releases, frames, replies and errors cannot affect a newer
binding. An omitted generation selects the legacy, untracked contract; zero is
not a wire generation. A tracked binding cannot revert to the legacy contract.

Binary `frame` bytes contain:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 1 | Datagram marker: 2 |
| 1 | 1 | Protocol: IPX=0, UDP4=1, TCP4=2, DirectPlay=3, UDP6=4, TCP6=5, raw4=6, raw6=7 |
| 2 | 6 | Destination node on send; source node on receive |
| 8 | 2 | Destination port, big-endian |
| 10 | 2 | Source port, big-endian |
| 12 | remaining | Payload |

The server emits a trusted `peerLeft { node }` event to the other participants
in the same room when a participant disconnects. Reliable sends to a disconnected
address lease also notify the sender, allowing TCP and DirectPlay to fail promptly.
The worker preserves its local adapter connection when a remote peer leaves.

The server replaces the node field with the verified sender address. Destination
`ff:ff:ff:ff:ff:ff` broadcasts within the room, excluding the sending worker;
the worker handles its own local delivery. Protocols and port bindings are
independent. The IPX channel prepends a packet-type byte and a flags byte (bit 0:
broadcast) to a guest datagram. Its wire payload limit is 548 bytes, preserving
the 546-byte guest IPX limit.
UDP6 accepts 65,527 bytes. Raw channels carry `[IP protocol, flags, packet...]`.
Flag bit 0 indicates an included IP header. With bit 1 set, the prefix expands to
`[IP protocol, flags, TTL: int16 little-endian, TOS: uint8, packet...]`; TTL is
−1 through 255. The packet itself remains bounded to 65,535 bytes, and the largest
relay frame is 65,552 bytes. Raw wire ports are 1–256: outgoing destination port
is actual packet protocol + 1, while source port is originating socket protocol + 1.
These can differ with HDRINCL. The native reply's destination port identifies the
capture owner for its generation fence. After that check, RAW4 delivery selects
the packet's actual protocol plus protocol-zero and IPPROTO_RAW subscribers.
Worker messages snapshot up to three recipient binding generations; queued
packets cannot enter newly rebound endpoints or repeat wildcard fanout.
The other channels accept 65,507 bytes. TCP stream semantics and DirectPlay session
semantics belong to the emulator.

Default resource limits are 128 rooms, 64 address leases per room, 2,000 frames
and 4 MiB per second per participant, and 64 frames/1 MiB of server output per
recipient. Invalid frames or excessive sending disconnect the participant.
Congestion drops unreliable frames; reliable-channel overflow disconnects the
affected endpoints so stream failure is visible. Application buffers and
disconnected address leases are bounded.

`createLanServer(options)` in `src/server.ts` exposes listener, origin, room,
rate, queue and lease limits for self-hosted integrations.

## Scope and validation

The relay forwards virtual LAN traffic and can bridge explicitly configured native
IPv4 and IPv6 TCP/UDP game servers. No native destinations are enabled by default. Start with
`bun run start --config server.example.json` and configure each route's actual
`host`, allowed `ports` and `protocols`. Optional `address` assigns the address
seen by guests; `names` supplies DNS aliases. This also supports forwarding a public
advertised address to a server bound on the relay's private network.

External IPv4 nodes use `02:01:a:b:c:d`, preserving all four address octets.
External IPv6 nodes use server-assigned `02:02:id32` tokens, with address mappings
provided before guest execution and refreshed by AAAA lookups. IPv4-mapped IPv6
destinations retain the IPv6 channel while the gateway opens a native IPv4 socket.
Clients cannot claim these identities. Gateway responses use the external node as
their source. Only a configured route may open native sockets; DNS resolves only
configured target names and aliases through the relay. DNS requests are bounded,
cancellable and fail on disconnect. Native connection errors propagate as Winsock
errors; TCP credit flow control bounds buffers and preserves half-close/EOF.
Every participant owns its native flows. Last-binding close releases them without
disconnecting the participant; TCP release after FIN drains accepted native writes
before close. Disconnect destroys remaining flows.

SO_KEEPALIVE and TCP_NODELAY use the actual native TCP socket in both Node and
helper backends. Both default to false. Initial SYN flags preserve options set
before connect; live option frames also work while SYNACK is pending. TCP_OPTION
values 0/1 retain OOBINLINE, 0x100/0x101 select KEEPALIVE and 0x200/0x201 select
NODELAY. SYN reserves bits 31/30/29 for inline/keepalive/nodelay respectively;
the low 29 bits carry receive credit.

The gateway does not implement proprietary authentication/master-server protocols.
Native TCP urgent data and initial/live SO_OOBINLINE use the optional native
socket backend: build it with `bun native/build.ts` and set
`gateway.nativeHelperPath` to its absolute executable path. See
[native/README.md](native/README.md). Without this backend, requests requiring
native urgent/inline capabilities fail with Winsock 10045. Exact Windows
out-of-line MSG_PEEK urgent mark placement remains a compatibility gap; native
SO_OOBINLINE preserves the actual inline stream order. See the backend notes for
the native API ambiguity and the scope of the phased echo tests.

The native raw gateway supports configured IP protocols through actual OS raw
sockets. ICMPv4/ICMPv6 echo requests use identifier NAT by default.
Configure `protocols: ["raw"]` with an explicit `ipProtocols: [1]` for ICMPv4 or
`[58]` for ICMPv6; TCP/UDP `ports` are unnecessary on a raw-only route. For example:

```json
{
  "gateway": {
    "nativeHelperPath": "C:/bottleship-lan/native/build/socket-helper.exe",
    "routes": [
      { "host": "127.0.0.1", "address": "203.0.113.80", "protocols": ["raw"], "ipProtocols": [1] }
    ]
  }
}
```

Echo identifiers are translated per participant, filtered and restored on replies,
preventing the host raw socket stack from mixing replies between rooms. IPv4
headers and ICMP checksums reflect advertised addresses; ICMPv6 checksums use the
guest IPv6 pseudoheader. Optional TTL/TOS/HOPS/TCLASS are applied to the native
socket. HDRINCL obeys host policy and rewrites the native source/destination to
the configured endpoint before sending. Permission failures remain Winsock 10013.
IPv6 routes may set a guest-visible `scopeId`; identical IPv6 address bytes with
different scopes receive separate relay tokens. A native scoped target keeps its
OS zone in `host` (for example `fe80::123%9`), independent of the advertised guest
scope. The optional helper handles native scoped UDP/TCP; DNS and received
sockaddr values preserve the guest scope.

Raw UDP (socket protocol 17) uses source-port NAT by default. Each guest UDP tuple
owns an actual kernel UDP port reservation; the raw helper rewrites ports and
pseudoheader checksums, filters the native peer and exact reply tuple, then
restores guest ports and addresses. This permits separate participants and rooms
to share a native endpoint alongside ordinary TCP/UDP flows. Native raw-socket
permissions still apply. Fragmented packets and unsupported IPv6 extension chains
fail with 10045 rather than sharing a guessed tuple.

Other raw packets use an exclusive lease on the actual native destination IP
and scope. A foreign participant's existing TCP/UDP/raw flows cause Winsock
10048; an active exclusive raw lease also blocks new foreign flows. DNS aliases
resolve to the same numeric native target before leasing, so aliases cannot
bypass this boundary. Set `rawMode: "exclusive"` on a raw route to use this
backend for echo requests too. Incoming packets are filtered by native source
and configured IP protocol; native permissions remain authoritative.

The helper rewrites raw addresses and adjusts TCP/UDP/ICMPv6 pseudoheader
checksums in both directions. This is an intermediate backend: concurrent raw
TCP and unknown-protocol multiplexing across participants still needs a complete
NAT implementation or separate native addresses. Full fragment reassembly, IPv6 extension-header traversal and multicast
membership remain unfinished. Native protocol-zero/wildcard behavior also varies
by host; virtual LAN raw fanout supports protocol zero and IPPROTO_RAW. Native
RAW6 has no next-header metadata on the current helper path: wildcard sockets
(protocol 0 or 255), or an HDRINCL packet whose protocol differs from the socket,
fail explicitly with 10045 rather than guessing a protocol from payload bytes.

Tests use actual loopback listeners, WebSocket and HTTP long-polling clients.
They cover room isolation, source rewriting, address ownership, malformed frames,
origin restrictions and reliable frame order. Worker integration tests additionally
cover maximum UDP datagrams over both transports, automatic polling fallback,
bounded reliable bursts and reconnect without stale UDP replay. Native gateway
composition tests exercise real IPv4/IPv6 TCP and UDP listeners through Winsock,
including full-size IPv6 UDP, IPv4-mapped IPv6, stream credit, partial reads, FIN/EOF,
DNS cancellation, destination rejection and connection refusal. Binding lifetime
regressions check actual UDP port release, immediate close/rebind, stale generation
rejection and separate native resources for identical guest addresses in different
rooms. TCP close/rebind tests preserve the full accepted prefix and native EOF
with both Node sockets and the native helper, through WebSocket and polling.
Native MSG_OOB
tests additionally validate urgent-only records and initial/live SO_OOBINLINE
against a separate native socket echo peer over both browser transports. UDP raw
composition tests preserve explicit native 10013 denials when raw creation is
forbidden. A separate unprivileged native oracle exercises production port NAT,
real IPv4/IPv6 UDP reservations, room tuple isolation, kernel port release and
independent full checksum verification on Windows and POSIX; it does not stand in
for successful raw capture on a host that denies that capability.

BottleShip processes and nested workers share one relay connection and LAN
identity. A shared atomic registry reserves protocol/port bindings across workers;
local traffic works while offline. A dedicated socket worker owns Winsock state;
process death releases its references and reports endpoint loss when the last
reference disappears. Wire socket identities use one atomic counter across the
process family and never reuse a guest handle as a connection identity. Child
death cancels native TCP flows, including pending connects, before a released port
can be reused. Endpoint error events carry the exact connection identity. Normal
guest exit first closes its socket aliases gracefully, then drains the persistent
socket worker's transport before reporting process exit. Forced process death
resets sockets whose last alias disappears; a socket duplicated into another live
process survives its creator. A new PE lifetime renews its authenticated process
epoch without replacing the family network identity. Local TCP and UDP continue
through relay outages.

Win32 socket ReadFile/WriteFile and their Ex variants use the kernel HANDLE
without implicitly importing its Winsock context. A reserved duplicated HANDLE
and its pending kernel I/O survive WSACleanup while that handle remains open.
Closing the issuing alias preserves its pending I/O while another real alias owns
the socket; closing the last alias cancels it. Process reset fences old requests.
CancelIo and CancelIoEx match the shared file object, with CancelIo retaining its
issuing-thread scope. Duplicates in one process share a single IOCP binding, and
issued requests retain their original completion destination after alias closure.
Cross-process IOCP association and delivery are not yet verified.
Immediate file I/O failure does not promise an event, APC or IOCP completion.
Ordinary and urgent overlapped Winsock receives progress independently, each
preserving its own issue order.

Guest IPC lifetimes are separate from the persistent root host services. Exit
cancels pending guest requests, retires guest handlers and advances its generation;
services for surviving children remain available. Starting another PE in the same
Worker requires the previous child routes to be retired. Lobby endpoints from the
old generation cannot dispatch into, or unregister state from, the new guest.
`processIpcState` in the project harness exposes this lifecycle without creating
an IPC instance. `tools/lan-conformance/compare-reload.harness.ts` compares two PE
boots against the same native reference while proving the Worker was retained;
`BS_ORACLE_BUILD` selects the reference build. `BS_IPC_RELOAD_NEGATIVE=1` suppresses
the second exit boundary as a diagnostic control and must fail, saving its state
and report under the reference build directory.

The adapter design and datagram layout derive from
[cszackrison/bottleship](https://github.com/cszackrison/bottleship).
See [NOTICE](NOTICE) and [LICENSE](LICENSE).

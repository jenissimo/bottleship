# Multiplayer over a virtual LAN

For development continuation, current checkpoints, the implementation plan and
native-oracle methodology, see [the multiplayer handoff](multiplayer-handoff.md).

BottleShip can connect browser instances to a shared virtual network. Open
**Settings → Network**, enter the LAN server address and a room name, then connect.
Everyone playing together must join the same server and room. Use the game's LAN
multiplayer menu; each guest has a stable virtual IPv4/IPX address.

**Copy invite link** includes the server and room in the page URL. Games still
need matching versions and content.

## Run a LAN server

The Rust server requires Rust 1.94 or newer. From the repository root:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --host 127.0.0.1 --port 9001
```

The default address is `http://127.0.0.1:9001`. The [Rust server](../packages/lan-rust/README.md)
has its own CLI, tests, Cargo locks and licenses. Export it into a new standalone
`bottleship-multiplayer-server` directory without importing the emulator:

```sh
bun tools/lan-conformance/export-rust-server.ts --out ../bottleship-multiplayer-server
```

The [TypeScript reference server](../packages/lan/README.md) also supports this
protocol; run it with `bun install` and `bun run dev:lan`.

To accept other machines on your LAN with the Rust server:

```sh
cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --host 0.0.0.0 --port 9001
```

Use the server machine's reachable address in the emulator. For an HTTPS emulator
page, expose the relay over HTTPS and forward both HTTP requests and WebSocket
upgrades at `/socket.io/`. See the package README for origin restrictions and
resource limits.

Socket.IO establishes HTTP long-polling and upgrades to WebSocket when possible.
Polling remains available if WebSocket is blocked. Both transports preserve packet
boundaries; TCP byte-stream semantics are implemented by the emulator.

## Configure an embedded emulator

The host sends session configuration before loading a game:

```ts
worker.postMessage({
  type: "set_network",
  network: {
    serverUrl: "https://lan.example.org",
    room: "friends"
  }
});
```

The same `network` object can be supplied in `load_bundle` or `load_pe`.
Use `network: null` to disconnect. Server URLs are HTTP(S) origins without
paths or credentials; WS(S) origins normalize to HTTP(S). Room names use
1–64 ASCII letters, numbers, underscores or hyphens.

The effective session configuration is exposed as `EmulatorConfig.network`,
survives a game reset and is inherited by child processes. It is independent of
the game bundle. The worker waits for the current configuration before starting
guest execution and posts `network_state` with an offline, connecting, connected,
disconnected or error status. Parent and child workers observe one coherent
snapshot of relay capabilities, DNS, routes and native Host listeners before
seeing the connection as ready. Reconnect revokes leases from the old generation.

An invite URL uses `?lanServer=https%3A%2F%2Flan.example.org&room=friends`.
The settings screen stores explicitly selected connections in browser preferences.

## API coverage

| Path | Implemented behavior |
| --- | --- |
| Winsock 1.1 / 2 | Shared DLL startup state and per-process descriptors; per-thread errors |
| Socket duplication | Real same-process and cross-process aliases, shared data/shutdown/port lifetime, retained sockets after source-process exit |
| IPv4 / IPv6 UDP | Bind, send/receive, broadcast, truncation, peeking and bounded queues |
| IPv4 UDP multicast | Virtual LAN/loopback groups, shared physical membership and IF/TTL/LOOP state, receiver filtering and queued-packet lifetimes |
| IPX datagrams | Addressing, socket numbers, packet types and adapter queries |
| TCP within the virtual LAN | Listen/connect/accept, partial byte-stream I/O, flow control, shutdown and EOF |
| Winsock notifications | Blocking/nonblocking I/O, select, window/event notifications, scatter/gather and overlapped event/APC completion |
| Win32 socket I/O | ReadFile/WriteFile with synchronous or overlapped sockets; shared overlapped WSA ordering/cancellation, event completion, deferred IOCP status and three-argument ReadFileEx/WriteFileEx APCs |
| DirectPlay 1 / 2 / 3 / 4, ANSI and Unicode | Discovery, host/join/close, players, groups, chat, session notifications, asynchronous SendEx/cancellation and host migration |
| DirectPlay 8 | Address components/URLs, Peer/Client/Server sessions, retained receive buffers, and a shared ThreadPool with real guest threads and caller-thread DoWork |
| Native DirectPlay 8 TCP/IP | Binary UDP discovery, Peer Connect/Send/Close and direct peer channels to configured Windows sessions; native DNET ACKs, fragmentation, metadata, player updates and retained receive buffers |
| Native IPv4 / IPv6 gateways | Explicit UDP/TCP routes and scoped DNS; optional native helper for TCP urgent data, ICMP echo and configured raw protocols |
| Process network namespace | One relay identity, shared port ownership and localhost across parent, child and descendant workers |
| Virtual interfaces | One stable LAN/loopback topology for IP Helper, interface IOCTLs and local DNS, including while the relay is disconnected |
| Classic DirectPlay Lobby | Application registration, RunApplication, connection settings, interprocess messages and retained event notifications |
| DirectPlay 8 Lobby | Separate dpnlobby.dll; client/application COM interfaces, registration, child activation, messages, settings and status notifications |
| DNS namespace lookup | ANSI/Unicode enumeration, Begin/Next/End, short-buffer retry, cancellation, scoped addresses and owner-thread result publication |
| Winsock 1.1 blocking hooks | Guest hook execution, cancellation and callable default message pump |

Virtual IPv4 UDP multicast preserves the destination group through the local
process broker and either relay transport. IP_MULTICAST_IF=0 selects the virtual
LAN; 127/8 selects loopback. TTL 0 and loopback traffic stay on the virtual host.
IP_MULTICAST_LOOP follows Windows receiver-side local-origin filtering. Remote
multicast requires a relay advertising udpMulticast4V1; an older relay returns
an unsupported-capability result immediately. This is a virtual LAN profile;
native NIC forwarding and IPv6 multicast remain separate work.

The Winsock implementation also handles MSG_WAITALL, TCP urgent data, conditional
WSAAccept callbacks, extended IPX datagram headers and raw ICMP echo. Tests against
native Windows run the same 32-bit PE in Windows and in the browser. The native
helper preserves urgent byte ordering and SO_OOBINLINE; ICMP echo uses identifier
translation and reply filtering to isolate rooms. Configured generic raw traffic
uses exclusive native destination leases across rooms and protocols. Conflicts return
WSAEADDRINUSE; this restriction remains until tuple translation or separate native
addresses allow independent sockets to coexist. Native socket permissions still apply.

Remaining gaps include SPX, native NIC multicast forwarding, IPv6/source-specific/RAW multicast, fragmented raw packets and
IPv6 extension headers, the full protocol/namespace provider catalogue,
Win32 file completion routines on sockets created without overlapped support,
positive-linger timeout/flush, less common socket options and IOCTLs,
Windows external out-of-line urgent marks, asynchronous ICMP error attribution
on the default Node UDP backend,
DirectPlay security, NATResolver, native DirectPlay Host beyond one remote Peer and classic DP4 provider wire interoperability,
DP8 Lobby launcher/descendant association and some provider scheduling policies. An explicit
unsupported result is only parity when the corresponding native provider returns it
under the same conditions.

The DirectPlay DLLs expose standard COM class factories and unload/lifetime checks.
Registration exports update the guest registry. Classic Lobby uses a process-tree
broker with real child PIDs and sends process-exit notifications. Guest completion
callbacks run on their owning guest thread; overlapped Winsock and ReadFileEx
completions discard stale memory writes after process reset. Sockets created with
WSASocket flags zero retain synchronous completion behavior, including after
WSADuplicateSocket import. OVERLAPPED Offset/OffsetHigh are preserved. For kernel
socket I/O completed asynchronously through IOCP without an event, payload data is
published before the completion packet; Internal/InternalHigh remain pending until
GetQueuedCompletionStatus dequeues that packet. Native fixtures cover both error
and successful completion, UDP truncation and cancellation.

The virtual DirectPlay session wire format connects BottleShip guests to one
another. For configured external addresses, DP8 uses native TCP/IP binary UDP
through a separate backend. A real guest PE has matched Windows in 64 observations
per transport: discovery, Peer Connect, null/Unicode metadata, a 4097-byte guaranteed
message and native echo, retained RECEIVE data and ReturnBuffer, player data updates,
and bidirectional Close with player callback contexts. A separate 74-observation
fixture covers SendTo flag and asynchronous-handle contracts. Another 121-observation
fixture verifies COPY/NOCOPY SEND_COMPLETE structures, NOCOMPLETE and reinitialization.
Those PE checks cover one guest and one native host. A separate real UDP test connects
the Bun native-wire Peer core as the third participant to a Windows host and an existing
Windows peer, then exchanges a guaranteed message directly with that peer. It passes
over direct UDP and over WebSocket/polling gateways with both Node UDP and the bound
native helper. Both native processes observe the same relay source port for the joined
participant; peer admission sends no dummy datagram. A further test runs the same x86
COM executable under Windows and in the browser as the third participant: 47 observations
match on each transport, covering Connect, three player callbacks and their contexts,
direct guaranteed peer delivery, retained receive data, ReturnBuffer and Close callbacks.
Larger mesh parity, Host with multiple remote peers, remote group mutations, name-table resynchronization,
migration and classic DP4 provider wire remain unfinished.
Native self-send with COMPLETEONPROCESS and multiple buffers has a separate failing
Windows diagnostic, including a blocked native Close; that case remains under investigation.
Virtual-LAN COMPLETEONPROCESS still lacks remote application-processing acknowledgements;
the native backend uses the provider's E0/E1 exchange.

Asynchronous sends reserve at most 256 operations and 4 MiB of payload per object.
If a completion consumer is full, notifications retain their operation slots and
retry in order. Resource rejection preserves output handles and returns E_OUTOFMEMORY.
Close cancels unfinished sends and drains their completion notifications before returning,
including with a manual ThreadPool and a full callback queue. Final COM Release and
process reset reclaim the old reservations without reviving a later object lifetime.

The relay forwards virtual guest traffic. Its optional native gateway connects
configured UDP/TCP destinations; see [gateway configuration](../packages/lan/README.md).
Unavailable proprietary game backends require their own protocol implementations.

For tuple-attributed UDP errors, build the optional bound helper with
`bun run --cwd packages/lan build:native:udp` and configure
`gateway.nativeUdpHelperPath`. It uses one native UDP socket for the binding's peer
flows, admits inbound peers through an acknowledged lease, and reports measured ICMP
port-unreachable errors on the original tuple without closing unrelated peers. Empty
datagrams consume queue slots, and close/abort retain control capacity when data queues
are full. The default Node UDP backend remains available. Scoped/multicast traffic and
other ICMP behavior need separate validation; see the [native helper guide](../packages/lan/native/README.md).

A transport reconnect retains the virtual address but does not restore established
TCP connections. Old UDP packets are discarded. Games must reconnect or rejoin
after a connection failure. Processes within one emulator session share the relay
identity and port registry. WSADuplicateSocketA/W reserves a descriptor in its target
process. Imported descriptors share data and shutdown while retaining their provider
metadata. A dedicated socket worker keeps the connection alive after the source
process exits; the last reference releases its port. A new PE boot uses a new process
epoch, so stale descriptors cannot enter the next guest lifetime.

## Verification

```sh
bun run test:lan
bun run typecheck
bun run gate
```

Tests cover actual WebSocket and polling connections, fallback, room isolation,
maximum UDP payloads, ordered streams, reconnect and guest API contracts.

The 2026-10-23 production25 checkpoint passed the full gate (6642 tests) and
70 retained SAME-PE browser fixtures (20198 DWORD observations, no differences).
It includes multicast membership/alias queues, pointer ordering/capacity and
nonblocking TCP connects to multicast destinations. The same frozen frontend
also passed connected SetPeerInfo in both guest Host/native Peer and guest
Peer/native Host roles over WebSocket and polling: 988 observations per case,
plus INFO callback query/context traces and physical UDP-port retirement.
Those four cases used the optimized standalone Rust server. The
[connected peer information oracle](../tools/lan-conformance/directplay8-peer-info.md)
describes reproducible commands and their scope. Generated evidence is retained
under `logs/lan-conformance/production-25`; this checkpoint does not establish
all-game compatibility or the remaining API/provider coverage.

On Windows with a 32-bit MinGW compiler, compare the same PE against native
Winsock and the browser emulator:

```sh
bun tools/lan-conformance/build-native.ts
bun tools/harness.ts up
bun tools/harness.ts run tools/lan-conformance/compare.harness.ts
```

Additional fixtures use `build-native.ts <fixture>` with `winsock-advanced`,
`winsock-address`, `winsock-extensions`, `winsock-iocp`, `winsock-process`,
`winsock-process-termination`, `winsock-process-identity`, `winsock-last-error`,
`winsock-raw-options`, `winsock-recvex`, `winsock-transmitfile`, `winsock-win32-result`,
`winsock-file-io`, `winsock-file-modes`, `winsock-file-ex`, `winsock-file-sync`,
`winsock-duplicate`, `winsock-duplicate-process`, `winsock-duplicate-termination`,
`winsock-namespace`, `winsock-namespace-errors`, `winsock-namespace-service`,
`winsock-blocking-hooks`, `winsock-blocking-active`, `winsock-blocking-default`,
`winsock-blocking-delegate`, `winsock-blocking-nested`, `directplay`, `directplay8`,
`directplay-com`, `directplay-lobby`, `directplay8-lobby`, `directplay8-lobby-process`,
`directplay8-lobby-identity`, `directplay8-lobby-peer-process`,
`directplay8-threadpool-only`, `directplay8-threadpool-work`,
`directplay8-send-flags`, `directplay8-send-completion`,
`directplay8-send-close-pending-cop`, `directplay8-send-close-cancel-cop`,
`directplay8-send-close-order`, `directplay8-send-close-fields`,
`directplay8-send-close-fields-copy`, `event-alias` or `readfile-ex`. The `winsock-oob-*` fixtures cover
urgent marks, repeated urgent writes and inline mode. Set `BS_ORACLE_BUILD=logs/lan-conformance/<fixture>/build.json`
for their browser comparison. The process fixtures distinguish graceful TCP EOF
from forced termination. DirectPlay fixtures record Unicode/name/data contracts,
address URL edge cases, COM factories, worker callbacks and retained receive-buffer lifetimes.
The ThreadPool fixtures verify worker creation/destruction and retained per-thread
context, synchronous Host player creation, and caller-thread callback delivery through DoWork.
The Lobby fixture launches another process, exchanges connection settings and messages,
and verifies its exit notification.
`bun tools/lan-conformance/capture-directplay8.ts --guest` starts a native DP8 host,
records its binary UDP packets and compares a real guest EnumHosts callback over
WebSocket and forced polling. It requires exclusive access to the `lan-oracle`
harness tab. Without `--guest`, the provider/gateway exchange runs without a browser.
Each fixture proves only the observations it compares.

`bun tools/network-export-audit.ts [NT5-source-root]` compares public x86 exports
with descriptors and writes `logs/lan-conformance/export-audit.json`. This audits
declarations and ordinals; it does not prove behavioral parity.

Set `BS_MINGW_CC` to select a compiler. The oracle records API observations from
Windows and compares them with the same executable under BottleShip; its build
nonce prevents old guest output from satisfying a new run. Generated binaries and
records stay under the ignored logs directory. Each comparison writes the guest
record and a `comparison-<nonce>.json` report alongside `build.json`, including
record hashes and every differing observation.

The harness command `networkState` reports the configured room, virtual address,
connection generation and packet counts.

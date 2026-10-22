# Multiplayer over a virtual LAN

BottleShip can connect browser instances to a shared virtual network. Open
**Settings → Network**, enter the LAN server address and a room name, then connect.
Everyone playing together must join the same server and room. Use the game's LAN
multiplayer menu; each guest has a stable virtual IPv4/IPX address.

**Copy invite link** includes the server and room in the page URL. Games still
need matching versions and content.

## Run a LAN server

From the repository root:

```sh
bun install
bun run dev:lan
```

The default address is `http://127.0.0.1:9001`. The server is a standalone project
under [packages/lan](../packages/lan/README.md), with its own dependencies,
license, CLI, tests and protocol. It can be extracted into a separate
`bottleship-lan` repository without importing the emulator.

To accept other machines on your LAN:

```sh
bun run dev:lan --host 0.0.0.0 --port 9001
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
disconnected or error status.

An invite URL uses `?lanServer=https%3A%2F%2Flan.example.org&room=friends`.
The settings screen stores explicitly selected connections in browser preferences.

## API coverage

| Path | Implemented behavior |
| --- | --- |
| Winsock 1.1 / 2 | Shared DLL startup state and per-process descriptors; per-thread errors |
| Socket duplication | Real same-process and cross-process aliases, shared data/shutdown/port lifetime, retained sockets after source-process exit |
| IPv4 / IPv6 UDP | Bind, send/receive, broadcast, truncation, peeking and bounded queues |
| IPX datagrams | Addressing, socket numbers, packet types and adapter queries |
| TCP within the virtual LAN | Listen/connect/accept, partial byte-stream I/O, flow control, shutdown and EOF |
| Winsock notifications | Blocking/nonblocking I/O, select, window/event notifications, scatter/gather and overlapped event/APC completion |
| Win32 socket I/O | ReadFile/WriteFile with synchronous or overlapped sockets; shared overlapped WSA ordering/cancellation, event completion, deferred IOCP status and three-argument ReadFileEx/WriteFileEx APCs |
| DirectPlay 1 / 2 / 3 / 4, ANSI and Unicode | Discovery, host/join/close, players, groups, chat, session notifications, asynchronous SendEx/cancellation and host migration |
| DirectPlay 8 | Address components/URLs, Peer/Client/Server sessions, retained receive buffers, and a shared ThreadPool with real guest threads and caller-thread DoWork |
| Native DirectPlay 8 TCP/IP | Binary UDP discovery and guest Peer Connect/Send/Close to configured Windows hosts over WebSocket or polling; native DNET ACKs, fragmentation, metadata, player updates and retained receive buffers |
| Native IPv4 / IPv6 gateways | Explicit UDP/TCP routes and scoped DNS; optional native helper for TCP urgent data, ICMP echo and configured raw protocols |
| Process network namespace | One relay identity, shared port ownership and localhost across parent, child and descendant workers |
| Classic DirectPlay Lobby | Application registration, RunApplication, connection settings, interprocess messages and retained event notifications |
| DirectPlay 8 Lobby | Separate dpnlobby.dll; client/application COM interfaces, registration, child activation, messages, settings and status notifications |
| DNS namespace lookup | ANSI/Unicode enumeration, Begin/Next/End, short-buffer retry, cancellation, scoped addresses and owner-thread result publication |
| Winsock 1.1 blocking hooks | Guest hook execution, cancellation and callable default message pump |

The Winsock implementation also handles MSG_WAITALL, TCP urgent data, conditional
WSAAccept callbacks, extended IPX datagram headers and raw ICMP echo. Tests against
native Windows run the same 32-bit PE in Windows and in the browser. The native
helper preserves urgent byte ordering and SO_OOBINLINE; ICMP echo uses identifier
translation and reply filtering to isolate rooms. Configured generic raw traffic
uses exclusive native destination leases across rooms and protocols. Conflicts return
WSAEADDRINUSE; this restriction remains until tuple translation or separate native
addresses allow independent sockets to coexist. Native socket permissions still apply.

Remaining gaps include SPX, complete multicast behavior, fragmented raw packets and
IPv6 extension headers, the full protocol/namespace provider catalogue,
Win32 file completion routines on sockets created without overlapped support,
positive-linger timeout/flush, less common socket options and IOCTLs,
Windows external out-of-line urgent marks,
DirectPlay security, NATResolver, native DirectPlay Host/full mesh and classic DP4 provider wire interoperability,
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
fixture covers SendTo flag and asynchronous-handle contracts. These checks cover
one guest and one native host. Native Host/full mesh, remote group mutations,
name-table resynchronization, migration and classic DP4 provider wire remain unfinished.

The relay forwards virtual guest traffic. Its optional native gateway connects
configured UDP/TCP destinations; see [gateway configuration](../packages/lan/README.md).
Unavailable proprietary game backends require their own protocol implementations.

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
`directplay8-lobby-identity`, `directplay8-lobby-peer-process`,\n`directplay8-threadpool-only`, `directplay8-threadpool-work`,
`event-alias` or `readfile-ex`. The `winsock-oob-*` fixtures cover
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

# Multiplayer development

How the networking stack is built, verified and extended. The user-facing guide is
[multiplayer.md](multiplayer.md); package details live in
[packages/lan](../packages/lan/README.md) and [packages/lan-rust](../packages/lan-rust/README.md).

## Goal

Networking must not be the reason a game fails to run. When someone brings up a new
game, its LAN/multiplayer code should find a working Winsock and DirectPlay, so that
game bring-up stays about graphics, input and the game's own quirks.

That means:

- **Winsock 1.1/2**: TCP, UDP (unicast, broadcast, IPv4 multicast), IPX datagrams,
  name resolution, and every I/O model games use (blocking, nonblocking, `select`,
  `WSAAsyncSelect`, `WSAEventSelect`, overlapped with events, APCs and IOCP).
- **DirectPlay 1–4** (`dplayx`) and **DirectPlay 8** (`dpnet`, `dpnlobby`): sessions,
  players, groups, messaging, lobby launch.
- **A virtual LAN** shared by browser instances through a standalone relay server
  (Rust; the TypeScript server is the reference implementation), over WebSocket with
  HTTP long-polling fallback.
- **Interop with native Windows** where the protocol is a real wire format: native
  DirectPlay 8 already; native DirectPlay 4 is in progress.

"Complete" is defined by a finite, prioritized list of contracts (see
[Scope](#scope)), not by open-ended "full parity". A contract is done when its
differential cases match native Windows.

## Sources of truth

Behavior is derived only from public material and from observation:

- the Microsoft Open Specifications: [MC-DPL4CS] (DirectPlay 4 core and service
  providers), [MC-DPL8CS] (DirectPlay 8 core), [MC-DPL8R] (DirectPlay 8 reliable
  transport), [MC-DPLHP] (DirectPlay 8 host and port enumeration), [MC-DPLNAT]
  and [MC-DPLVP];
- the Win32, Winsock and DirectX SDK documentation and public SDK headers;
- Wine as an open-source reference (behavior, not copied code);
- logs recorded on real Windows (the golden logs and fixtures under
  `tools/lan-conformance/`).

Leaked or proprietary source code is never used, quoted or cited. Where neither a
specification nor an observation covers a detail, the code says that it is an engine
choice, or rejects the case as unsupported.

## Architecture

The guest sees Win32 APIs; the browser has no sockets. Everything Windows-specific
lives in the emulator; the server only moves packets.

| Layer | Where | Owns |
| --- | --- | --- |
| Winsock | `src/worker/modules/wsa-*.ts` | API validation, socket state, I/O models, completion, LastError |
| Socket actor | `wsa-actor-*.ts` | One physical socket shared by aliases across threads and processes |
| Network namespace | `src/worker/core/network-namespace.ts`, `src/worker/net/` | Per-session relay identity, port registry, virtual interfaces, DNS, routes |
| DirectPlay 1–4 | `src/worker/modules/dplayx/` | COM, sessions, players, groups; guest↔guest wire is our own format |
| DP4 native wire | `src/worker/modules/dplayx/native-wire/` | [MC-DPL4CS] TCP/UDP messages for talking to Windows hosts (in progress; not wired into product `Open`) |
| DirectPlay 8 | `src/worker/modules/dpnet/` | COM, Peer/Client/Server, thread pool, send operations, lobby bridge |
| DP8 native wire | `src/worker/modules/dpnet/native-wire/` | [MC-DPL8CS]/[MC-DPL8R]/[MC-DPLHP] protocol for Windows peers and hosts |
| Relay protocol | `packages/lan/src/protocol.ts` | Versioned Socket.IO events, capabilities |
| Servers | `packages/lan-rust/` (production, `bottleship-lan`), `packages/lan/` (reference) | Rooms, packet relay, optional native UDP/TCP gateways |
| Native helper | `packages/lan/native/` | Optional OS-socket helper for things Node cannot do (ICMP attribution, urgent data) |

Rules worth keeping:

- The server does not implement WinAPI or game protocols. It relays datagrams and
  streams and owns explicitly configured native gateway sockets.
- One relay identity per process family; socket aliases share one physical socket;
  descriptor state is separate from physical socket lifetime; pending I/O belongs to
  the issuing thread/process epoch, so reset/Close never writes into a new lifetime.
- New server features are advertised as capabilities; an older server yields a
  meaningful error, not silent misbehaviour.
- Native DirectPlay wire and the guest↔guest virtual format are separate backends.
- Bounded queues everywhere; a limit we chose is a policy, not "Windows behaviour".
- The Rust native TCP gateway retains read credit until its transport output is
  released and waits for bounded gateway output capacity, so a slow polling client
  pushes back toward the native socket. Transport release is local ownership
  retirement, not an acknowledgment by the remote application. TCP outputs are
  serialized per gateway; UDP keeps its separate drop policy.

## Implemented API surface

| Path | Implemented behavior |
| --- | --- |
| Winsock 1.1 / 2 | Shared DLL startup state and per-process descriptors; per-thread errors |
| Socket duplication | Same-process and cross-process aliases, shared data/shutdown/port lifetime |
| IPv4 / IPv6 UDP | Bind, send/receive, broadcast, truncation, peeking and bounded queues |
| IPv4 UDP multicast | Virtual LAN/loopback groups, IF/TTL/LOOP state, receiver filtering |
| IPX datagrams | Addressing, socket numbers, packet types and adapter queries |
| TCP within the virtual LAN | Listen/connect/accept, byte-stream I/O, flow control, shutdown and EOF |
| Winsock notifications | Blocking/nonblocking, select, window/event notifications, overlapped event/APC/IOCP |
| Win32 socket I/O | ReadFile/WriteFile on sockets, overlapped ordering/cancellation, ReadFileEx/WriteFileEx |
| DirectPlay 1–4, ANSI and Unicode | Discovery, host/join/close, players, groups, chat, notifications, SendEx, host migration |
| DirectPlay 8 | Address URLs, Peer/Client/Server, retained receive buffers, ThreadPool with guest threads |
| Native DirectPlay 8 TCP/IP | Discovery, Peer Connect/Send/Close and direct peer channels to Windows sessions |
| Native IPv4 / IPv6 gateways | Explicit UDP/TCP routes and scoped DNS; optional native helper |
| Lobbies | Classic DirectPlay Lobby and the DirectPlay 8 Lobby (`dpnlobby.dll`) |

Known gaps: SPX, native NIC multicast forwarding, IPv6/source-specific/RAW multicast,
the full provider catalogue, positive-linger flush, less common socket options,
DirectPlay security and NAT resolver, native DirectPlay Host with more than one remote
peer, DP8 host migration across native peers, and the classic DP4 provider wire in
product `Open`. An explicit unsupported result is parity only when the native provider
returns it under the same conditions.

## How we verify: differential conformance

**Native Windows is the oracle.** The same 32-bit program runs on Windows and in the
emulator; their observation logs must match. This is the only kind of evidence that
counts as parity. Unit tests of our own state machines are regression tests, not
parity proof.

### Toolchain

`lanprobe` + `lan-diff` (`tools/lan-conformance/probe/`) are the conformance tool for
Winsock; see [probe/README.md](../tools/lan-conformance/probe/README.md). One generic
x86 probe interprets a `.lp` script, logging every result with symbolic
handles/ports/errors, and one runner records the native golden (`record`) and diffs
the emulator against it (`check`):

```text
# udp-connreset/closed-port.lp
s   = socket AF_INET SOCK_DGRAM 0
bind s 127.0.0.1:0
dead = udp_closed_port                 # bind+close a socket, yield its address
ioctl s SIO_UDP_CONNRESET in=u8:1
sendto s dead "abc"
recvfrom s 64                          # logged: ret=-1 err=WSAECONNRESET
```

- Handles, ports, addresses and pointers are named symbolically by the probe, so logs
  compare without post-hoc normalization. LastError is preset to 0 before each call
  and read after every call.
- Multi-role cases (`host`, `peer1`, `peer2`) run several probe processes with a small
  coordinator. A role can be pinned to native or emulated, which gives
  native↔emulated wire interop.
- Golden logs live next to their scripts: `tools/lan-conformance/cases/<area>/<case>.lp`
  and `<case>.native.log`. They are recorded once on Windows and committed; the
  emulator side then runs anywhere.
- Single-process, callback-free cases are also replayed inside `bun test` by a
  TypeScript interpreter of the same script.

The older DWORD-record fixtures (`build-native.ts` + `compare.harness.ts`, and the
`directplay*`/`winsock-*` C fixtures) remain for lifetime/IOCP contracts that need
threads, overlapped I/O and completion ports. Prefer growing probe verbs over adding
fixtures.

### Evidence levels

| Level | Evidence | Used for |
| --- | --- | --- |
| Contract | Golden native log == emulator log for the case | API parity |
| Interop | Mixed native/emulated roles complete the scenario | Wire compatibility |
| Transport | Same case over WebSocket and polling, Rust server | Production path |
| Game | Scripted two-instance session of a real game reaches gameplay | End-to-end sanity |
| Performance | Measured latency/throughput under a fixed workload | Only when measured |

A unit test or a passing component test is not parity evidence. Manual game sessions
belong in the issue or pull request that motivated them, not in this document.

## Scope

Coverage is driven by what games call. Use `tools/api-census.ts` (and
`tools/lan-conformance/net-census.ts` for the network slice) over the catalog to rank
`wsock32`/`ws2_32`/`dplayx`/`dpnet`/`dpnlobby` imports by use. That ranking is the
backlog. Confirm a row with the runtime binding census before treating it as real:
the static export index cannot see HLE exports registered at runtime.

Each contract is covered at up to three depths:

1. **Normal path**: correct results, data, ordering, notifications.
2. **Errors and arguments**: error codes, LastError, bad pointers/lengths/flags,
   state errors (not connected, closed, already bound…).
3. **Lifetime and concurrency**: close with pending I/O, aliasing, process exit,
   ordering across threads, retained buffers.

Depths 1–2 for everything on the ranked list. Depth 3 only where an application can
observe it. The emulator's own invariants (no stale writes after reset, no leaks) are
covered by unit tests regardless.

**Out of scope until a game needs it:**

- Identity of the native thread a callback returns on, stack-frame witnesses.
- Exact native thread-pool scheduling; partial-failure side effects of rejected
  IOCTLs combined with IOCP/APC.
- DP8 host migration, security/SSPI, NAT resolver; DP4 secure sessions and
  DP4 packetized (DPSP_MSG_PACKET/PACKET2) messages.
- SPX/SEQPACKET, raw-socket corner cases, IPv6 multicast, provider catalogue
  enumeration beyond what games query.
- Shared `Section` memory between workers.
- Server benchmarking beyond a basic latency/throughput smoke check.

## Workflow

1. Pick the highest-ranked open contract (or a game that fails on networking).
2. Write the case script(s); record the native log; commit both.
3. Run in the emulator; fix the **general mechanism** behind the diff (no per-game
   branches, no expected-value edits, no sleeps to hide races).
4. Run the related tests and the case; run the full gate before merging to
   `develop`.
5. Commits and golden logs are the record; do not copy hashes, job IDs or PIDs into
   documents.

When a case cannot be expressed with the probe (true multi-machine timing, NAT),
write a dedicated fixture, but treat that as the exception.

## Running things

- `bun run test:lan`: networking unit/integration tests.
- `bun run gate`: full gate; before merging.
- Native fixtures need a 32-bit MinGW compiler; point `BS_MINGW_CC` at its `gcc`.
- Browser comparisons use the project harness (`tools/harness.ts`), one fixture per tab.
  `bun tools/lan-conformance/build-native.ts <fixture>` builds a C fixture and
  `tools/lan-conformance/compare.harness.ts` compares it; generated binaries and
  records stay under the ignored `logs/` directory.
- `bun tools/lan-conformance/capture-directplay8.ts --guest` compares a native DP8
  host's EnumHosts replies with a guest over WebSocket and forced polling.
- For repeated `directplay4-com-session.ts` runs, `BS_DP4_HOST_RUN` may point at the
  output of a successful earlier run; its report and hashes are checked before the
  existing `host.exe` is reused.
- `tools/harness/diagnostics/quake2-multiplayer.ts` drives two browser tabs through a
  Quake II Demo session as an end-to-end smoke check; it needs two copies of the
  bundle with distinct game IDs.
- Rust server: `cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --port 9001`.
- Run cargo for the sub-crates from inside `packages/lan-rust/`: its `.cargo/config.toml`
  makes `core`, `gateway`, `native` and `transport` share `packages/lan-rust/target`
  (Cargo reads that config from the working directory, not from `--manifest-path`).

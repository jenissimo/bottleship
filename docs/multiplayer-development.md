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

## Architecture

The guest sees Win32 APIs; the browser has no sockets. Everything Windows-specific
lives in the emulator; the server only moves packets.

| Layer | Where | Owns |
| --- | --- | --- |
| Winsock | `src/worker/modules/wsa-*.ts` | API validation, socket state, I/O models, completion, LastError |
| Socket actor | `wsa-actor-*.ts` | One physical socket shared by aliases across threads and processes |
| Network namespace | `src/worker/core/network-namespace.ts`, `src/worker/net/` | Per-session relay identity, port registry, virtual interfaces, DNS, routes |
| DirectPlay 1–4 | `src/worker/modules/dplayx/` | COM, sessions, players, groups; guest↔guest wire is our own format |
| DirectPlay 8 | `src/worker/modules/dpnet/` | COM, Peer/Client/Server, thread pool, send operations, lobby bridge |
| DP8 native wire | `src/worker/modules/dpnet/native-wire/` | Real DNET protocol for talking to Windows peers/hosts |
| DP4 native wire | `src/worker/modules/dplayx/` + `native-wire` pieces (WIP) | Real DP4 TCP/UDP protocol; not wired into product `Open` yet |
| Relay protocol | `packages/lan/src/protocol.ts` | Versioned Socket.IO events, capabilities |
| Servers | `packages/lan-rust/` (production), `packages/lan/` (reference) | Rooms, packet relay, optional native UDP/TCP gateways |
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

## How we verify: differential conformance

**Native Windows is the oracle.** The same 32-bit program runs on Windows and in the
emulator; their observation logs must match. This is the only kind of evidence that
counts as parity. Unit tests of our own state machines are regression tests, not
parity proof.

### Toolchain

`lanprobe` + `lan-diff` (`tools/lan-conformance/probe/`) are the conformance
tool for Winsock today; see [probe/README.md](../tools/lan-conformance/probe/README.md).
One generic x86 probe interprets a `.lp` script, logging every result with
symbolic handles/ports/errors, and one runner records the native golden
(`record`) and diffs the emulator against it (`check`):

1. **`lanprobe.exe` — one generic x86 probe.** A small interpreter that reads a test
   script and performs API calls, logging every result as readable text:

   ```text
   # udp-connreset/closed-port.lp
   s   = socket AF_INET SOCK_DGRAM 0
   bind s 127.0.0.1:0
   dead = udp_closed_port                 # bind+close a socket, yield its address
   ioctl s SIO_UDP_CONNRESET in=u8:1
   sendto s dead "abc"
   recvfrom s 64                          # logged: ret=-1 err=WSAECONNRESET
   ```

   Handles, ports, addresses and pointers are named symbolically by the probe itself,
   so logs are comparable without post-hoc normalization. LastError is preset to 0
   before each call and read after every call.

2. **`lan-diff` — one runner.** Runs a case natively (Windows + MinGW build of the
   probe, built once), runs the same `lanprobe.exe` + script in the emulator through
   the harness, and prints a line diff. Multi-role cases (`host`, `peer1`, `peer2`)
   run several probe processes with a tiny coordinator (barriers by name). A role can
   be pinned to native or emulated, which gives native↔emulated wire interop for free.

3. **Committed golden logs.** `tools/lan-conformance/cases/<area>/<case>.lp` next to
   `<case>.native.log`. Native logs are recorded once on Windows and committed; the
   emulator side then runs anywhere without Windows. Re-record only when the case
   changes.

4. **Fast path inside `bun test`.** Single-process, callback-free cases can also be
   replayed by a TypeScript interpreter of the same script that calls the HLE exports
   directly (like the existing `directplay8-network-guest.test.ts` does by hand) and
   compared against the same golden log. These join the gate; full PE runs stay in a
   separate conformance suite.

The older DWORD-record fixtures (`build-native.ts` + `compare.harness.ts`) remain
for the lifetime/IOCP contracts whose probes need threads, overlapped I/O and
completion ports — the probe grows those verbs (`waits/events/APC/IOCP`, threads,
DirectPlay COM methods, callbacks logged as events) rather than growing fixture
count. Writing a new conformance check is then: write a 10–30 line script, record
native, make the emulator match. No new C, no new orchestrator, no review of the
oracle itself.

### Evidence levels

| Level | Evidence | Used for |
| --- | --- | --- |
| Contract | Golden native log == emulator log for the case | API parity |
| Interop | Mixed native/emulated roles complete the scenario | Wire compatibility |
| Transport | Same case over WebSocket and polling, Rust server | Production path |
| Game | Scripted two-instance session of a real game reaches gameplay | End-to-end sanity |
| Performance | Measured latency/throughput under a fixed workload | Only when measured |

A unit test, an export audit or a passing component test is not parity evidence.

## Scope

Coverage is driven by what games call. Use `tools/api-census.ts` over the catalog and
the LAN games we care about to rank `wsock32`/`ws2_32`/`dplayx`/`dpnet`/`dpnlobby`
imports by use. That ranking is the backlog.

Each contract is covered at up to three depths:

1. **Normal path**: correct results, data, ordering, notifications.
2. **Errors and arguments**: error codes, LastError, bad pointers/lengths/flags,
   state errors (not connected, closed, already bound…).
3. **Lifetime and concurrency**: close with pending I/O, aliasing, process exit,
   ordering across threads, retained buffers.

Depths 1–2 for everything on the ranked list. Depth 3 only where an application can
observe it (message order, close with data in flight, completion delivery). The
emulator's own invariants (no stale writes after reset, no leaks) are covered by unit
tests regardless.

**Out of scope until a game needs it** (record here instead of investigating):

- Identity of the native thread a callback returns on, stack-frame/RET witnesses,
  hardware-breakpoint observers.
- Exact native thread-pool scheduling; partial-failure side effects of rejected
  IOCTLs combined with IOCP/APC.
- DP8 host migration, security/SSPI, NAT resolver; DP4 secure sessions.
- SPX/SEQPACKET, raw-socket corner cases, IPv6 multicast, provider catalogue
  enumeration beyond what games query.
- Shared `Section` memory between workers (only if a multiplayer game requires it).
- Server benchmarking beyond a basic latency/throughput smoke check.

## Workflow

1. Pick the highest-ranked open contract (or a game that fails on networking).
2. Write the case script(s); record the native log; commit both.
3. Run in the emulator; fix the **general mechanism** behind the diff (no per-game
   branches, no expected-value edits, no sleeps to hide races).
4. Run the related tests and the case; run the full gate before merging to
   `develop`. Not after every step.
5. Update the coverage matrix (generated from case results) and the short status in
   the session handoff. Commits and golden logs are the record; do not copy hashes,
   job IDs or PIDs into documents.

When a case cannot be expressed with the probe (true multi-machine timing, NAT),
write a dedicated fixture, but treat that as the exception.

Investigations use NT5 sources (read-only, local reference tree) to understand
mechanisms and validation order; the native log decides behaviour.

## Running things

- Bun: use the project's pinned Bun. On the Windows dev machine, a portable Bun 1.4.3
  is required for the DirectPlay tests; system Bun 1.3.0 hangs on them.
- `bun run test:lan` — networking unit/integration tests.
- `bun run gate` — full gate (≈90 s); before merging.
- Native fixtures need 32-bit MinGW (`BS_MINGW_CC`, default `C:/msys64/mingw32/bin/gcc.exe`).
- Browser comparisons use the project harness (`tools/harness.ts`), one fixture per tab.
- Rust server: `cargo run --release --locked --manifest-path packages/lan-rust/Cargo.toml -- --port 9001`.
- Run cargo for the sub-crates from inside `packages/lan-rust/`: its `.cargo/config.toml`
  makes `core`, `gateway`, `native` and `transport` share `packages/lan-rust/target`
  (Cargo reads that config from the working directory, not from `--manifest-path`).

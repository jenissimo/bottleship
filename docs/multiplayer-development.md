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
- The Rust native TCP gateway retains read credit until its transport output is
  released, and waits for bounded gateway output capacity. This propagates a
  slow polling client back toward the native socket; transport release is local
  ownership retirement, not an acknowledgment by the remote application. TCP
  outputs are serialized per gateway; UDP keeps its separate drop policy. A
  bounded native TCP read batch may wait for output while the gateway processes
  unrelated guest commands. During that wait, up to 256 native events can be
  deferred in order; independent UDP receives can still use the UDP drop policy
  if no earlier non-TCP event is deferred. Intake pauses when this queue fills,
  and some commands requiring output can still wait behind TCP backpressure.
  TCP listener control notifications also wait for bounded output; a listener
  open remains cancellable until its READY or failure notification is queued.

## How we verify: differential conformance

**Native Windows is the oracle.** The same 32-bit program runs on Windows and in the
emulator; their observation logs must match. This is the only kind of evidence that
counts as parity. Unit tests of our own state machines are regression tests, not
parity proof.

For repeated `directplay4-com-session.ts` runs, set `BS_DP4_HOST_RUN` to the output
folder of a successful earlier run. The runner checks the previous report and the
source, compiler and executable hashes before reusing its existing `host.exe` path.
This avoids treating every test run as a new program in Windows Firewall. A stale
or incomplete report is rejected; omitting the variable builds a new executable.

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

### Verified coverage and open work

- Routing regressions cover local `127.x`, a remote `10.0.0.1`, and explicitly
  configured native gateway endpoints. These addresses must retain distinct routes.
- Browser runs of the actual probe executable match the native goldens for
  `udp/events` and `dp8/selfhost`. Both emulated roles of `udp/pair` match
  Windows over the Rust relay using WebSocket-only and polling-only transports.
  Rust polling responses close their HTTP connection because its lifetime is
  owned by one Engine.IO session; this avoids browser connection pooling across
  sessions. The additional connection churn has not been benchmarked.
- `dp8/interop` now has an all-native Windows host/peer baseline: host received
  the four-byte ping and both roles exited successfully. A mixed native-host /
  emulated-peer run through the Rust gateway matched all 18 host and 24 peer log
  lines against that baseline using both WebSocket-only and polling-only relays.
  The host uses the measured Windows loopback adapter and an explicitly configured
  loopback gateway route. This establishes the tested Connect, Send and Close path,
  not general DP8 parity or interoperability across machines. See the
  [probe guide](../tools/lan-conformance/probe/README.md) for setup and limitations.
  A separate native peer → our wire-host test remains implementation interop, not
  an independent Windows oracle.
- DirectPlay 4's native-session scaffold now buffers bounded early frames during
  handshake handover and drains them after the session is installed. A Windows
  host and the scaffold exchanged guaranteed player data in both directions over
  both relay transports in a laboratory fixture. The scaffold can submit to an
  explicitly authorized host player on its existing channel; arbitrary peer and
  group routing remain unsupported. Graceful close submits application-player
  deletions followed by the system-player deletion; in the fixture, the host
  independently confirmed both had disappeared. Pending player frames retain
  their actual transport peer and pass the live authorization path after handover;
  authorized remote player creates and deletes are applied to the bounded roster
  both during handover and after Join, before notifying the owner. A Windows host
  verified those changes and matching player counts over both transports. Other
  pending system mutations fail closed; groups and general peer routing are still
  unfinished. A submission only means Winsock accepted the frame, not that the host
  acknowledged it. A two-process Windows comparison also checks CREATEPLAYER and
  DESTROYPLAYER guest message packing with nonempty names and player data; the
  variable-field order depends on both the message and ANSI/Unicode interface;
  the ANSI comparison also covers CP1251 names. A synthetic COM owner receives
  authorized native roster notifications through the guest queue, including a
  real event object, short-buffer handling and ANSI/Unicode `Receive`. Product
  `Open` for a native session remains unavailable; this fixture does not execute
  a guest PE. A later laboratory fixture manually commits the native join to the
  same COM object used for discovery, then calls its `CreatePlayer`, guaranteed
  unicast `Send` to the authorized host, `Receive`, and `DestroyPlayer`. The Windows
  host observes the created ID, receives the sent payload, sends 301 ordered frames,
  and confirms the player disappeared before channel close, over both relay transports.
  The fixture invokes the deferred owner continuation itself;
  it does not exercise the guest dispatcher. Native `CreatePlayer` currently admits
  one ordinary local player; broadcast, general peer/group routing, asynchronous
  `SendEx`, general player/group operations, and product `Open` remain unavailable.
  Submission means Winsock accepted the frame, not that the host acknowledged it.
  The implementation rechecks COM ownership before returning an asynchronous native
  operation, and the output pointer before publishing the deferred player ID.
- Heroes of Might and Magic III Complete was exercised manually with two separate
  guest PE instances and the virtual DirectPlay provider over the Rust relay. The
  second player discovered and joined the host, both loaded the Arrogance scenario,
  and the turn passed from host to peer and back to host on day two. The host moved
  a hero, saved, and the guest bytes matched the committed 41549-byte save. Both
  players rejoined a new load-session, restored day two and the moved hero, and the
  host passed the turn to the peer again. Screenshots are under
  `logs/homm3-current/`. This is a manual two-client local-machine run, not a full
  game, a native-provider interoperability check, or an automated regression. A
  noisy rectangle appeared under the receiving-data overlay during turn transitions;
  its graphics cause remains uninvestigated.
- Worms Armageddon was exercised manually with two distinct guest instances over
  the Rust relay. The peer discovered and joined the host; both selected separate
  teams and loaded the same map. Dialog-template ListBox controls now materialize
  their built-in class before creation, so joining by double-click works without
  first inspecting the window state. Earlier runs stalled at “Waiting for other
  Players”, with packet index jumps and divergent progress.
  In a captured startup, both directions' broker-level TCP frame headers, lengths
  and ordering matched (109 and 110 frames respectively). This does not verify the
  entire payload or delivery to the guest socket, and does not establish the cause.
  A later socket trace showed both guests reading the initialization messages.
  The peer subsequently entered an infinite VirtualQuery walk because a sub-page
  allocator fragment was reported as a 1152-byte region. Page-rounding the reported
  fragment boundary fixes that walk, but a repeat still waited and timed out after
  roughly two and a half minutes. A separate headless browser with background timer
  throttling disabled produced one run where both displays showed corresponding
  positions across several turn changes and exchanged game messages; that run used
  temporary API tracing. Other runs, including one without tracing and with both
  players ready before the host started, reported packet index jumps and diverged.
  A native Windows host and an emulated client joined via a loopback-restricted Rust
  gateway, loaded the same map, exchanged turns, and each side's movement appeared on
  the other. Native testing also showed that an unready host cannot press Start:
  disabled child controls must be skipped during mouse hit-testing. That routing is
  fixed and confirmed in Worms, but does not by itself fix the two-emulator race.
  In another run with both players ready, full successful guest send/recv payloads
  were captured from connection through the start of the divergent match. The main
  TCP stream matched byte-for-byte in both directions: 9,071 host-to-peer bytes
  and 4,158 peer-to-host bytes, including the sequential gameplay messages preceding
  the displayed index jumps. This rules out lost, duplicated or reordered socket
  bytes in that capture, not a timing or guest-side message handling problem. On
  the host the first seven gameplay messages were read within about 3 ms, followed
  by another ten-message burst; the sender emitted those messages over a longer
  interval. The recordings used temporary tracing and are not a regression test.
  A later trace showed the lobby's timer handler consuming gameplay messages after
  the match had started. USER timer cancellation left an unobserved expiration in
  the message queue; unlike Windows, it was still delivered after KillTimer and the
  lobby handler rearmed itself. Cancellation and reset now remove unobserved due
  timers, while preserving timer messages materialized by PM_NOREMOVE and explicitly
  posted WM_TIMER messages. Native Windows checks and queue/API regression tests cover
  these distinctions. After the fix, repeated browser-to-browser local relay sessions
  reached the same map and advanced through turn changes without the observed packet
  jumps; one session ran for several minutes and both sides showed corresponding
  positions. These are local manual observations, not a complete match or a test of
  arbitrary network conditions.
- Re-Volt Full 1.10 was exercised manually with two isolated browser guests over
  the Rust local relay. The client discovered and joined the host, both appeared
  ready, and both loaded Toys in the Hood 1. During the race each accepted driving
  input; observed DirectPlay traffic included repeated host-to-client 240-byte and
  client-to-host 48-byte messages. This does not establish an entire finished race,
  gameplay synchronization under arbitrary conditions, or native interoperability.
  Three DirectPlay gaps were fixed: player properties must remain available during
  a remote-player enumeration callback; joining by instance can use an empty
  application GUID; and SendEx can omit its message-ID output, including with
  ASYNC | NOSENDCOMPLETEMSG. The first two match the Windows x86 oracle in
  `tools/lan-conformance/directplay4-enum-player-caps-oracle.c`. Its native TCP/IP
  provider returned E_NOTIMPL for all tested SendEx variants, so it does not
  establish native SendEx parity; the omitted-ID case has a guest regression test.
- Cossacks: European Wars full was exercised manually with two isolated browser
  guests and the Rust local relay. The TCP/IP host created a deathmatch; the peer
  found and joined it, and both loaded a generated map. Each player
  selected units and moved them; DirectPlay 3 Send and Receive succeeded and
  continuing traffic was observed in both directions. The sides start in different
  locations, so this check does not prove identical world state or a completed game.
  The source WGB starts a GOG video launcher that stalled in this environment; for
  the test only, copies were assigned separate game IDs and their entrypoint was set
  to the bundled `rom/dmcr.exe`. The original WGB was left intact. Screenshots are
  under `logs/cossacks-current/`; native-provider interoperability and nonlocal
  network conditions remain untested.
- Serious Sam: The First Encounter Full v1.05 was exercised manually with two
  isolated browser guests over the Rust local relay using its Winsock TCP/IP LAN
  mode. The client discovered the host, joined the Hatshepsut cooperative session,
  moved and fought an enemy. Both views reported the client's health changing from
  100 to 65 and then 10; both also showed a score of 100 after firing. The client
  disconnected and rejoined; the host log recorded its departure, a new connection,
  successful CRC verification and a second join. The archive's default player
  profile has the same character identity in both copies: changing its display name
  alone did not avoid rejection, but choosing profile 1 on the peer did. Logs and
  screenshots are under `logs/serious-sam-current/`. This local manual run does not
  prove a full campaign, arbitrary network conditions or native interoperability.
- Quake II Demo 3.14 uses Winsock UDP. On the current development build, two browser
  clients entered demo1 through the Rust relay; the peer moved, died, respawned and
  moved again, disconnected and rejoined. Both clients continued presenting through
  five minutes of idle session, with both names present in 30 server status replies.
  A production-build run also verified player-versus-player damage and a frag:
  the host log reported the peer was blasted and the server awarded the host a
  point. The test enabled cheats solely to move the peer into position, then
  disabled noclip before firing. After reconnecting, both clients stayed present
  and rendered for five minutes while the harness periodically sent movement and
  firing input. Both browsers ran on one machine using the Rust virtual-LAN relay;
  this does not establish native interoperability or performance across the Internet.
  A repeat on the current development worktree also completed the combat and
  reconnect scenario, then 30 successful status checks over 315 seconds; host
  present serial advanced from 810 to 6739 and peer from 646 to 7305. Evidence:
  `logs/quake2-multiplayer-mvy0c6zm/`. The repeatable diagnostic and its bundle
  setup are described below.

### Quake II two-client diagnostic

`tools/harness/diagnostics/quake2-multiplayer.ts` drives two named tabs in the
shared CDP Chrome and queries the actual Quake server through a third relay
participant. It checks player entry, horizontal movement using `viewpos`, a
suicide reflected in the server score, movement after respawn, disconnect/rejoin,
and a 60-second session with advancing frames. Set `BS_Q2_COMBAT=1` to enable
cheats on the test server, position the peer using noclip, disable noclip, and
verify a real blaster frag and the server score. During the observation phase it
also periodically sends movement and firing input. It captures logs and screenshots
under a fresh `logs/quake2-multiplayer-*` directory.

Use a Quake II Demo 3.14 WGB and make two copies with distinct game IDs: the
browser storage overlay is keyed by game ID, so two tabs sharing one ID would
interfere. The WGB tool rewrites its input; patch **copies**, never the original.
For example, on a Unix shell from the checkout root:

```sh
mkdir -p logs/quake2-current
cp /path/to/quake2-demo.wgb logs/quake2-current/host.wgb
cp /path/to/quake2-demo.wgb logs/quake2-current/peer.wgb
bun tools/wgb.ts patch-manifest logs/quake2-current/host.wgb gameId app:quake2-test-host
bun tools/wgb.ts patch-manifest logs/quake2-current/peer.wgb gameId app:quake2-test-peer
```

Start the development site at `127.0.0.1:5175` with `VITE_SIDECAR_PORT=3005`,
a sidecar with `BS_SIDECAR_PORT=3005`, the Rust LAN relay on `127.0.0.1:19001`,
and the shared CDP Chrome on port 9333 using the normal harness. Then run
`bun tools/harness/diagnostics/quake2-multiplayer.ts`. `WGB_HOST`, `WGB_PEER`,
`BS_DEV_ORIGIN`, `BS_LAN_URL`, and `BS_CDP_PORT` override the defaults.
`BS_Q2_DURATION_SECONDS` sets the observation period in 10-second increments
from 60 to 3600. Bundle overrides can also be HTTP URLs, which allows a production
preview to serve the two bundles from the same origin. The sidecar must be allowed
to serve chosen disk paths. The script creates and
closes only its own tabs; keep the harness tab open while it runs.

## Additional game checks (2026-11-02)

- **Diablo II: Lord of Destruction 1.14d** offers a native TCP/IP game without
  Battle.net. An initial concurrent start left both instances on the loading
  screen. In a later check, single-player loaded and a TCP/IP host entered the
  world before the peer connected by virtual IP. Both entered the same game;
  the peer moved, and its chat message appeared on the host. The initial loading
  stall remains unexplained; longer gameplay and reconnection remain untested.
- **Tiberian Sun (freeware)**: the LAN game list could not select a second
  row because the fixed-height list box returned zero for `LB_GETITEMHEIGHT`.
  After implementing the query, two isolated instances selected the game,
  joined with distinct names, accepted the setup, and loaded their respective
  starting forces on the same map. Sustained play and synchronized unit orders
  still need verification.
- **Unreal Gold**: a host opened `DmDeck16?listen` and entered the map. A
  second instance connected to the host's virtual IP, received the server's
  challenge and package list, and entered the map; another player model was
  visible. Interaction and sustained synchronization have not been established.
  The guest polls keyboard input slowly enough that harness input needs held keys.
- **Need for Speed: Porsche Unleashed**: both instances reached the network
  protocol menu, which offers LAN and direct IP. After selecting LAN, the host
  showed a black screen with a cursor; a DirectDraw surface lock was in flight
  when inspected. No lobby or race was confirmed and the cause remains open.

These are exploratory checks over isolated WGB copies and do not establish
Winsock or DirectPlay parity for the games.

## Scope

Coverage is driven by what games call. Use `tools/api-census.ts` over the catalog and
the LAN games we care about to rank `wsock32`/`ws2_32`/`dplayx`/`dpnet`/`dpnlobby`
imports by use. That ranking is the backlog.

The census ran over both bundle libraries (100 bundles, `tools/lan-conformance/net-census.ts`
aggregates the network slice): 92 bundles import no network module that needs work; the
8 that do are all third-party re-release DLLs (steam_api, GalaxyPeer, ffmpeg/avformat,
libxml2, guest dpwsockx) importing a classic surface — socket/bind/connect/send/recv,
WSAEventSelect/EnumNetworkEvents, inet_pton/WSAStringToAddress, blocking-hook ordinals.
Every one of those rows resolves to an existing HLE implementation registered at runtime
(`wsa-network-api.ts`, `wsa-blocking.ts`), which the census's static export index cannot
see — confirm with the runtime binding census on the affected bundle before treating a
row as real. The open work for games is therefore not new APIs but verified semantics:
extend the lanprobe case list against the native oracle, one contract at a time.

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

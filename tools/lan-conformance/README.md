# Native multiplayer conformance

Fixtures built by `build-native.ts` compare the same 32-bit PE executable on
Windows and in BottleShip. DirectPlay wire capture uses paired native host and
guest builds, whose separate hashes are recorded. Each comparison proves its
recorded observations, not complete API coverage or
compatibility with every game. The current native reference machine runs Windows
11 build 26300 (x64); the fixtures themselves run as x86 processes. NT5 and Wine
sources under the owner's reference directory help explain ABI and state
transitions. They are not substituted for native observations.

## Build and compare

Use the supported project Bun version. The Windows reference builder also needs
32-bit MinGW; `BS_MINGW_CC` selects its compiler.

```powershell
bun tools/lan-conformance/build-native.ts winsock-alias-iocp
$env:BS_ORACLE_BUILD = 'logs/lan-conformance/winsock-alias-iocp/build.json'
bun tools/harness.ts up
bun tools/harness.ts run tools/lan-conformance/compare.harness.ts
```

The default compiler is `C:/msys64/mingw32/bin/gcc.exe`. Each build embeds a new
nonce, runs the native executable, packages that executable in a WGB, and records
the executable and reference hashes. The browser comparison requires a complete
record with the same nonce and checks the reference hash before comparing.

Outputs stay under ignored `logs/lan-conformance/<fixture>/`:

- `build.json`: executable, WGB, native reference, nonce and hashes.
- `native/lan-oracle.bin`: original Windows observations.
- `guest-<nonce>.bin`: original browser observations.
- `comparison-<nonce>.json`: both hashes and every differing observation.

A comparison of the same build overwrites its guest record and comparison.
Preserve failed records, their reference and build metadata before rerunning.
A successful exit from a diagnostic launcher alone does not prove a comparison;
inspect its comparison report and the actual command's exit status.

## Browser ownership and source stability

The harness supports separate named tabs through `BS_TAB`, a development URL
through `BS_DEV_URL`, and a CDP port through `BS_CDP_PORT`. Use project
`tools/harness.ts` and `tools/cdp-core.ts` for browser automation.

Run one guest fixture at a time in a tab. Freeze runtime source changes throughout
a comparison queue: Vite can replace a Worker or its page facade after a readiness
check. A tab lock without a source freeze does not prevent that race. Reloading
and reading the output can require multiple harness requests; retain the final
report if the executable does not finish.

For an integrated checkpoint, record the runtime source hashes, Bun version,
browser/sidecar ports, fixture build metadata and reports. A production proof
must additionally identify the built entry script and Worker asset hashes and
serve that exact build. Earlier successful checkpoints do not validate later
runtime edits.

## Lifetime fixtures

| Fixture | Observations exercised |
| --- | --- |
| `winsock-child-native-contract` | Real suspended child, reserved native SOCKET before WSAStartup, kernel-only I/O, parent survival and child closure |
| `winsock-native-close-pending` | Pending ReadFile after issuing-alias closure and cancellation after the last real alias closes |
| `winsock-alias-io-contract` | Shared cancellation and WSA receive lifetime, with bounded read-readiness synchronization before the final receive |
| `winsock-alias-get-result` | Completion observation through a surviving alias |
| `winsock-alias-iocp` | One shared socket IOCP association, original completion key and issued-request destination |
| `winsock-iocp-late-association` | Association after ReadFile issue and its distinct IOSB publication timing |
| `winsock-iocp-port-close` | Closed-port association retention, rejected rebind and event versus no-event status publication |
| `winsock-iocp-duplicate-port` | A surviving DuplicateHandle alias to the same completion port |
| `winsock-extension-alias-lifetime` | AcceptEx, ConnectEx and TransmitFile alias lifetime |
| `directplay8-send-completion` | COPY/NOCOPY completion descriptors, completion suppression, queue queries and Close/Initialize lifetime |

A fixture's presence does not mean that its browser comparison passes. Preserve
known failures while their generic implementation is being completed.

The raw `winsock-alias-io-lifetime` fixture performs an immediate nonblocking
receive after sendto. That send does not establish receiver readiness across an
asynchronous broker. The separate contract fixture records a bounded select
result before checking the same payload; it does not remove the payload check.
Keep the raw timing-sensitive results rather than relabelling them as a pass.

The child contract fixture retains raw staging samples separately and validates
the final operation outcome. A pending API return can race an IOSB update on real
Windows; only explicitly allowed intermediate tuples are normalized. Return
values, LastError, final byte counts, data and notifications remain checked.

## DirectPlay and process reuse

`capture-directplay8.ts --guest` compares native discovery.
`capture-directplay8.ts --guest-connect` runs a real guest COM client against a
Windows-native host through WebSocket and forced polling. Its artifacts include
the packet transcript, guest comparison reports and native reference. Optional
group/mesh diagnostics are separate scenarios; a passing connect proof does not
prove those scenarios.

`compare-reload.harness.ts` performs two PE boots while checking that the same
Worker survives and that old guest IPC routes are retired. This covers a
different lifetime boundary from creating a separate child Worker.

The standalone server and native helper have their own tests under
`tools/tests/lan-*.test.ts`. `lan-helper-pressure.test.ts` compiles a finite
loopback peer and checks full TCP payload/record windows, native control results,
receive-credit progress behind blocked sends, atomic write rejection, final
stream hashes and reset with zero receive credit. The older
`lan-helper-pressure.draft.ts` is retained as historical, unintegrated material;
it is not itself passing evidence. RAW/UDP queue progress and exact Windows
out-of-line urgent marks remain separate gaps.

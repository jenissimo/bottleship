# UDP_CONNRESET native fixtures

These two single-process x86 probes retain the native Windows 11 Pro / NT 10.0.26300 x64-host observations. They are not historical Windows 98/XP provider oracles. All network traffic uses IPv4/IPv6 loopback. Dynamic native handles, addresses, TIDs, ports and durations are absent from the compared record; actual ports remain in a separate retirement audit.

| Fixture | Compared DWORDs (excluding the 3-word header) | Tagged records | Native nonce |
| --- | ---: | ---: | ---: |
| `winsock-udp-connreset` | 6168 | 560 | 1766116734 |
| `winsock-udp-connreset-iocp-apc-effect` | 976 | 123 | 1767128281 |

The PE/ref are the original measured bytes. These are eligible subsets, **not the full 9451-observation v2/v3 investigation**. In particular, neither probe covers WSARecvMsg, source-sockaddr copyback on UDP errors, invalid non-NULL OVERLAPPED/routine pointers, RAW/IPX, or cross-process flag toggles.

The maintained C and schema files are byte-exact archival copies. Their original “source only” comments/status and the portable schema's unverified estimate of 6368 are retained as provenance. The measured raw record has 6168 observations / 6171 total DWORDs. The separate effect probe has 976 observations / 979 total DWORDs. This document, new capture manifests and preparer output record the measured facts; old raw words/schema are never rewritten.

## Retained baselines

Resolve these paths relative to the original worktree's `logs/lan-conformance`, not to a new worktree's junctions:

- `stage30-udp-connreset/portable-preparation/native-first` — job `j302e80`, compiler/native exit 0, 54 exclusive port rebinds.
- `stage30-udp-connreset/iocp-apc-effect-preparation/native-first` — job `je849e5`, compiler/native exit 0, 24 exclusive port rebinds.

| Artifact | portable6168 SHA-256 | effect976 SHA-256 |
| --- | --- | --- |
| C | `0ebf6960eb770d2f838cf3e0c5333faeb27a5d621aeecdd4e1f983016060a889` | `ebeb8f4f47581068474289f70a1471c042ae51c1593e8aa1b76f80dbd91de9a3` |
| Schema | `2dc2ce6bccea5a85e264e8304c0f619a486ab88f42f464885c2cdba7df337e69` | `ed0b7ed0f2e3c8236a91ef01bcce8a740bac8e46d891b2c8fde4f6a9ff08c67b` |
| PE | `2c2380a94009daa129178d4d0deeb1cd16f2349db82628d57f302f82d74c4d84` | `2f598d655aa2d48585421cd37fa03b72c7604b1e01506952229c15308cbd3cae` |
| Reference | `4f6eca17e4e07820f6fa8cd198d1fa5313d7b6149df3e662528ee7c11ef1d14d` | `d5bc21485228c64cc2c79f8b9cbaae2f1a1ad749fcb38ba5c245b2d158e9a28b` |

## What is measured

The portable probe includes Winsock 1.1/2.2 startup; IPv4/IPv6 UDP and TCP/invalid-handle precedence; 250 pointer/length cases; first-byte BOOLEAN semantics; no autobind; shared alias and reserved-alias lifetimes through WSACleanup/restart; queued54 preservation; live-peer controls; and 32 synchronous/event/APC/IOCP cases.

The effect probe independently measures 8 combinations: AF_INET/AF_INET6 × initial OFF/ON × old queued54/no old error. **IOCP+APC error 10022 still changes the physical option** before rejection. The old queued error is consumed separately from a fresh unreachable. Returned-byte sentinel, Internal 259/High sentinel, offsets, absent APC/IOCP packet, first byte and 16 live-peer controls are raw observations. No atomicity is inferred from the error code.

All tagged DWORDs are compared unchanged, including LastError, payload sentinels and IOSB staging. No scheduling word or pre-wait status is silently normalized. Any future unstable observation must be retained as RED and investigated using a new fixture, not hidden by this preparer.

## Validate and package the SAME PE

No compiler or native executable is invoked by the preparer. By default it pins the exact nonce/PE/ref in the table. It validates x86 PE32, all headers/nonces, every schema tag/arity, final marker, fixed record counts, the complete recorded ledger and exact port-retirement identities. Sources/schema and all inputs are hashed before/after packaging; the embedded PE is extracted and hashed again.

From the intended worktree, use a **fresh** output directory:

```powershell
$udpBun = './logs/tools/bun-portable/package/bin/bun.exe'
$udpCapture = 'C:/Projects/bottleship-oss/.wt/lan-network/logs/lan-conformance/stage30-udp-connreset/portable-preparation/native-first'
& $udpBun tools/lan-conformance/prepare-udp-connreset.ts --fixture winsock-udp-connreset --capture $udpCapture --validate-only
& $udpBun tools/lan-conformance/prepare-udp-connreset.ts --fixture winsock-udp-connreset --capture $udpCapture --output logs/lan-conformance/winsock-udp-connreset/same-pe-first --guest-os winxp

$udpEffect = 'C:/Projects/bottleship-oss/.wt/lan-network/logs/lan-conformance/stage30-udp-connreset/iocp-apc-effect-preparation/native-first'
& $udpBun tools/lan-conformance/prepare-udp-connreset.ts --fixture winsock-udp-connreset-iocp-apc-effect --capture $udpEffect --validate-only
& $udpBun tools/lan-conformance/prepare-udp-connreset.ts --fixture winsock-udp-connreset-iocp-apc-effect --capture $udpEffect --output logs/lan-conformance/winsock-udp-connreset-iocp-apc-effect/same-pe-first --guest-os winxp
```

`--guest-os` selects the emulated packaging profile (default `winxp`; explicit `win98` is also accepted). It does not relabel the modern native source or assert historical API parity. The new build manifest records both profiles. Packing still requires the coordinated build window.

After a browser grant, point the existing compare harness at the new `build.json` via `BS_ORACLE_BUILD`. This fixture is single-process and has no shared-mapping prerequisite. The watchdog remains in the original PE. Keep first RED guest/report/comparison and use a new attempt directory for any rerun.

## A new native capture

A fresh native capture is separate evidence. It does **not** replace the retained SAME-PE baseline. The runner imports only tracked code, refuses existing attempts before starting processes, records compiler/native PIDs and exits, retains source/schema/runner/helper and raw checkpoints, and verifies exclusive rebind of all audited endpoints.

```powershell
& ./logs/tools/bun-portable/package/bin/bun.exe tools/lan-conformance/run-udp-connreset-native.ts --fixture winsock-udp-connreset --attempt native-NEW
& ./logs/tools/bun-portable/package/bin/bun.exe tools/lan-conformance/run-udp-connreset-native.ts --fixture winsock-udp-connreset-iocp-apc-effect --attempt native-NEW
```

Replace `NEW` with a lowercase fresh label. The optional `--output-root` and `--compiler` are explicit paths. No credentials or environment snapshot is recorded. Default compiler: `C:/msys64/mingw32/bin/gcc.exe`; flags are the original no-CRT x86 flags.

The portable PE has a 45s internal watchdog and 60s native-host guard; the effect PE has 20s/30s guards. Both have a separate 30s compiler guard. Retirement audit has a 5s aggregate bound. The general 15s `build-native.ts` cap is deliberately not substituted. A killed process that does not retire within another 5s is an unknown-result failure with its exact PID retained. No automatic rerun or forced-success word exists.

Future captures have a new nonce/PE/ref. To package one, supply all three reviewed pins explicitly: `--nonce DWORD --executable-sha256 SHA --reference-sha256 SHA`. Source/schema and fixed coverage remain pinned. This does not authorize compilation, execution or a change to any existing expected word.

Pure parser/identity checks (no compiler/native/network/browser):

```powershell
& ./logs/tools/bun-portable/package/bin/bun.exe test tools/tests/udp-connreset-artifacts.test.ts
```

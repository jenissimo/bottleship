# Connected DirectPlay 8 peer information oracle

This fixture measures a native Host and one Peer through public x86 COM APIs. It covers connected `SetPeerInfo` NAME/DATA masks, SYNC and ASYNC, opaque contexts, source copying, GetPeerInfo during INFO, NULL versus empty storage, and graceful Close. It does not establish groups, migration, security, larger Host sessions, or performance.

`directplay8-peer-info.c` is byte-identical to the successful 988-observation native source (SHA256 `1ea01926588983162ddc31232f5a5db586949b53f7bdc63225be8964e1839c58`). The native record is `logs/lan-conformance/stage29-host-peer-info/empty-runs/1792760288734/verified.json`, SHA256 `15e2de040cde6cc4da8f5fb6ad48820362331f7fba524a49d0875f368bc9ab28`. Both processes exited 0 and both ports were rebound. The earlier 768-observation API baseline, separate D6/DB packet capture, and initial malformed-fixture RED are retained independently.

## Commands

Run a fresh native baseline in a new directory with a 32-bit compiler and caller-selected adjacent loopback ports:

```
bun tools/lan-conformance/capture-directplay8-peer-info.ts --proof <NEW-native-dir> --compiler C:/msys64/mingw32/bin/gcc.exe --host-port <free-port>
```

Reuse the existing PE and references to prepare a guest bundle. This command does not compile or execute the PE:

```
bun tools/lan-conformance/prepare-directplay8-peer-info.ts --proof <native-dir> --output <NEW-host-dir> --guest-role host
bun tools/lan-conformance/prepare-directplay8-peer-info.ts --proof <same-native-dir> --output <NEW-peer-dir> --guest-role peer
```

After the coordinator grants a browser slot and runtime source hold, set BS_TAB, BS_DEV_URL, BS_CDP_PORT, and BS_SIDECAR_PORT, then use the maintained harness controller:

```
bun tools/lan-conformance/interop-directplay8-peer-info.ts --proof <prepared-dir> --output <NEW-proof-dir> --server-exe <conformance-server.exe> --listener-id peer-info --transport websocket
```

The preparation defaults to Host. `--guest-role peer` creates a separate WGB whose sole role selector is `manifest.args="--peer"`; it preserves the PE and both role references. The packer verifies the embedded `rom/lan-oracle.exe` SHA and role arguments.

For the reverse direction, use the maintained reverse controller with the Peer WGB and the coordinator's final source freeze manifest:

```
bun tools/lan-conformance/interop-directplay8-peer-info-reverse.ts --proof <prepared-peer-dir> --output <NEW-proof-dir> --server-exe <conformance-server.exe> --source-manifest <FINAL-freeze-source.json> --transport websocket
```

The reverse runner verifies the final manifest `source:{relativePath:SHA256}`, warms the guest worker/network before starting the native Host's unchanged eight-second wait, then boots the guest Peer. It configures one exact UDP route to native 127.0.0.1:55172 rather than a Host listener. The Guest Peer closes first. It captures actual gateway UDP address/ports only for its owned Rust server PID, requires those endpoints to disappear and rebind after guest Close before server shutdown, and separately requires native Host exit0 and physical Host-port rebind. Virtual local55173 is not an actual gateway-port cleanup proof.

Repeat with `--transport polling` and a separate output directory. `--server-url` can use an already configured loopback listener instead of launching a server. `--bundle <URL>` supports production serving; fetched bytes must equal the prepared WGB hash. Existing tabs and shared services are preserved.

The controller configures one explicit numeric IPv4 Host listener using the immutable PE's actual Host port, advertised 127.0.0.1, source-IP ACL 127.0.0.1, and maxOwners 1. It checks GetLocalHostAddresses before starting the native Peer. Every phase uses nonce-stamped file barriers on both participants. Both directions compare the same 500 Host and 488 Peer DWORD observations, and normalized INFO callback query/context traces. The Host runner compares guest Host/native Peer; the reverse runner compares native Host/guest Peer. These are complementary direction checks, not four distinct API surfaces when each runs over both transports. It saves PIDs, exits, quota/capture-loss fields, original raw callback rows, source/reference/PE/WGB hashes, first failure before cleanup, and physical-port rebind before server shutdown. No reference regeneration or fixture sleep is used to hide a mismatch.

## Observed contract

The detailed field/tag layout is in `directplay8-peer-info.schema.json`. INFO is 12 bytes; ASYNC_COMPLETE is 16; PLAYER_INFO is 24. Masked-out NAME pointers fail INVALIDSTRING; masked-out DATA pointers fail INVALIDPARAM; unknown mask bits fail INVALIDFLAGS; SYNC with an async handle pointer fails without modifying it. A SYNC async context is ignored. A NULL name has no storage, while a non-NULL empty UTF16 name consumes two bytes and has a non-NULL returned pointer. Non-NULL DATA with size zero is stored as empty/NULL, and still produces INFO even after DATA was previously cleared.

The NT5 behavioral reference is `G:/sources/nt5src/Source/XPSP1/NT/multimedia/directx/dplay/dnet/core/`: `peer.cpp` DN_SetPeerInfo, `paramval.cpp` ValidPlayerInfo, `request.cpp` DNHostUpdateInfo/DNProcessUpdateInfo, `message.h` D6/DB layouts, and `user.cpp` INFO construction. Actual native D6 and DB messages were captured through an ordinary loopback UDP proxy in `wire-runs/1792759342852`; those messages seed bounded binary decoder/encoder tests. Source inspection complements native observations.

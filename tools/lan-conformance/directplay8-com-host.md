# API-only DirectPlay8 Host/Peer oracle

This new finite x86 PE uses only public COM/Win32 APIs. It has no DLL/IAT hooks and is suitable for later execution as the guest Host. The same PE supplies native Host and Peer roles, accept/reject modes, bounded admission/ownership/context/payload/Close observations and durable raw callback records.

Build and capture a new immutable baseline:

```powershell
bun tools/lan-conformance/capture-directplay8-com-host.ts --proof logs/lan-conformance/com-host-UNIQUE --compiler C:/msys64/mingw32/bin/gcc.exe
```

The output directory must not exist. The runner reserves two adjacent ordinary UDP4 loopback ports, compiles a fresh nonce into one strict x86 PE, and starts independent Host/Peer processes for accept then reject. It stops at the first failure, archives progress and partial outputs, closes only its own PIDs, records forced termination as failure and proves both ports can be rebound. Each native process has a35-second watchdog; every phase has a45-second outer limit. No browser/service state is used.

The device GUID is the measured Windows loopback adapter4ce725f6-7b7f-4297-ba6f-11f965bc4299, traversal disabled. A different native adapter mapping is a diagnostic failure; it must be measured rather than silently replaced by wildcard binding.

The runner emits accept/build.json and reject/build.json with the exact native Host reference, same executable hash and prepared WinXP WGB (role command line supplied by --args). Native Peer references remain alongside them. Existing older PE/reference files are never regenerated. Later browser integration requires a real provider listener ACK and an external controller that advances the same nonce markers; an engine unit test is not COM parity.

BSLN observations are ordered DWORD tag/value pairs, preceded by magic0x42534c4e,totalWords,nonce. Every observation also updates host-progress.bin. Tags1/2 record role/mode,3-9 initialization/Host,10-15 Host address results,16-19 Peer address/Connect,200/201 player context,220-224 send/retained receive/ReturnBuffer,240 GetApplicationDesc,250 Close,340 late callbacks,341 dropped rows,399 orchestration failure.

Snapshots at100 and300 contain offsets0 INDICATE count,1 RETURN_BUFFER count,2 aborted count,3 connect completion count,4 connect HRESULT,5 reply size,6 async context matches,7 reply matches,8 initially null indication outputs,9 connect input matches,10 reply pointer matches,11 reply context matches,12 reply original bytes,13 reentrant player count,14 received count;20/21 CREATE counts by normalized role,22/23 DESTROY counts,24/25 original CREATE contexts,26/27 DESTROY contexts,28/29 destroy reasons.

callback-header.bin has7 DWORDs: magic0x42534843,version1,nonce,role,rejectMode,rowCount,dropped. callback-rows.bin has at most64 rows of12 DWORDs: ordinal,tick,thread,message,phase,size,rawDPNID,rawContext,result,count,extra,role. Raw pointer values/DPNIDs/timing are diagnostic, not normalized comparison fields. Host address URLs are archived separately as UTF16.

The callback legally reuses its application-owned reply array after RETURN_BUFFER; the Peer independently checks the original eight bytes. CREATE captures input context before assigning a role context. Incoming data is retained with DPNSUCCESS_PENDING, checked and released through ReturnBuffer twice to measure the exact second-call HRESULT.

Ground truth: G:\sources\wine\include\dplay8.h (ABI) and NT5 dnet core/user.cpp125-230 (INDICATE/ABORTED), core/coreconnect.cpp (reservation, reply/C2/C5/C3), common.cpp (Host/listen before local CREATE). The previous raw-wire oracle separately measures socket and packet behavior. This API-only trace alone does not prove physical Host ingress or discovery/migration/security parity.

The maintained browser controller uses the existing immutable baseline:

```powershell
bun tools/lan-conformance/interop-directplay8-com-host.ts --proof <native-baseline-dir> --output <NEW-output-dir> --server-exe <conformance-server.exe> --listener-id measured-host --transport polling --mode accept
```

Run only after the coordinator grants a stable browser slot. The controller uses the project harness, reloads the assigned `BS_TAB`, installs explicit `directPlay8` native policy, waits for the real listener READY and reads the guest's advertised endpoint before starting the original native Peer PE. It advances the same nonce markers through `fsRead/fsWrite`, compares both Host and Peer tag/value transcripts and checks physical port release before server shutdown. It neither rebuilds the PE/reference nor substitutes a Bun Host for the guest.

Use `--mode reject` for the rejection phase, or `--mode both` for an explicitly granted combined slot. `--server-url` can select an already configured local server instead of launching the finite Rust conformance server; in that case the caller owns the requested transport/listener configuration. With `--server-exe`, the generated config enables only the selected transport and a numeric loopback listener on the original compiled Host port, exact loopback source-IP ACL and one owner. Shutdown uses the launcher's stdin protocol.

For production, optional `--accept-bundle` / `--reject-bundle` overrides accept served URLs only when their downloaded bytes equal the original WGB. The controller respects `BS_DEV_URL`, `BS_TAB`, `BS_CDP_PORT` and `BS_SIDECAR_PORT`; it disconnects only its own harness connection and keeps the shared browser/services running. Failures preserve partial guest progress, callback rows, native PID/exit status, reports and source/reference fingerprints. Counts distinguish raw comparison DWORDs from tagged checks. Packet capture remains the separate raw-wire oracle's responsibility.

## Explicit native Host policy

The emulator's network configuration can opt into native TCP/IP hosting:

```json
{
  "serverUrl": "http://127.0.0.1:9001",
  "room": "friends",
  "directPlay8": { "provider": "native", "hostListener": "game-host" }
}
```

Configure the matching Rust server listener separately:

```json
{
  "gateway": {
    "udpListeners": [{
      "id": "game-host",
      "bindHost": "127.0.0.1",
      "advertisedHost": "127.0.0.1",
      "port": 6073,
      "allowedHosts": ["127.0.0.1"],
      "maxOwners": 1,
      "maxPeers": 2,
      "idleTimeoutMs": 60000
    }]
  }
}
```

The numeric advertised endpoint is distinct from the guest's virtual binding. The provider waits for acknowledgement of the actual OS listener before Host can create its local player; GetLocalHostAddresses and lobby settings publish that acknowledged address. The listener admits only configured source IPs and learns a remote port from actual incoming UDP. Missing capability, failed bind, cancellation and loss of the listener produce failures; an explicit native request never silently creates a virtual session.

This selection applies to the TCP/IP Host path. Omitting directPlay8 preserves the existing virtual Host behavior. Connect and discovery retain their existing provider routing. The native Host backend currently covers an ordinary flags-zero Peer session with dwMaxPlayers=2, admission acceptance/rejection, reply/context ownership, direct reliable data, retained incoming buffers and Close. Outgoing remote COMPLETEONPROCESS, larger hosted sessions, migration, security and general discovery remain separate parity work. Native engine and Bun Session interop checks do not establish guest COM composition; the browser controller above verifies that boundary with the same immutable PE and references.

# DirectPlay 4 discovery API oracle

This revision has not yet been compiled or executed. This x86 PE calls the public
IDirectPlay4 and IDirectPlayLobby3A APIs and writes raw binary observations.
It does not capture wire packets or prove browser, LAN-server, or NT5 parity.
Existing directplay.c remains unchanged.

Build on the reference Windows machine with the same 32-bit MinGW profile used
by build-native.ts, preserving the compiler version and full source/PE hashes:

```powershell
C:/msys64/mingw32/bin/gcc.exe -O1 -nostdlib -fno-builtin -fno-stack-protector -Wl,--entry,_entry -Wl,--subsystem,console -o directplay4-discovery.exe tools/lan-conformance/directplay4-discovery.c -lws2_32 -lkernel32 -lole32 -ldxguid -luuid
```

The source-only coordinator `capture-directplay4-discovery.ts` builds into a
new proof directory, checks the source hash before and after, and records the
compiler and executable hashes. Its invocation is:

```powershell
bun --no-env-file tools/lan-conformance/capture-directplay4-discovery.ts --proof <NEW_DIR> --compiler C:/msys64/mingw32/bin/gcc.exe --nonce <NONZERO_DWORD> --case match
```

Use a different nonce and new directory with `--case mismatch` for the negative
case. The coordinator records compiler, Host and enumerator PIDs, exit statuses,
both stdout/stderr EOF and raw hashes, validates READY identity, and retains the
binary records plus a structured manifest. Each owned native process has its
own watchdog. If an owned handle remains live after its deadline, the coordinator
records that condition and continues waiting on that exact handle; it does not
kill or relaunch it. A supervisor must observe the original coordinator handle.

The coordinator must create an empty unique output directory before launch and
own both child process handles, stdout/stderr and the outer deadline. Helper arguments:

```text
directplay4-discovery.exe host NONCE_DECIMAL OUTPUT_DIR DURATION_MS match
directplay4-discovery.exe enum NONCE_DECIMAL OUTPUT_DIR DURATION_MS match|mismatch
```

Only decimal nonzero DWORD nonce and durations 1000–10000 ms are accepted.
Quote arguments containing spaces; do not put literal quotes in arguments. Use
the same nonce for one pair; choose a fresh directory and nonce for a negative
case. Host uses an application GUID derived from nonce; mismatch changes its
Data1 by XOR 1. Both explicitly create the legacy TCP/IP compound address with
DPAID_INet = 127.0.0.1. The helper itself creates no external service and does
not kill any process. Native DirectPlay may use a system-managed discovery
service or historical fixed ports; the coordinator must inspect readiness and
ownership without stopping or replacing another service.

Host writes host-ready.bin only after Open and attempted CreatePlayer; its five
DWORDs are magic 0x34525044, nonce, PID, Open HRESULT and CreatePlayer HRESULT.
Check both HRESULTs before treating the host as ready. Normal cleanup writes
host-result.bin even when READY creation fails; that failure also makes the
process exit nonzero. Argument errors, watchdog exits and output-write failures
may leave no result; earlier initialization failures may leave no READY file.
Host stays open for DURATION_MS and then closes.
Launch the enumerator promptly after matching READY. Enumeration is synchronous with a
finite DURATION_MS timeout. A matching app must be verified from actual rows,
including GUID, name and player counts; zero matching rows is a recorded
observation, not a passing comparison. The callback records DPESC_TIMEDOUT and
returns FALSE for it, ending the finite synchronous pass; it returns TRUE for
ordinary rows. The NT5 DP_EnumSessions loop (enum.c 1627–1650; snapshot
plan/DP4-enum-timeout-groundtruth-root.json) uses that return value to decide
whether to start another pass. An oracle watchdog timeout is a failure. A
mismatch run needs its own fresh pair.

host-result.bin and enum-result.bin contain the exact little-endian x86 in-memory
Result structure declared in the source: magic 0x344f5044, version, nonce, role,
PID, duration, mismatch, staged HRESULTs, count/dropped, then 64 fixed EnumRow
records. Each callback copies IDs, session metadata, timeout/flags and bounded
UTF-16 name before returning. Timing and PID are diagnostic; do not compare
them as stable observations. A truncation flag or rows_dropped means incomplete
evidence. HRESULT E_NOTIMPL identifies a stage that was never reached.

All files use CREATE_NEW. Reusing a path causes a failure rather than overwriting
an earlier observation. The Host watchdog allows 20 seconds for setup, then
rearms after READY is written for DURATION_MS plus 10 seconds. The enumerator
watchdog allows DURATION_MS plus 20 seconds from process startup. A watchdog
writes role-timeout.bin and exits its own process with status 124: a timeout is
failure, not a completed oracle. With the coordinator's 10-second Host and
3-second enumerator durations, their respective finite bounds are 40 and 23
seconds; coordinator notices are at 42 and 25 seconds, with a 22-second READY
deadline. The coordinator retains partial output and actual exit codes, and
continues to wait for both owned handles and their stream EOFs after a notice;
it never uses PID/name-based cleanup or touches unrelated services.

Immutable host-stage-NN.bin and enum-stage-NN.bin markers contain six
little-endian DWORDs: magic 0x34535044, nonce, PID, stage number, GetTickCount,
and HRESULT. The markers before calls use E_NOTIMPL; those after calls record
the result (or S_OK for void CoUninitialize). Pairs identify CoInitialize 1/2,
CoCreate Lobby 3/4, CreateAddress 5/6, CoCreate DirectPlay 7/8,
InitializeConnection 9/10, Host Open 11/12 and CreatePlayer 13/14,
enumerator EnumSessions 15/16, Close 17/18, CoUninitialize 19/20, and Host
DestroyPlayer 21/22. The numbering identifies calls, not their chronological
order. Marker write failure makes the helper exit nonzero. The coordinator
validates marker identity and records their hashes and contents in the manifest,
including partial sequences on failure; a successful observation requires the
complete applicable sequence.

IPv4 DirectPlay 4 discovery can involve both UDP and TCP, a return sockaddr and
a fixed legacy discovery service port. This API-only helper establishes none of
those wire facts. A later separately owned and bounded socket capture/proxy must
record actual tuples and bytes, avoid port collisions, and replay unmodified
flows. The NT5 source snapshots explain candidate framing but are not substitute
native observations. Do not use this probe as evidence of an emulator match
until the same reference executable and a frozen shipping build are compared.

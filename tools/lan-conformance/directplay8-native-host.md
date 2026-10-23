# Native DirectPlay8 Host + one Peer oracle

This finite Windows x86 diagnostic measures native Host admission, rejection, reply ownership, player contexts, direct guaranteed payloads, retained RECEIVE buffers and Close. Its loopback socket/IAT trace records actual UDP endpoints independently of configured addresses. The C source is byte-for-byte the original diagnostic, including its historical draft header; execution evidence comes from each run's verified.json, not that header.

Create a fresh native reference (two roles of one newly compiled PE):

```powershell
bun tools/lan-conformance/capture-directplay8-native-host.ts --proof logs/lan-conformance/host-baseline-UNIQUE --compiler C:/msys64/mingw32/bin/gcc.exe
```

Then replace only the native Host with the isolated TypeScript Host engine, keeping the exact Peer PE and reference bytes:

```powershell
bun tools/lan-conformance/interop-directplay8-native-host.ts --proof logs/lan-conformance/host-baseline-UNIQUE --output logs/lan-conformance/host-interop-UNIQUE
```

Both output paths must be new. Capture chooses and checks two adjacent free IPv4 loopback ports, builds with an independent nonce and strict warnings, validates x86 PE, and runs accept then reject. Interop reads nonce, ports, application snapshot and expected results from that verified native baseline. It never rebuilds the PE or reference. All traffic remains on ordinary 127.0.0.1 UDP sockets. It does not use browser state, RAW sockets, native registry registration, an external server or wildcard gateway ingress.

Each phase has a 45-second deadline; each native process has its own 35-second watchdog. Progress and partial binary diagnostics remain durable on failure. Cleanup signals cooperative markers, then terminates only still-live PIDs owned by that invocation, records any forced termination as failed, drains process pipes and proves port release by rebinding both ports. The queue stops at the first unexpected failure.

The native fixture selects the measured Windows IPv4 loopback adapter GUID 4ce725f6-7b7f-4297-ba6f-11f965bc4299 with traversal disabled. A machine with a different adapter mapping must preserve the failure and measure its actual configuration. The runner does not silently substitute a wildcard address.

Files archived per run include source/compiler arguments and output, original PE, BSLN observations, callback records, address records, full small datagrams, process IDs/exits, markers and cleanup. The source manifest and immutable PE/reference hashes are checked before and after interop. The binary format and observation tags are in directplay8-native-host-schema.json.

The own-process WSASendTo IAT hook records getsockname and original WSABUF bytes, passes original arguments unchanged and preserves the native result and Winsock error. It restores the IAT after Close; no DLL files are changed. Callback addresses, DPNIDs, pointers and timing remain in raw diagnostics. Main BSLN fields normalize role identity instead of comparing random native pointer values. RETURN_BUFFER legally releases the application's reply array, which is then reused; the remote Peer independently checks the original reply bytes.

The isolated Host currently supports exactly Host + one admitted Peer, flags zero, C1/C2/C3/C5/C6/C9/CA and direct data. It is not installed in guest COM Host. This oracle does not establish native Host discovery, multiple peers, host migration, security, IPv6, group mutation or remote COMPLETEONPROCESS semantics.

Ground truth navigation (reference behavior; no implementation source copied):
- G:\\sources\\nt5src\\Source\\XPSP1\\NT\\multimedia\\directx\\dplay\\dnet\\core\\common.cpp:2720 Host, 3050-3095 listener success before local CREATE.
- core/coreconnect.cpp:148/314 admission, 410-466 C2 copy/send and RETURN_BUFFER, 588 C3/C6, 702 validation, 882 reservation, 904 INDICATE, 950-1011 C5 failure.
- core/user.cpp:125-196 INDICATE_CONNECT fields and callback outputs.
- core/appdesc.h:249-256 DPNID XOR mask from the first instance GUID DWORD.
- core/nametable.h:82-95 20-bit slot / 12-bit version handles; core/nametable.cpp:705-720 native FindEntry validation.
- sp/wsock/endpoint.cpp:4687 unknown source to listener child; protocol/receive.cpp:139 and protocol/connect.cpp:647/840 native transport handshake.
- G:\\sources\\wine\\include\\dplay8.h defines the ABI. Wine's Host stub is not wire evidence.

The initial same-PE reference and actual Bun interop were recorded separately under logs/lan-conformance/stage28-native-host. Native results and source references have distinct roles: a source description alone does not prove modern Windows behavior.

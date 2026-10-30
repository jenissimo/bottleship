# lanprobe + lan-diff

One generic x86 probe interprets `.lp` scripts on native Windows and in the
emulator. The runner compares their observation logs line by line.

```bash
bun tools/lan-conformance/probe/lan-diff.ts record <area>/<case> [--force]
bun tools/lan-conformance/probe/lan-diff.ts check <area>/<case>|all
bun tools/lan-conformance/probe/lan-diff.ts run <area>/<case> --as=host=native,peer=native
bun tools/lan-conformance/probe/lan-diff.ts list
```

- Scripts and committed native goldens live in `../cases/`.
- `record` uses native roles and updates goldens only when every role finishes
  successfully. Existing goldens require `--force`.
- `check` compares with committed goldens. Its summary counts matched, failed
  and skipped cases separately; differences produce exit code 1.
- `run` executes a multi-role diagnostic without reading or writing goldens.
  Completion is not a parity claim: inspect API results in the logs.
- `# emu-skip <reason>` works in both single-script and role cases. It applies
  only to roles actually running in the emulator.
- Native compilation needs 32-bit MinGW (`BS_MINGW_CC`). The probe PE is cached
  by source hash. Use the project's pinned Bun.
- Browser runs use the project harness. Set `BS_TAB` to an unused session name
  and `BS_DEV_URL` when testing a separate dev server. Reload worker sources
  through the harness after code changes.

Each invocation creates a new directory below ignored
`logs/lan-conformance/lan-diff/<case>/`. A multi-role run keeps the coordinator
and each role's working directory together under `run-*/`; previous role
addresses, signals and logs are never reused. Guest bundle IDs include the run
identity and role because OPFS is shared by tabs on the same origin.

## Coordination

Multi-role scripts use `<case>.host.lp`, `<case>.peer.lp`, etc.

- `gate ready` is a barrier. The coordinator releases it after every participating
  role has arrived.
- `signal got-ping` has an explicit producer. A waiting role cannot release that
  signal merely by reaching its gate.
- `publishaddr socket name`, `publishlocal name port` and
  `publiship name ip port` all publish `addr-<name>.txt`.
- `target = waitaddr name t=30000` reads a published endpoint. Its name also
  participates in guest boot cleanup, including externally supplied addresses.
- Role drivers relay addresses and signals in both native and guest filesystems.
  Coordinator writes are atomic; failed guest writes and gate timeouts fail the run.
- Positive scenarios use `require_success` to reject prior API failures or missing
  callbacks before reporting receipt. `sendpeer peer all "ping"` addresses all
  players without depending on CREATE_PLAYER callback order.
- `addhostfromaddr` sets both hostname and port from the published endpoint.

Native probes are owned by their role driver. The driver waits for their actual
exit status and retires them on failure; the parent also retires its role
processes and wire host on coordinator failure.

## Mixed native/emulated roles

```bash
bun tools/lan-conformance/probe/lan-diff.ts gateway-config logs/lan-conformance/gateway-server.json [ports...]
bun packages/lan/src/cli.ts --config logs/lan-conformance/gateway-server.json --port 9001
BS_LAN_SERVER=http://127.0.0.1:9001 bun tools/lan-conformance/probe/lan-diff.ts check udp/interop --as=host=native,peer=emu
```

The native role publishes its reachable LAN address and the relay must allow
that address and port. An emulated peer routes `127.x` to itself, so loopback
must not be published as a native host's address in mixed mode.
Guest-initiated gateway flows can carry replies; unprompted native-originated
traffic requires the explicit host-listener/bridge fixtures.

## DP8 wire-host diagnostics

```bash
bun tools/lan-conformance/probe/lan-diff.ts run dp8/interop --wire-host --as=peer=native
```

This replaces the host role with `dp8-wire-host.ts`, an adapter from real UDP
to the project's `NativeDirectPlayHost`. It is an implementation under test,
not a native-Windows oracle. `record --wire-host` is rejected; keep golden
recording independent. `check --wire-host` compares the peer's observations
with an existing native baseline.

The driver accepts `--addr-file` and/or `--ready`, writes the actual endpoint
after binding, and accepts port 0 for an ephemeral socket. `BS_WIRE_HOST_IP`
selects the advertised address; `BS_WIRE_HOST_PORT` selects its UDP port.
Native-only diagnostics default to an ephemeral port; emulated clients use
23913 by default and require a configured gateway.
Raw DNET packets are adapted using their real source IP and port. The 16-byte
`88 01 ...` packet is a DNET CONNECT, handled by the reliable link; enumeration
uses `discovery-codec`. A host-side receive file releases the omitted host
role's receive-confirmation signals only after actual user data arrives.

Passing local wire-host tests proves the adapter path. Native interop requires
a separate successful native-role run.

The script language is documented in `lanprobe.c`. Add reusable probe verbs
when a contract needs them, then keep cases as short scripts.

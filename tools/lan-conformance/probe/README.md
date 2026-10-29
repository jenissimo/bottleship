# lanprobe + lan-diff

One generic x86 probe (`lanprobe.c`) and one runner (`lan-diff.ts`) for
differential Winsock conformance: the same probe PE runs on native Windows and
in the emulator, and the observation logs must match line by line.

```bash
bun tools/lan-conformance/probe/lan-diff.ts record <area>/<case> [--force]  # native → golden
bun tools/lan-conformance/probe/lan-diff.ts check <area>/<case>|all         # emulator → diff
bun tools/lan-conformance/probe/lan-diff.ts list
```

- Cases live in `../cases/<area>/<case>.lp` next to the committed golden
  `<case>.native.log`. Goldens are recorded only from native Windows; the
  emulator side runs anywhere.
- `check` needs the harness browser (`bun tools/harness.ts up`); use
  `BS_TAB=<name>` when other agents share the Chrome. `BS_LAN_SERVER` /
  `BS_LAN_ROOM` are passed through for cases that need the relay.
- The probe PE is compiled once with 32-bit MinGW (`BS_MINGW_CC`) and cached
  under `logs/lan-conformance/lanprobe/`, keyed by the C source hash.
- Artifacts per run (bundle, guest log) land in ignored
  `logs/lan-conformance/lan-diff/<case>/`.

## Multi-role cases

A case is multi-role when role scripts sit next to each other
(`<case>.host.lp`, `<case>.peer.lp`); each gets its own golden
(`<case>.<role>.native.log`). `record`/`check` spawn one role driver per role:

- Natively, a probe process per role in the run directory.
- In the emulator, one role child per role, each with its own harness tab
  (`<BS_TAB>-<role>`), its own bundle and its own guest FS.

Roles synchronize through `gate <name>` barriers: the probe logs
`gate <name> enter`, then blocks until `gate-<name>.open` appears next to its
log (a real file natively, the guest FS via harness `fsWrite` in the
emulator). The parent coordinator releases a gate once every role arrived.
Role scripts must use FIXED ports — addresses stay symbolic without
cross-role discovery. Role scripts can declare `# emu-skip <reason>` when the
emulator run is not expressible yet; `check` then reports SKIP instead of
FAIL.

Emulator fact the pair case established: guest loopback (127.0.0.1) is
per-process-local, so two tabs cannot exchange datagrams over 127.0.0.1 —
cross-tab roles need the virtual LAN's per-session `10.x.y.z` address, which
is assigned per boot. The planned design is role-address publishing: each
role writes its bound address into a coordinator file the other roles read
(`publishaddr`/`waitaddr` probe verbs), keeping addresses symbolic in the log
while the transport uses whatever address each environment really has.

Determinism contract: the probe names every nondeterminism itself — socket
handles are their assignment names, ephemeral ports print as `<socket>.port`,
error codes as `WSAE*` names. Bind every socket whose address may appear in a
log. LastError is preset to 0 before each call and read after every call, so a
success that leaves a real error behind (truncated recv → `WSAEMSGSIZE`) is
part of the golden.

The script language is documented in the `lanprobe.c` header. Extending
coverage is: write a 10–30 line script, record native, make the emulator
match. When a case needs an API the probe does not speak yet, add the verb to
`lanprobe.c` (same for DirectPlay COM later), never a one-off fixture.

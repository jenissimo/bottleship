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

Cross-tab data exchange cannot use guest loopback — 127.0.0.1 is
per-process-local — and the virtual LAN's per-session `10.x.y.z` is assigned
per boot, so roles publish their addresses: `publishaddr <s> <name>` writes
the socket's address (bound to 0.0.0.0, the best local IP) into the
coordinator, `peeraddr = waitaddr peer [t=<ms>]` waits for a peer's address
and binds it to a symbolic sendto/connect target. The address travels through
coordinator files and never enters the log — `connect h peeraddr` logs the
token, so native and emulator logs stay identical.

Role drivers mirror every coordination file (`gate-*`, `addr-*`) between the
coordinator directory and their probe's gate directory. Each role bundle gets
its own game id (`app:lan-conformance-<role>`): OPFS is per-origin, so same-id
bundles would share one overlay across tabs and every boot's `deleteOnBoot`
would fight the other tab's live probe holding the file open. Every
coordination file the case can produce is wiped at boot (`deleteOnBoot`) — a
reused tab must not hand the driver a previous run's address.

A role script can declare `# emu-skip <reason>` (one line) when the emulator
run is not expressible yet; `check` then reports SKIP instead of FAIL.

The script language is documented in the `lanprobe.c` header. Extending
coverage is: write a 10–30 line script, record native, make the emulator
match. When a case needs an API the probe does not speak yet, add the verb to
`lanprobe.c` (same for DirectPlay COM later), never a one-off fixture.

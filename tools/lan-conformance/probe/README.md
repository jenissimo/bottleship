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

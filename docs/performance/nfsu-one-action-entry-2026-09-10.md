# NFSU one-action benchmark entry

Target accepted by the user: the fixed profile's blue Skyline, Free Run on
Olympic Square, Traffic None, max-detail `nfsu-max` settings. The original manual
recording used a yellow Golf. The user explicitly accepted Skyline to avoid
spending optimization time reproducing that car selection.

Entry page: `tools/bench-v86/source-pair/nfsu-entry.html`. Start the evidence
collector with `bun tools/bench-v86/source-pair/navigation-record-server.ts`, keep
the dev server on `127.0.0.1:5174`, then click **Войти в эталонную гонку**.
The action owns one fresh iframe and finishes paused. It backs up the previous
five profile/settings files before restoring the embedded `nfsu-max` fixture and
checking all five readbacks. The original saved AOT remains untouched.

## Mechanism

The bundle's `skipVideo` override was confirmed true at runtime, but NFSU's native
movies still ran. The first working route recognized video frames and skipped
them with bounded input; this remains the fallback when the early BootFlow window
has already passed.

Static disassembly of the local retail Speed.exe identifies BootFlow constructor
`0x004DE1E0`. It builds an intrusive list from one of two fixed pointer arrays.
Their final entries are the profile screen. Before construction, the lab changes
the two `mov edi, listStart` operands to those final entries:

| Instruction | Original start | Profile-only start | Unchanged loop end |
|---|---|---|---|
| 0x004DE225 | 0x006FA1BC | 0x006FA1D4 | 0x006FA1D8 |
| 0x004DE273 | 0x006FA1A4 | 0x006FA1B8 | 0x006FA1BC |

Each variant therefore constructs exactly one ordinary list node. Expected
instruction bytes, paused execution, code invalidation availability and an unset
current BootFlow screen are checked first. Both writes use `writeGuestCode`.
Once the profile screen appears, the original instructions are restored through
the same invalidation path. This temporary startup-only change is absent during
the race. No WGB or on-disk EXE is modified.

After automatic profile selection, the lab requires the idle main menu and checks
four relevant code spans against the inspected binary. It sets mode 3 at
`0x00777CC8`, track 1003 at `0x007589E8`, traffic 0 at `0x007589F8`, and queues the
ordinary initializer `0x004B5C00` in the game's pending-transition slot
`0x0077A904` (argument zero). The dispatcher at `0x004476C5` consumes this slot;
the initializer selects Free Run `0x004B5090` and schedules the normal load flow.
The CPU instruction pointer is never assigned by the lab.

The local reverse notes `C:/Share/nfsu/reverse/assist_gate_modes.md` identify the
Free Run enum and initializer. The four checked code spans originate from local
Speed.exe SHA256 `c0fad450912952f53809a54690d235aa8b4e25b9f46650693c7cbee1b4c074b7`;
this is a source-image identity, not a full live-image hash claim.

Completion requires observed countdown state 3 followed by active state 4,
advancing physics and present serials, mode 3, track 1003, traffic 0, one player,
and two image-region checks against the Skyline reference. Screenshots, selected
memory regions, settings backups, transitions and completion are persisted in
`logs/nfsu-navigation-RibI1M/` for this session. Numeric JSON stems are journal
sequence IDs; the exact run start is an `entry-start` record.

## Evidence and limits

The full menu path reached the original Golf scene. The first direct trial reached
a Skyline instead; a broad scene image check admitted it. This was explicitly
reported, then the user accepted Skyline as the new target. The default now checks
the Skyline-specific car region as well as the wider scene. The historical first
direct completion must not be described as a verified Golf result.

Run starting at sequence `1789042363239` completed with the explicit Skyline checks
using the slower intro path. The first profile-only run starts at `1789042709748`:
it reached profile in
8.94 seconds, main menu in 13.07 seconds and the checked, paused race in 33.01 seconds.
These are descriptive startup timings, not AOT speedup or CPU measurements.
The second profile-only run (`1789042863505`) reached profile in 8.92 seconds,
main menu in 12.98 seconds and the verified paused scene in 34.59 seconds.

The startup fixture removes manual setup variation. It does not produce a bit-exact
simulation snapshot or prove frame-time stability. Exclude startup instrumentation
and screenshots from performance windows, warm both AOT arms, retain publication
ownership checks, and compare frame times in the same verified scene. NFSPU is not
implemented by this adapter.

Empty overlay video files were suggested as another skip mechanism but were not
needed or tested. The game-specific source corroborates the distinction between a
skip flag and advancing a movie screen: [Extra Options](https://github.com/ExOptsTeam/NFSUExOpts/blob/master/NFSUExtraOptions/ExtraOptionsStuff.h)
sets `_SkipMovies` and also installs a movie-completion fix. No mod code was installed;
the working shortcut above was derived from the local BootFlow constructor.

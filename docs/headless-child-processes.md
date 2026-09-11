# Headless child processes

`CreateProcessA/W` starts a stored, non-suspended image in a separate emulator worker and
returns immediately, the way Windows does. The optional console host-tool backend remains
available. The existing suspended-image patch/resume path is retained, including its legacy
re-exec behavior.

## Helper or session

Each process keeps its own worker; the host attaches its one display/input session to the
selected live worker. Nothing about the image decides which one applies. The PE
subsystem was tried and is wrong in both directions — WWP's `Landgen.exe` is a GUI-subsystem
image that imports nothing but kernel32, and a console image can equally be the program the
user is meant to end up in front of.

What decides it is what the guest DID, observed at run time. Two facts hand the session to
the child (`kernel32 handOffToChild`):

- **The child claimed a titled top-level window** (`window_title`). There is one screen;
  the notification that names the tab for the session's image is the child saying it wants
  it. `Landgen` cannot reach it — it has no user32 import at all. This fires while the parent
  is still blocked in its wait, which is the only recovery available there: Warcraft III's
  launcher waits on `war3demo.exe`, and that child never exits.
- **The parent exited leaving the child running** (`pendingChildHandoff`). It never collected
  an exit code, so nothing it did depended on one — Red Faction's launcher `CreateProcess`es
  `RF.exe` and returns from `WinMain`.

A file-producing helper such as Landgen says neither: it computes, exits, and the exit code
is what the waiting parent came for. A *delivered, durable* exit code retires the candidacy.
A failed run remains visible as a failure, but a stopped worker cannot be promoted and is
never relaunched to hide that failure. Explicit termination and session cancellation also
retire candidacy.
Registration precedes image I/O, so even an immediate parent exit can see the child.

The child initially renders to a private OffscreenCanvas. Promotion transfers a MessagePort
to the page and attaches a new visible canvas to the child's existing WebGPU device. CPU,
memory, GPU resources, GDI DCs and open files survive. No EXE load or entry-point replay occurs.
The original canvas remains the input/layout anchor; the host overlay follows its geometry.
Nested workers receive real animation-frame timestamps through their parent, because native
worker requestAnimationFrame is unavailable for this nesting in Chrome.

`SessionWorker` keeps UI/harness consumers on a stable endpoint, routes input to the selected
worker, and returns outstanding RPC/modal replies to their original process. Initial UI/audio
messages are queued until attachment; VFS traffic always goes to the parent. A new bundle
closes old ports and cancels/drains the whole old process tree before replacing its VFS.

The parent can finish its guest execution while its worker remains alive as a VFS broker.
Guest exit is delivered separately from worker disposal, so chains of exiting launchers also
work. A `MessageBox` before selection still fails explicitly; after attachment the normal
host modal service handles it. A launcher waiting on a child that neither exits nor titles a
window still supplies no display-selection signal and remains outside these two rules.

## Isolation and filesystem contract

Each child has its own v86 memory, loader, module registry, PEB/TEB, scheduler and heaps.
Two images can therefore both occupy their preferred base without relocations or a parent
memory swap. Terminating the worker releases its runtime allocations and file-object bridge.
The normal loader still publishes executable bytes through the existing JIT invalidation path.

The child uses a synchronous SAB mailbox to call an allowlist of operations on the parent's
VFS. Only the child worker blocks. The parent owns every backing file object and its cursor;
remote handles identify those objects rather than copying their cursor state. `readInto`
copies the returned bytes into the child's own memory. Large reads/writes use 64 KiB chunks.
The child maintains its own working directory and receives the parent's environment and the
caller's command line. Its main-module identity comes from its own image path.

`ExitProcess` and faults terminate guest execution. Completion waits for the shared VFS's
`flushAll()` without a timed success fallback. The parent then receives a completed virtual
process/thread pair, with the real exit code and signalled handles. Failure to flush is an
execution error, not successful completion. A process record owns the runtime independently
of its original handles. Completion signals all surviving process/thread aliases, even after
the original handles were closed. `TerminateProcess` (or termination of the sole primary
thread) stops the runtime immediately, rejects subsequent mailbox requests, drains accepted
I/O and flushes before publishing the requested exit code. Session teardown cancels workers;
VFS reset and the re-exec flush wait for cancellation to drain. The existing host exit/re-exec
flush budget remains a fallback and can still cut off a stuck drain.

The facility presents one selected process, rather than composing a multiprocess desktop.
Emulator configuration, registry contents and named-object specifications are copied at
creation. Registry and named-object state are not live-shared across workers; child registry
changes do not have an independent persistence path. Inherited Win32 handles and caller-supplied
environment blocks are not implemented by this bridge. The child's mailbox is served by the parent
worker's event loop, so a child gets slow service while the parent's own guest is running and
fast service while the parent is blocked waiting on it — the case this exists for.
`ShellExecute` and the legacy suspended launcher path retain their existing behavior. The
optional console host-tool backend uses the same asynchronous lifetime: `CreateProcess`
returns handles before HTTP execution finishes, outputs are imported relative to the child's
cwd, and completion waits for durability. Termination aborts the HTTP request; the sidecar
kills and reaps its native process when that request disconnects. A late response cannot
import files after cancellation. Real shader compilation through this route still needs a
game-level run.

## Diagnostics and regression

`childProcesses()` returns a bounded history of image, arguments, elapsed time, backend, exit
code, fault report and log tail. `fileMutations` counts mutating VFS requests (including failed
attempts); `mutationPaths` retains up to 16 affected paths. These survive promotion.
`session` marks a selected runtime; `guestExitCode` records an exited guest whose worker is
still serving descendants. File effects are preserved once; no replay warning is needed.
`runChildProcess(image, args, cwd?)` exercises the same runner
directly through the harness. `fsHash(path)` verifies what the parent can read afterwards.

`tools/tests/child-process.test.ts` checks durability ordering/failure, worker failure and
cancellation, independent file cursors, a real worker transport including multi-chunk reads
and guarded `readInto` ranges, early launch failures, immediate parent exit, forced termination,
accepted I/O draining, and the helper-or-session rule above (`helper or session`).
`virtual-process-runtime.test.ts` covers handle aliases, runtime termination, reused PIDs after
reset and suppression of the fake auto-exit timer. `guest-host-tool.test.ts` covers asynchronous
host execution, input/output handling, durability and cancellation. `host-tool-process.test.ts`
runs real native subprocesses, including cancellation through an actual HTTP disconnect.
`tools/harness/regression/headless-child.harness.ts`
runs a configured deterministic helper twice and checks complete, identical output. Set
`WGB`, `CHILD_IMAGE`, `CHILD_ARGS`, and `CHILD_OUTPUT` for that scenario.

## Entry-point replay

An ordinary non-suspended `CreateProcess` must not run the child image twice. Display and
input attach to the worker that is already running it, while the parent keeps serving the
same open VFS objects; the suspended-image and ShellExecute paths are separate and keep
their own behavior.

`tools/tests/fixtures/live-child.c` is the executable regression for that rule: it appends
`A` before opening its window, holds `B` in memory, and appends that byte on a real Space
key event after promotion. A correct run produces exactly `AB` — a replayed entry point
produces `AAB`. The cases covered are a waiting parent, an immediately exiting parent, and
a chain of two launchers ahead of the child. The fixture also reads FS:[0x18] before its
first WinAPI call, so a child booting with a zero FS base fails it: child initialization
uses the same clean boot boundary as a root image rather than a provisional BIOS-stage
scheduler thread.

Build the fixtures with `powershell -NoProfile -File tools/build-live-child-probe.ps1` (LLVM
and Windows SDK paths are parameters), point `WGB` at the generated bundle, then run
`bun tools/harness.ts run tools/harness/regression/live-child.harness.ts`. Artifacts land
under `logs/child-promotion/`; none of them are checked in.

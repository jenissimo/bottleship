/**
 * Deponia (Visionaire 5 / LuaJIT / D3D9, GOG) — the SEH unwind pass reaches every frame.
 *
 * The game's startup script does `require "socket"`, which fails on a stock install (no
 * luasocket in the drop) exactly as it does on Windows. LuaJIT reports that with
 * RaiseException(0xe24c4a02) and catches it in lj_err_unwind_win, whose ONLY chance to pop
 * its internal C frames is the EH_UNWINDING pass RtlUnwind runs over the chain. Skip one of
 * its frames and the VM keeps running on frames that no longer exist; the damage surfaces
 * ~25s later as a NULL in gc_traverse_frames, an access violation at 0x6, and a game that
 * looks frozen because it is writing a minidump.
 *
 * Guards: RtlUnwind calls EVERY frame's handler (no shape guessing), FS:[0] ends on the
 * target frame, a synthesized record when the caller passes none.
 *
 * Prereqs: `bun tools/harness.ts up`. Bundle path from the WGB env var.
 * Expected end state: the main menu renders, presents keep climbing, no crash, and the
 * unwind trace shows every frame taking the pass.
 */
import { harness } from "../../harness";

const CONFIRM_LANGUAGE = { x: 503, y: 538 };   // the green check on the language screen
const fail: string[] = [];

const boot: any = await harness()
    .openWgb(process.env.WGB ?? "G:/WGB/todo/deponia.wgb")
    .tickFrames(900, { timeoutMs: 900_000 })
    .call("sehTrace", { clear: true })
    .state(["screen"])
    .run();
const booted = boot.steps.find((s: any) => s.cmd === "state")?.result?.screen;
if (booted?.presenter !== "d3d9") fail.push(`presenter is ${booted?.presenter}, expected d3d9`);

await harness().push("move", [CONFIRM_LANGUAGE.x, CONFIRM_LANGUAGE.y]).tickFrames(20)
    .push("clickAt", [CONFIRM_LANGUAGE.x, CONFIRM_LANGUAGE.y]).run();

// The crash used to land ~25s after the click, so the window has to outlast it.
const after: any = await harness()
    .tickFrames(1800, { timeoutMs: 300_000 })
    .state(["screen"])
    .call("sehTrace")
    .call("report")
    .shot({ save: "deponia-lua-unwind.png" })
    .run();

const screen = after.steps.find((s: any) => s.cmd === "state")?.result?.screen;
const advanced = (screen?.presentSerial ?? 0) - (booted?.presentSerial ?? 0);
if (advanced < 200) fail.push(`only ${advanced} presents after the language confirm — the game stopped drawing`);

// Liveness at the END, not just a total: the crash left the guest burning CPU in LuaJIT's
// GC with the frame loop dead, which a cumulative count still satisfies. This is the check
// that separates "ran, then froze" from "running".
const live: any = await harness().state(["screen"]).sleep(3000).state(["screen"]).run();
const [before, later] = live.steps.filter((s: any) => s.cmd === "state")
    .map((s: any) => s.result?.screen?.presentSerial ?? 0);
if (later - before < 30) fail.push(`only ${later - before} presents in 3s at the end — the frame loop is dead`);

const rep = after.steps.find((s: any) => s.cmd === "report")?.result;
if (rep?.crash) fail.push(`crash: ${JSON.stringify(rep.crash)}`);
// report().faults is a RING of recent faults, handled ones included — each carries the
// `outcome` the dispatcher recorded. A guest that takes an AV and recovers through its own
// SEH is routine for a LuaJIT/Visionaire title, and counting those reads a healthy run as
// broken. Only a fault nobody handled is a failure here.
const unhandled = (rep?.faults ?? []).filter((f: any) => !/dispatched to/i.test(String(f?.outcome ?? "")));
if (unhandled.length) fail.push(`${unhandled.length} unhandled fault(s): ${JSON.stringify(unhandled[0])}`);

const lines: string[] = after.steps.find((s: any) => s.cmd === "sehTrace")?.result?.lines ?? [];
// Positive control: without at least one unwind the frame assertions below are vacuous —
// they would pass just as well on a build where the Lua error never fires.
const unwinds = lines.filter((l) => l.startsWith("unwind head=")).length;
if (unwinds === 0) fail.push("no RtlUnwind recorded — the Lua error path did not run, so this scenario proved nothing");
// "NO STEPS in 0 frame(s)" is the engine's normal answer when the chain head already IS
// the target — nothing to unwind, and it says so while returning normally. Only a walk
// that found frames and still ran nothing is the defect this regresses.
const skipped = lines.filter((l) =>
    /UNUSABLE|STOPPED|TRUNCATED/.test(l) || /NO STEPS in (?!0 )\d+ frame/.test(l));
if (skipped.length) fail.push(`${skipped.length} frame(s) did not take the unwind pass: ${skipped.slice(0, 3).join(" | ")}`);

if (fail.length) {
    console.error("FAILED:\n  " + fail.join("\n  "));
    process.exitCode = 1;
} else {
    console.log(`OK — ${unwinds} unwind(s), every frame took the pass; ${advanced} presents after the ` +
        `language confirm, still drawing at the end, no crash`);
}

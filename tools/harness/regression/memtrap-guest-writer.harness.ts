/**
 * `trapWrites(..., {watch:true})` must never answer a silent zero.
 *
 * Builds real x86 in fresh guest memory and asks the trap what it saw — no game state
 * involved, so this judges the instrument rather than a title. Three shapes, all writing
 * dwords on ONE page (the shape every real watch target has):
 *
 *   sync-second   mov [A],..; mov [B],..; ret   driven by run_guest_until (no tick hooks
 *                 at all), watching B: the store to A opens the window and B lands inside
 *                 it. UNOBSERVABLE by construction — the trap must SAY so.
 *   sync-first    same stub, watching A — the control: this one is attributable.
 *   thread-loop   a real guest thread on the normal tick loop, storing to A and then to B
 *                 from a CALLED function (call/ret are v86 block boundaries). Run twice on
 *                 one arming: the trap may miss the first burst at full speed, but it must
 *                 notice it missed one, throttle itself, and attribute the second burst.
 *
 * Before the re-arm fix, the first store to the page un-protected it for good and every
 * later write was invisible: 0/100 attributed, `pagesHit: 0`, no other signal.
 *
 *   BS_TAB=<tab> bun tools/harness.ts run tools/harness/regression/memtrap-guest-writer.harness.ts
 *   NO_BOOT=1 …  reuse the guest already in the tab
 */

import { harness } from "../../harness";

const CODE = String.raw`
const sys = System.getInstance();
const p = sys.process;
if (!p) return { error: "no process" };
const cpu = p.v86.cpu || p.v86.v86.cpu;
const { callGuestFunctionSync, writeSentinelBytes } = await import("/src/worker/core/hle-lib/sync-guest-call.ts");
const { writeGuestCode } = await import("/src/worker/core/memory/guest-code.ts");
const { preemptionManager } = await import("/src/worker/core/cpu/preemption-manager.ts");
const { memWriteTrap } = await import("/src/worker/core/memory/mem-write-trap.ts");

const mem0 = p.getCurrentMemory();
if (!state.memtrapArena) state.memtrapArena = p.memory.alloc(0x3000, "HEAP", "rw", 0x1000);
const arena = state.memtrapArena >>> 0;
const codePage = arena;
const loopStub = (arena + 0x40) >>> 0;
const dataPage = (arena + 0x1000) >>> 0;
const A = (dataPage + 0x10) >>> 0;
const B = (dataPage + 0x20) >>> 0;
const C = (dataPage + 0x30) >>> 0;
const sentinel = (codePage + 0x200) >>> 0;
const d32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const hex = (n) => "0x" + (n >>> 0).toString(16);
const ITER = 100;

// straight-line: mov [A],imm ; mov [B],imm ; ret   (both stores in ONE block)
writeGuestCode(mem0, new Uint8Array([
    0xC7, 0x05, ...d32(A), 0x11, 0x11, 0x11, 0x11,
    0xC7, 0x05, ...d32(B), 0x22, 0x22, 0x22, 0x22,
    0xC3,
]), codePage);
// loop: mov [A],ecx ; call writeB ; inc [C] ; dec ecx ; jnz loop ; ret / writeB: mov [B],ecx ; ret
writeGuestCode(mem0, new Uint8Array([
    0xB9, ...d32(ITER),          // 0  mov ecx, ITER
    0x89, 0x0D, ...d32(A),       // 5  mov [A], ecx
    0xE8, ...d32(10),            // 11 call +10 -> 26
    0xFF, 0x05, ...d32(C),       // 16 inc [C]
    0x49,                        // 22 dec ecx
    0x75, 0xEC,                  // 23 jnz -> 5
    0xC3,                        // 25 ret
    0x89, 0x0D, ...d32(B),       // 26 writeB: mov [B], ecx
    0xC3,                        // 32 ret
]), loopStub);
writeSentinelBytes(mem0, sentinel);

const ex = preemptionManager.getWasmExports();
const env = {
    cpu, mem: mem0, runGuestUntil: ex && ex.run_guest_until, sentinelAddress: sentinel,
    abortLo: 0, abortHi: 0,
    pin: () => sys.scheduler.pinCurrentThread(), unpin: () => sys.scheduler.unpinCurrentThread(),
};
const dv = () => { const m = p.getCurrentMemory(); return new DataView(m.buffer, m.byteOffset, m.byteLength); };
const u32 = (a) => dv().getUint32(a >>> 0, true) >>> 0;
const poke = (a, v) => dv().setUint32(a >>> 0, v >>> 0, true);
const shape = (label, rep, extra) => ({
    label, A: hex(u32(A)), B: hex(u32(B)), C: u32(C),
    hits: rep.hits.length, hitEips: [...new Set(rep.hits.map(h => hex(h.eip)))],
    pagesHit: rep.pagesHit, verdict: rep.verdict, changed: rep.changed,
    blind: rep.blind, unattributed: rep.unattributedChanges.length, ...extra,
});

function syncCase(watchAddr, label) {
    poke(A, 0); poke(B, 0);
    memWriteTrap.arm(watchAddr, 4, label, { watch: true });
    const call = callGuestFunctionSync(env, codePage, [], "cdecl", 100000);
    const rep = memWriteTrap.report();
    memWriteTrap.disarm();
    return shape(label, rep, { call, watch: hex(watchAddr) });
}
const syncSecond = syncCase(B, "sync-second");
const syncFirst = syncCase(A, "sync-first");

poke(A, 0); poke(B, 0); poke(C, 0);
memWriteTrap.arm(B, 4, "thread-loop", { watch: true });       // default: full speed, self-escalating
sys.scheduler.createThread(loopStub, 0, 0x10000, 0, 0, p.getCurrentMemory());
await new Promise(r => setTimeout(r, 5000));
const firstRunHits = memWriteTrap.report().hits.length;
poke(C, 0);
sys.scheduler.createThread(loopStub, 0, 0x10000, 0, 0, p.getCurrentMemory());
await new Promise(r => setTimeout(r, 8000));
const repT = memWriteTrap.report();
memWriteTrap.disarm();
const threadLoop = shape("thread-loop", repT, { watch: hex(B), iterations: ITER, firstRunHits });

return { A: hex(A), B: hex(B), codePage: hex(codePage), loopStub: hex(loopStub), syncSecond, syncFirst, threadLoop };
`;

let h = harness();
if (!process.env.NO_BOOT) h = h.openWgb(process.env.WGB ?? "g:/WGB/running/hl-day-one.wgb").sleep(Number(process.env.BOOT_MS ?? 30000));
const r: any = await h.call("evalWorker", CODE).run();

const res = r.steps?.find((s: any) => s.cmd === "evalWorker")?.result;
console.log(JSON.stringify(res, null, 2));
if (!res || res.error) process.exit(1);

const { syncSecond, syncFirst, threadLoop } = res;
const bad: string[] = [];
if (syncFirst.hits < 1) bad.push("sync-first: no hit — the attributable control regressed");
if (syncFirst.pagesHit === 0) bad.push("sync-first: pagesHit=0 with hits recorded");
if (syncSecond.B === "0x0") bad.push("sync-second: the stub never ran");
if (syncSecond.hits === 0 && !syncSecond.changed) bad.push("sync-second: SILENT ZERO — B changed, trap reported neither a hit nor a change");
if (threadLoop.C === 0) bad.push("thread-loop: the guest thread never ran");
else if (threadLoop.hits < threadLoop.iterations) {
    bad.push(`thread-loop: ${threadLoop.hits}/${threadLoop.iterations * 2} writes to B attributed ` +
        `(first burst ${threadLoop.firstRunHits}); the trap must attribute a full burst once it has escalated`);
}
console.log(bad.length ? "\nFAIL:\n  " + bad.join("\n  ") : "\nOK — attributed where it can be, and declared unobservable where it cannot");
if (bad.length) process.exit(2);

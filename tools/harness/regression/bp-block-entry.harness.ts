/**
 * Does an EIP breakpoint fire on an address that is not a v86 BLOCK ENTRY?
 *
 * v86 calls dbg_on_instruction ONCE per cycle_internal (per block), not per instruction,
 * and its interpreter only ends a block at call/ret/out/far or page-crossing control flow —
 * a plain jmp/jcc does not end one. So the prediction is: a bp on a function entry fires,
 * a bp on the instruction after it never does. Both `fast:true` and JIT-off share the hook.
 *
 * Stub (called N times through run_guest_until):
 *   +0  nop            <- entry, a block entry
 *   +1  nop            <- mid-block
 *   +2  mov [D], eax   <- mid-block, the "known writer" shape
 *   +8  ret
 *
 *   BS_TAB=<tab> bun tools/harness.ts run tools/harness/regression/bp-block-entry.harness.ts
 *   (needs a booted guest in the tab; restores the JIT and clears all bps on the way out)
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

const mem = p.getCurrentMemory();
if (!state.bpArena) state.bpArena = p.memory.alloc(0x2000, "HEAP", "rw", 0x1000);
const arena = state.bpArena >>> 0;
const stub = arena;
const D = (arena + 0x1000 + 0x40) >>> 0;
const sentinel = (arena + 0x200) >>> 0;
const d32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
writeGuestCode(mem, new Uint8Array([0x90, 0x90, 0xA3, ...d32(D), 0xC3]), stub);
writeSentinelBytes(mem, sentinel);

const ex = preemptionManager.getWasmExports();
const env = {
    cpu, mem, runGuestUntil: ex && ex.run_guest_until, sentinelAddress: sentinel,
    abortLo: 0, abortHi: 0,
    pin: () => sys.scheduler.pinCurrentThread(), unpin: () => sys.scheduler.unpinCurrentThread(),
};

// Count "<BP>" lines per eip ourselves — eipBreaks reads the same console.error stream.
const seen = {};
const origErr = console.error;
console.error = (...a) => {
    const s = a[0];
    if (typeof s === "string" && s.indexOf("<BP>") !== -1) {
        const m = /eip=0x([0-9a-fA-F]{8}) <BP>/.exec(s);
        if (m) seen[m[1]] = (seen[m[1]] || 0) + 1;
    }
    origErr.apply(console, a);
};

function trial(addr, mode) {
    dbg.clear();
    for (const k of Object.keys(seen)) delete seen[k];
    if (mode === "fast") dbg.bpFast(addr); else { dbg.enable(); dbg.bp(addr); }
    dbg.maxDumps(1000000);
    let ok = 0;
    for (let i = 0; i < 5; i++) if (callGuestFunctionSync(env, stub, [], "cdecl", 10000).ok) ok++;
    const key = (addr >>> 0).toString(16).padStart(8, "0");
    const hits = seen[key] || 0;
    dbg.clear();
    return { addr: "0x" + (addr >>> 0).toString(16), mode, calls: ok, bpLines: hits, allSeen: { ...seen } };
}

// Burn the wasm dump counter first: past DBG_MAX_DUMPS, dbg_on_instruction stops
// emitting the "<BP>" line the JS side listens for, and the bp is silent.
dbg.clear(); dbg.enable(); dbg.maxDumps(4); dbg.step(40);
for (let i = 0; i < 3; i++) callGuestFunctionSync(env, stub, [], "cdecl", 10000);
const afterBurn = trial(stub, "fast");

const r = [
    { ...afterBurn, mode: "fast-after-dump-counter-burn" },
    trial(stub, "fast"),         // +0 entry
    trial(stub + 1, "fast"),     // +1 mid-block
    trial(stub + 2, "fast"),     // +2 mid-block (the store)
    trial(stub, "jitoff"),
    trial(stub + 2, "jitoff"),
];
console.error = origErr;
dbg.clear(); dbg.jitOn();
return { stub: "0x" + stub.toString(16), trials: r };
`;

const r: any = await harness().call("evalWorker", CODE).run();
const res = r.steps?.find((s: any) => s.cmd === "evalWorker")?.result;
console.log(JSON.stringify(res, null, 2));
for (const t of res?.trials ?? []) {
    console.log(`${t.mode.padEnd(7)} bp@${t.addr}: ${t.calls} calls, ${t.bpLines} <BP> line(s)`);
}
const t = res?.trials ?? [];
const entry = t.filter((x: any) => x.addr.endsWith("000"));
const mid = t.filter((x: any) => !x.addr.endsWith("000"));
const bad = entry.some((x: any) => x.bpLines === 0) || mid.some((x: any) => x.bpLines > 0);
console.log(bad
    ? "\nUNEXPECTED — v86 block-entry behaviour changed; re-read the eip-breaks header"
    : "\nCHARACTERIZED — bps fire ONLY at a block entry; a mid-block address is silent while the code runs");
if (bad) process.exit(2);

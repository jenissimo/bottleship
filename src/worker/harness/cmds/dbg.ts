/**
 * dbg — generic RPC bridge to the worker's dbg command table (dbg-commands.ts),
 * with the return value delivered over harness_rpc instead of console.log.
 *
 * The legacy `{type:'dbg'}` channel is fire-and-forget: results go to the log
 * firehose and an agent has to grep them back out. `dbgCall` invokes the same
 * functions and returns whatever they return (dispatchStats' counter object,
 * jitcfg's void, ...) as the step result — so measurement-gate runs
 * (d3d9Perf / dispatchStats / trace2PageHistogram A/Bs) read as plain POJOs
 * from a harness chain: `.call("dbgCall", "dispatchStats")`.
 *
 * Functions that only console.log their JSON (e.g. d3d9Perf) still do; their
 * return value (if any) rides the RPC reply.
 */

import type { HarnessService } from "../service";
import { dbg } from "../../core/debug/dbg-commands";
import { System } from "../../core/system";

/** Decode a generated thunk stub (`B8 <id32> BA 77 B0 00 00 EF C2 <cleanup16>`). */
function decodeStub(mem: Uint8Array, addr: number, names: Record<number, string> | undefined) {
    if (addr < 0 || addr + 12 > mem.length) return { valid: false as const, reason: "out of range" };
    if (mem[addr] !== 0xB8) return { valid: false as const, reason: `not a stub (byte 0x${mem[addr].toString(16)})` };
    const functionId = (mem[addr + 1] | (mem[addr + 2] << 8) | (mem[addr + 3] << 16) | (mem[addr + 4] << 24)) >>> 0;
    const cleanup = mem[addr + 9] === 0xC2 ? (mem[addr + 10] | (mem[addr + 11] << 8)) : 0;
    return { valid: true as const, functionId, name: names?.[functionId] ?? null, cleanup };
}

export function registerDbgCommands(svc: HarnessService): void {
    /**
     * comVtable(module, iface?) — dump a module's COM vtables slot by slot, resolving each
     * slot to the thunk it points at.
     *
     * A vtable is allocated with exactly as many dwords as its InterfaceDescriptor declares
     * and sits flush against generated stub code, so a guest call to a slot we under-declared
     * reads raw x86 as a function pointer and jumps into hyperspace. That failure only shows up
     * as an unrelatable wild EIP, so `unresolvedSlots` — any slot whose target does not decode
     * as a stub — is the field worth reading first.
     */
    svc.register("comVtable", (args) => {
        const [moduleName, iface] = args as [string, string | undefined];
        const process = System.getInstance().process;
        const mod = process?.getModule?.(moduleName) as { vtables?: Record<string, { address: number; size: number }> } | undefined;
        const vtables = mod?.vtables;
        if (!vtables) throw new Error(`comVtable: module '${moduleName}' has no vtables`);

        const mem = process!.getCurrentMemory();
        const names = (process!.dispatcher as unknown as { namesTable?: Record<number, string> })?.namesTable;
        const wanted = iface ? [iface] : Object.keys(vtables);

        const out = wanted.map((name) => {
            const vt = vtables[name];
            if (!vt) return { interface: name, error: "no such vtable", known: Object.keys(vtables) };
            const slots = [];
            for (let i = 0; i < vt.size; i++) {
                const target = ((mem[vt.address + i * 4]) | (mem[vt.address + i * 4 + 1] << 8)
                    | (mem[vt.address + i * 4 + 2] << 16) | (mem[vt.address + i * 4 + 3] << 24)) >>> 0;
                slots.push({ index: i, target: `0x${target.toString(16)}`, ...decodeStub(mem, target, names) });
            }
            return {
                interface: name,
                address: `0x${vt.address.toString(16)}`,
                slotCount: vt.size,
                unresolvedSlots: slots.filter((s) => !s.valid).map((s) => s.index),
                slots,
            };
        });

        return iface ? out[0] : out;
    });

    /** dbgCall(name, ...args) — invoke dbg[name](...args), return its result. */
    svc.register("dbgCall", (args) => {
        const [name, ...rest] = args as [string, ...unknown[]];
        const fn = (dbg as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
            throw new Error(`dbgCall: unknown dbg command '${name}'`);
        }
        return (fn as (...a: unknown[]) => unknown)(...rest) ?? null;
    });

    /** setWorkerFlag(name, value) — set a worker-global kill switch (the boot-time
     *  `globalThis.__no*` A/B flags like __noDrawWbuf / __noSetterShadow /
     *  __noStateBlockWbuf). Must run BEFORE the game load that registers the affected
     *  path (registration reads the flag once). Returns the previous value. */
    svc.register("setWorkerFlag", (args) => {
        const [name, value] = args as [string, unknown];
        if (typeof name !== "string" || !name.startsWith("__")) {
            throw new Error(`setWorkerFlag: refusing non-dunder flag '${String(name)}'`);
        }
        const g = globalThis as Record<string, unknown>;
        const prev = g[name];
        g[name] = value;
        return { name, value, prev: prev ?? null };
    });
}

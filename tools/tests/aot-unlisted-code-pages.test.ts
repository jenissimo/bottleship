// A JIT module keeps code from pages it no longer owns: once another module becomes a page's
// owner, the engine lists the first one only as a hidden holder of it, and the AOT snapshot
// (which asks for the pages a table index owns) left that page out of the unit. Replay then
// content-checked only the listed pages and published a module whose blocks still ran the
// unlisted page's old translation. Such units are now not recorded (the block map read at
// codegen_finalize names every page a module's blocks came from) and not replayed (codePages,
// or for older units the lowest entry block in the module's name).

import { afterAll, describe, expect, test } from "bun:test";
import { aotCache, moduleNamePrimaryEntry, unlistedCodePage } from "../../src/worker/core/cpu/aot-cache";

const PAGE = 4096;
const replaced = ["System", "preemption", "__wasmDump"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
const ownMethods = ["engineFingerprint", "hostFingerprint"].map(k => [k, Object.getOwnPropertyDescriptor(aotCache, k)] as const);
afterAll(() => {
    for (const [k, d] of ownMethods) {
        if (d) Object.defineProperty(aotCache, k, d); else delete (aotCache as any)[k];
    }
    for (const [k, d] of replaced) {
        if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k];
    }
    aotCache.disarm();
    aotCache.clear();
});

/** A minimal module: header, then a custom "name" section naming function 0 `name`. */
function namedModule(name: string | null): Uint8Array {
    const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    if (name !== null) {
        const enc = new TextEncoder();
        const fn = [...enc.encode(name)];
        const sub = [0x01, 0x00, fn.length, ...fn];                 // count 1, index 0, name
        const nameSec = [...enc.encode("name")];
        const body = [nameSec.length, ...nameSec, 0x01, sub.length + 1, ...sub];
        out.push(0x00, body.length, ...body);
    }
    return new Uint8Array(out);
}

const pages = (...p: number[]) => p.map(physPage => ({ physPage }));

describe("AOT units cover every page their module runs code from", () => {
    test("codePages that the unit does not list are reported", () => {
        expect(unlistedCodePage({ pages: pages(0x900), codePages: [0x8f5, 0x900], bytes: namedModule(null) })).toBe(0x8f5);
        expect(unlistedCodePage({ pages: pages(0x8f5, 0x900), codePages: [0x8f5, 0x900], bytes: namedModule(null) })).toBeNull();
    });

    test("without codePages the module name's lowest entry block is the fallback", () => {
        expect(moduleNamePrimaryEntry(namedModule("g008f5020@t879"))).toBe(0x8f5020);
        expect(moduleNamePrimaryEntry(namedModule(null))).toBeNull();
        expect(unlistedCodePage({ pages: pages(0x900), bytes: namedModule("g008f5020@t879") })).toBe(0x8f5);
        expect(unlistedCodePage({ pages: pages(0x8f5, 0x900), bytes: namedModule("g008f5020@t879") })).toBeNull();
        expect(unlistedCodePage({ pages: pages(0x900), bytes: namedModule(null) })).toBeNull();
    });

    test("recording reads the block map at codegen_finalize; snapshot drops a unit with an unlisted page", async () => {
        const memory = new Uint8Array(PAGE * 8);
        const wasmMemory = new ArrayBuffer(4096);
        const blockWords = new Uint32Array(wasmMemory, 1024, 16);
        let blockMapOn = 0;
        const wasm: any = {
            jit_block_map_set_enabled: (v: number) => { blockMapOn = v; },
            jit_block_map_enabled: () => blockMapOn,
            jit_block_map_count: () => 2,
            jit_block_map_ptr: () => 1024,
            jit_aot_page_table_index: () => 7,
            jit_aot_module_page_count: () => 1,                 // the engine lists only page 0
            jit_aot_module_page_at: () => 0,
            jit_aot_page_entry_count: () => 1,
            jit_aot_page_entry_at: () => 0,
            jit_aot_page_state_flags: () => 0,
            jit_config_abi_version: () => 1,
            jit_config_supported_mask: () => 1,
            jit_codegen_fingerprint_lo: () => 1,
            jit_codegen_fingerprint_hi: () => 0,
        };
        const cpu: any = {
            mem8: memory, memory_size: new Uint32Array([memory.length]), wm: { exports: wasm }, wasm_memory: { buffer: wasmMemory },
            codegen_finalize(index: number, start: number) {
                const dump = (globalThis as any).__wasmDump;
                dump.out.push({ start, table_index: index, len: 4, bytes: new Uint8Array([1, 2, 3, 4]) });
            },
        };
        (globalThis as any).System = { getInstance: () => ({ process: { v86: { cpu } } }) };
        (globalThis as any).preemption = { getWasmExports: () => wasm };
        (aotCache as any).engineFingerprint = async () => "engine";
        (aotCache as any).hostFingerprint = async () => "host";
        aotCache.clear();

        const record = async (blockPages: number[]) => {
            aotCache.armAll();
            expect(blockMapOn).toBe(1);
            blockPages.forEach((page, i) => {                       // [start, virt, end, ...] per block
                blockWords[i * 8] = page * PAGE + 0x20;
                blockWords[i * 8 + 2] = page * PAGE + 0x40;
            });
            cpu.codegen_finalize(7, 0);
            const rec = (globalThis as any).__wasmDump.out[0];
            const snap = await aotCache.snapshot();
            aotCache.disarm();
            return { rec, snap };
        };

        const bad = await record([0, 5]);
        expect(bad.rec.codePages).toEqual([0, 5]);
        expect(bad.snap.units).toBe(0);
        expect(bad.snap.skipped).toBe(1);

        const good = await record([0, 0]);
        expect(good.rec.codePages).toEqual([0]);
        expect(good.snap.units).toBe(1);
        expect(aotCache.getUnits()[0]!.codePages).toEqual([0]);
        expect(blockMapOn).toBe(0);                                 // disarm restores the switch
    });

    test("a recompiled earlier page gets its own map, and a capture without one is not published", async () => {
        const memory = new Uint8Array(PAGE * 8);
        const wasmMemory = new ArrayBuffer(4096);
        const blockWords = new Uint32Array(wasmMemory, 1024, 16);
        let blockMapOn = 0, mapAvailable = true;
        const tableOf = new Map<number, number>();
        const wasm: any = {
            jit_block_map_set_enabled: (v: number) => { blockMapOn = v; },
            jit_block_map_enabled: () => blockMapOn,
            jit_block_map_count: () => (mapAvailable ? 2 : 0),
            jit_block_map_ptr: () => 1024,
            jit_aot_page_table_index: (addr: number) => tableOf.get(addr >>> 12) ?? 0,
            jit_aot_module_page_count: () => 1,
            jit_aot_module_page_at: (idx: number) => [...tableOf.entries()].find(([, t]) => t === idx)![0] * PAGE,
            jit_aot_page_entry_count: () => 1,
            jit_aot_page_entry_at: () => 0,
            jit_aot_page_state_flags: () => 0,
            jit_config_abi_version: () => 1,
            jit_config_supported_mask: () => 1,
            jit_codegen_fingerprint_lo: () => 1,
            jit_codegen_fingerprint_hi: () => 0,
        };
        const cpu: any = {
            mem8: memory, memory_size: new Uint32Array([memory.length]), wm: { exports: wasm }, wasm_memory: { buffer: wasmMemory },
            codegen_finalize(index: number, start: number) {
                const out = (globalThis as any).__wasmDump.out;
                const rec = { start, table_index: index, len: 4, bytes: new Uint8Array([1, 2, 3, index]) };
                const i = out.findIndex((r: any) => (r.start >>> 12) === (start >>> 12));
                if (i >= 0) out[i] = rec; else out.push(rec);
                tableOf.set(start >>> 12, index);
            },
        };
        const blocks = (pages: number[]) => pages.forEach((page, i) => {
            blockWords[i * 8] = page * PAGE + 0x20;
            blockWords[i * 8 + 2] = page * PAGE + 0x40;
        });
        (globalThis as any).System = { getInstance: () => ({ process: { v86: { cpu } } }) };
        (globalThis as any).preemption = { getWasmExports: () => wasm };
        (aotCache as any).engineFingerprint = async () => "engine";
        (aotCache as any).hostFingerprint = async () => "host";
        aotCache.clear();

        aotCache.armAll();
        blocks([0, 0]); cpu.codegen_finalize(7, 0);
        blocks([1, 1]); cpu.codegen_finalize(8, PAGE);
        blocks([0, 5]); cpu.codegen_finalize(9, 0);                 // replaces record 0 in place
        const out = (globalThis as any).__wasmDump.out;
        expect(out.length).toBe(2);
        expect(out[0].table_index).toBe(9);
        expect(out[0].codePages).toEqual([0, 5]);
        expect(out[1].codePages).toEqual([1]);
        const snap = await aotCache.snapshot();
        expect(snap.units).toBe(1);
        expect(snap.skipped).toBe(1);
        expect(aotCache.getUnits().map(u => u.pages[0]!.physPage)).toEqual([1]);
        aotCache.disarm();

        aotCache.clear();
        aotCache.armAll();
        mapAvailable = false;
        blocks([2, 2]); cpu.codegen_finalize(10, 2 * PAGE);
        expect((globalThis as any).__wasmDump.out.at(-1).codePages).toBeNull();
        const none = await aotCache.snapshot();
        expect(none.units).toBe(0);
        aotCache.disarm();
    });

    test("replay refuses a unit with an unlisted code page before instantiating it", async () => {
        const memory = new Uint8Array(PAGE * 8);
        const tx = () => 0;
        const wasm: any = {
            jit_aot_tx_begin: tx, jit_aot_tx_page_begin: tx, jit_aot_tx_entry_push: tx,
            jit_aot_tx_page_finish: tx, jit_aot_tx_prepare_finish: tx, jit_aot_tx_commit: tx, jit_aot_tx_abort: tx,
        };
        const cpu: any = { mem8: memory, wm: { exports: wasm, wasm_table: {} }, jit_imports: {} };
        (globalThis as any).System = { getInstance: () => ({ process: { v86: { cpu } } }) };
        (globalThis as any).preemption = { getWasmExports: () => wasm };
        aotCache.clear();
        (aotCache as any).units = [{
            entryPage: 0x900, tableIndex: 879, bytes: namedModule("g008f5020@t879"),
            pages: [{ physPage: 0x900, stateFlags: 0, entries: [[0x487, 0]], sha: "x" }],
        }];
        const r = await aotCache.replay();
        expect(r.registered).toBe(0);
        expect(r.refused["unlisted-code-page"]).toBe(1);
        (aotCache as any).units = [];
    });
});

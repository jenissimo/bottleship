#!/usr/bin/env node
/**
 * Execute a lowered unit against a memory and a TLB we control.
 *
 * The corpus runs one shape of one kernel through a real engine. That is the right thing to
 * compare against and the wrong thing to look for edge cases with: a mapping the kernel never
 * builds, a trip count it never reaches and an operand alignment it never uses are all invisible
 * there, so a guard can be wrong about them and every gate stays green.
 *
 * This stand executes the emitted Wasm directly. It owns the page table, so it can place adjacent
 * virtual pages at unrelated physical addresses, leave a page out of the TLB, or hand the unit a
 * trip count that overflows the arithmetic it sizes ranges with — and then ask what the unit did,
 * not whether it looked plausible.
 *
 * It is not a substitute for the engine differential. It answers a different question: what does
 * this module DO when the state it assumes is not the state it gets.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const HERE = url.fileURLToPath(new URL(".", import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const MANIFEST = path.join(REPO, "tools", "aot", "opt", "compiler", "Cargo.toml");
const SPLIT_LINES = new RegExp("\\r?\\n");

/** vendor/v86 fixed linear-memory offsets (tools/aot/lib/abi.mjs, compiler `g`). */
export const G = {
    reg32: 64,
    last_op_size: 96,
    flags_changed: 100,
    last_op1: 104,
    last_result: 112,
    flags: 120,
    instruction_pointer: 556,
    instruction_counter: 664,
};
export const REG = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };

/** cpu/cpu.rs TLB entry bits. */
export const TLB = { VALID: 1, READONLY: 2, NO_USER: 4, IN_MAPPED_RANGE: 8, GLOBAL: 16, HAS_CODE: 32 };

/** Where the stand puts its own structures inside the imported memory. */
const MEMORY_PAGES = 64;                    // the contract's `e.m` size
const TLB_BASE = 0x1000;                    // 1 KiB of globals, then the table
const TLB_ENTRIES = 0x400;                  // covers guest addresses below 0x400000
const SCRATCH = 0x4000;                     // 2 page-aligned pages, as `jit_paging_scratch_buffer`
const DATA_BASE = 0x8000;                   // physical frames the stand hands out

/**
 * Lower `code` at `entryEip` and return the module bytes with the TLB relocation applied.
 *
 * The unit is built by the SAME compiler binary the gate uses; a stand that lowered its own copy
 * of the IR would be testing a compiler nobody ships.
 */
export function lower(entryEip, code, { passes = "", loopBound = 100003 } = {}) {
    const hex = Buffer.from(code).toString("hex");
    const args = ["run", "--quiet", "--manifest-path", MANIFEST, "--bin", "lower_entry", "--"];
    if (passes) args.push("--passes", passes);
    args.push(entryEip.toString(16), hex, String(loopBound));
    const out = execFileSync("cargo", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const r = JSON.parse(out.trim().split(SPLIT_LINES).at(-1));
    if (r.status !== "ok") throw new Error(`lowering failed: ${r.why}`);
    const bytes = Buffer.from(r.hex, "hex");
    for (const reloc of r.relocs) {
        if (reloc.kind !== "tlb_data" || reloc.width !== 5) {
            throw new Error(`unsupported relocation ${reloc.kind}/${reloc.width}`);
        }
        let x = TLB_BASE >>> 0;
        for (let i = 0; i < 5; i++) {
            bytes[reloc.fileOffset + i] = (x & 0x7f) | (i < 4 ? 0x80 : 0);
            x >>>= 7;
        }
    }
    return { bytes, info: r };
}

/** A machine the unit runs over: registers, a page table, and a record of what it asked for. */
export class Stand {
    constructor() {
        this.memory = new WebAssembly.Memory({ initial: MEMORY_PAGES });
        this.u8 = new Uint8Array(this.memory.buffer);
        this.u32 = new Uint32Array(this.memory.buffer);
        this.i32 = new Int32Array(this.memory.buffer);
        /** virtual page -> physical byte address of the frame backing it. */
        this.frames = new Map();
        this.nextFrame = DATA_BASE;
        this.calls = { read32: 0, read8: 0, write32: 0, crossings: 0, faultEnd: 0, retired: [] };
        /** Set when a slow helper is asked about a page the stand refuses to map. */
        this.faults = [];
    }

    reg(name) { return this.u32[(G.reg32 >> 2) + REG[name]] >>> 0; }
    setReg(name, value) { this.u32[(G.reg32 >> 2) + REG[name]] = value >>> 0; }
    get eip() { return this.u32[G.instruction_pointer >> 2] >>> 0; }
    get counter() { return this.u32[G.instruction_counter >> 2] >>> 0; }

    /**
     * Map one virtual page onto a physical frame, with the given TLB bits.
     *
     * `physical` defaults to a fresh frame, which is what makes adjacent virtual pages land on
     * UNRELATED physical memory — the arrangement a unit that translates once and then reads
     * across a page boundary gets wrong.
     */
    map(virtualAddr, { physical = null, bits = TLB.VALID } = {}) {
        const virtPage = virtualAddr & ~0xfff;
        const phys = physical ?? (this.nextFrame += 0x1000) - 0x1000;
        this.frames.set(virtPage, phys);
        const entry = ((phys ^ virtPage) & ~0xfff) | bits;
        this.u32[(TLB_BASE >> 2) + (virtPage >>> 12)] = entry >>> 0;
        return phys;
    }

    /** Remove a mapping: the entry becomes 0, which is what an untouched page looks like. */
    unmap(virtualAddr) {
        const virtPage = virtualAddr & ~0xfff;
        this.frames.delete(virtPage);
        this.u32[(TLB_BASE >> 2) + (virtPage >>> 12)] = 0;
    }

    /** Physical address of a virtual one, or null when nothing backs it. */
    physical(virtualAddr) {
        const frame = this.frames.get(virtualAddr & ~0xfff);
        return frame === undefined ? null : frame + (virtualAddr & 0xfff);
    }

    readGuest32(virtualAddr) {
        const at = this.physical(virtualAddr);
        if (at === null) throw new Error(`no frame for 0x${virtualAddr.toString(16)}`);
        return this.u32[at >> 2] >>> 0;
    }

    writeGuest32(virtualAddr, value) {
        const at = this.physical(virtualAddr);
        if (at === null) throw new Error(`no frame for 0x${virtualAddr.toString(16)}`);
        this.u32[at >> 2] = value >>> 0;
    }

    /**
     * The engine's slow helpers, as this stand implements them: resolve the address and return the
     * TLB entry, exactly as the contract says (N49 — the helper does not perform the access).
     */
    imports() {
        /**
         * `cpu.rs::safe_read_slow_jit`, as the contract has it: RESOLVE, do not access. The
         * return value is `(physical_base ^ addr) & !0xFFF` — bit 0 is therefore always clear on
         * success, and `1` means the access faulted. Getting that convention wrong would make the
         * conservative arm fault on every slow access and the comparison meaningless.
         *
         * A page-crossing access is why the helper exists at all: the two halves live in
         * unrelated frames, so it assembles them into a two-page scratch buffer and returns a
         * base into THAT. Any translator that skips the crossing test and translates once is
         * reading one frame and calling it both.
         */
        const slow = (addr, bytes) => {
            const page = addr & ~0xfff;
            if (!this.frames.has(page)) {
                this.faults.push({ addr, kind: "unmapped" });
                return 1;
            }
            const crosses = (addr & 0xfff) + bytes > 0x1000;
            if (!crosses) return ((this.frames.get(page) ^ page) & ~0xfff) >>> 0;
            const high = page + 0x1000;
            if (!this.frames.has(high)) {
                this.faults.push({ addr, kind: "unmapped-high" });
                return 1;
            }
            const low = this.frames.get(page), highFrame = this.frames.get(high);
            for (let i = addr & 0xfff; i < 0x1000; i++) this.u8[SCRATCH + i] = this.u8[low + i];
            const tail = ((addr & 0xfff) + bytes) & 0xfff;
            for (let i = 0; i < tail; i++) this.u8[SCRATCH + 0x1000 + i] = this.u8[highFrame + i];
            this.calls.crossings++;
            return ((SCRATCH ^ addr) & ~0xfff) >>> 0;
        };
        return {
            e: {
                m: this.memory,
                safe_read32s_slow_jit: (addr) => { this.calls.read32++; return slow(addr, 4); },
                safe_read8_slow_jit: (addr) => { this.calls.read8++; return slow(addr, 1); },
                safe_write32_slow_jit: (addr) => { this.calls.write32++; return slow(addr, 4); },
                trigger_fault_end_jit: () => { this.calls.faultEnd++; },
                jit_tier2_note_aot_retired: (n) => { this.calls.retired.push(n >>> 0); },
            },
        };
    }

    /** Instantiate and enter the unit at one dispatcher index. */
    run(bytes, entryIndex = 0) {
        const module = new WebAssembly.Module(bytes);
        const instance = new WebAssembly.Instance(module, this.imports());
        instance.exports["f"](entryIndex);
        return this;
    }
}

/** Place `count` dwords at `addr`, mapping pages as needed with a fresh frame each. */
export function fill(stand, addr, values) {
    for (let i = 0; i < values.length; i++) {
        const at = addr + i * 4;
        if (!stand.frames.has(at & ~0xfff)) stand.map(at);
        stand.writeGuest32(at, values[i]);
    }
}

#!/usr/bin/env node
/** Execute the emitted pass off/on, including physical aliases and continuation boundaries. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Stand, lower, G, TLB } from "./wasm-stand.mjs";
import { KERNELS } from "../../aot-oracle/corpus/kernels.mjs";
import { k8Source, expectedK8Payload } from "./stack-oracle.mjs";
import { readSections, parseModule, walkBody, uleb } from "../lib/wdis.mjs";
import { lebU, lebS } from "../lib/wasm.mjs";

const ENTRY = 0x1000, RETURN = 0x1800, SRC = 0x50000, DST = 0x60000;
const TLB_BASE = 0x1000, SCRATCH = 0x4000;
const FRAME_PHYS = 0x12000, SOURCE_PHYS = 0x22000, DEST_PHYS = 0x32000;

/** Diagnostic copies only: native Wasm executes unchanged loads through a tracing import. */
export function traceLoads(bytes) {
    const shape = parseModule(bytes);
    assert.equal(shape.code.count, 1);
    const types = shape.types.length;
    const imports = shape.imports.filter(i => i.kind === 0).length;
    const name = value => {
        const out = [], encoded = Buffer.from(value);
        lebU(out, encoded.length); out.push(...encoded); return out;
    };
    const module = [...bytes.subarray(0, 8)];
    for (const section of readSections(bytes)) {
        let payload = [...bytes.subarray(section.start, section.end)];
        if (section.id === 1 || section.id === 2) {
            const [count, countBytes] = uleb(bytes, section.start);
            const out = []; lebU(out, count + (section.id === 1 ? 1 : 2));
            out.push(...payload.slice(countBytes));
            if (section.id === 1) out.push(0x60, 2, 0x7f, 0x7f, 1, 0x7f);
            else for (const field of ["load32", "load8"]) {
                out.push(...name("diagnostic"), ...name(field), 0); lebU(out, types);
            }
            payload = out;
        } else if (section.id === 7) {
            const out = []; lebU(out, shape.exports.length);
            for (const exp of shape.exports) {
                out.push(...name(exp.name), exp.kind); lebU(out, exp.index + (exp.kind === 0 ? 2 : 0));
            }
            payload = out;
        } else if (section.id === 10) {
            const body = [...bytes.subarray(shape.code.localsStart, shape.code.instrStart)];
            const instructions = [...walkBody(bytes, shape.code.instrStart, shape.code.instrEnd)];
            for (let i = 0; i < instructions.length; i++) {
                const ins = instructions[i];
                if (ins.op === 0x28 || ins.op === 0x2d) {
                    body.push(0x41); lebS(body, ins.imm.offset);
                    body.push(0x10); lebU(body, imports + (ins.op === 0x2d ? 1 : 0));
                }
                body.push(...bytes.subarray(ins.offset,
                    instructions[i + 1]?.offset ?? shape.code.instrEnd));
            }
            const out = []; lebU(out, 1); lebU(out, body.length); out.push(...body); payload = out;
        }
        module.push(section.id); lebU(module, payload.length); module.push(...payload);
    }
    const instrumented = Uint8Array.from(module);
    assert.equal(WebAssembly.validate(instrumented), true);
    return instrumented;
}

function reverseAliasGuards(bytes) {
    const mutant = Uint8Array.from(bytes), code = parseModule(bytes).code;
    const instructions = [...walkBody(bytes, code.instrStart, code.instrEnd)];
    const pattern = [0x20, 0x20, 0x41, 0x71, 0x20, 0x73, 0x20, 0x73, 0x41, 0x71, 0x41, 0x47, 0x71, 0x21];
    let changed = 0;
    for (let i = 0; i + pattern.length <= instructions.length; i++) {
        const window = instructions.slice(i, i + pattern.length);
        if (!window.every((ins, at) => ins.op === pattern[at])
            || window[0].imm !== window[13].imm || window[8].imm !== -4096 || window[10].imm !== 0) continue;
        mutant[window[11].offset] = 0x46;
        changed++;
    }
    assert.ok(changed > 0, "negative control mutated actual physical alias guards");
    return mutant;
}

/** Extend the existing stand with permission faults, cold refill and write-through crossings. */
export class ForwardingStand extends Stand {
    constructor() {
        super();
        this.pageBits = new Map();
        this.loads = [];
        this.codeWrites = [];
    }
    map(addr, options = {}) {
        this.pageBits.set(addr & ~0xfff, options.bits ?? TLB.VALID);
        return super.map(addr, options);
    }
    write32(addr, value) {
        for (let i = 0; i < 4; i++) this.u8[this.physical(addr + i)] = value >>> (i * 8);
    }
    readBytes(addr, length) {
        return Uint8Array.from({ length }, (_, i) => this.u8[this.physical(addr + i)]);
    }
    cold() {
        this.u32.fill(0, TLB_BASE >> 2, (TLB_BASE >> 2) + 0x400);
    }
    imports() {
        const imports = super.imports();
        const fault = (addr, offset, kind) => {
            this.faults.push({ addr: addr >>> 0, kind });
            this.u32[G.instruction_pointer >> 2] = (this.eip & ~0xfff) | offset;
            return 1;
        };
        const resolve = (addr, bytes, offset, write) => {
            const first = addr & ~0xfff, last = (addr + bytes - 1) & ~0xfff;
            for (const page of new Set([first, last])) {
                if (!this.frames.has(page)) return fault(addr, offset, "unmapped");
                const bits = this.pageBits.get(page);
                if (write && bits & TLB.READONLY) return fault(addr, offset, "readonly");
                this.u32[(TLB_BASE >> 2) + (page >>> 12)] =
                    (((this.frames.get(page) ^ page) & ~0xfff) | bits) >>> 0;
            }
            return null;
        };
        const read = (addr, bytes, offset) => {
            const failure = resolve(addr, bytes, offset, false);
            if (failure !== null) return failure;
            if ((addr & 0xfff) + bytes <= 0x1000) {
                return ((this.physical(addr) ^ addr) & ~0xfff) >>> 0;
            }
            this.calls.crossings++;
            for (let i = 0; i < bytes; i++) this.u8[SCRATCH + (addr & 0xfff) + i] =
                this.u8[this.physical(addr + i)];
            return ((SCRATCH ^ addr) & ~0xfff) >>> 0;
        };
        imports.e.safe_read32s_slow_jit = (addr, offset) => {
            this.calls.read32++; return read(addr, 4, offset);
        };
        imports.e.safe_read8_slow_jit = (addr, offset) => {
            this.calls.read8++; return read(addr, 1, offset);
        };
        imports.e.safe_write32_slow_jit = (addr, value, offset) => {
            this.calls.write32++;
            const failure = resolve(addr, 4, offset, true);
            if (failure !== null) return failure;
            if (this.pageBits.get(addr & ~0xfff) & TLB.HAS_CODE) this.codeWrites.push(addr >>> 0);
            if ((addr & 0xfff) + 4 <= 0x1000) return ((this.physical(addr) ^ addr) & ~0xfff) >>> 0;
            this.calls.crossings++;
            this.write32(addr, value);
            return ((SCRATCH ^ addr) & ~0xfff) >>> 0;
        };
        imports.diagnostic = {
            load32: (addr, offset) => { this.loads.push({ addr: (addr + offset) >>> 0, bytes: 4 }); return addr; },
            load8: (addr, offset) => { this.loads.push({ addr: (addr + offset) >>> 0, bytes: 1 }); return addr; },
        };
        return imports;
    }
}

export function seedK8(options = {}) {
    const s = new ForwardingStand();
    const esp = options.esp ?? 0x40fec, ebp = esp - 4;
    s.map(0x40000, { physical: FRAME_PHYS });
    if ((esp + 19) >> 12 !== esp >> 12) s.map(0x41000, { physical: 0x42000 });
    s.map(SRC, { physical: SOURCE_PHYS });
    s.map(DST, { physical: options.alias ? FRAME_PHYS : DEST_PHYS, bits: options.dstBits ?? TLB.VALID });
    if (options.dstHigh) s.map(DST + 0x1000, { physical: 0x52000 });
    const src = options.src ?? SRC;
    const dst = options.dst ?? DST;
    const source = k8Source();
    for (let i = 0; i < source.length; i++) {
        const physical = s.physical(src + i);
        if (physical !== null) s.u8[physical] = source[i];
    }
    for (const [i, value] of [RETURN, src, 16, dst, 0x21].entries()) s.write32(esp + i * 4, value);
    s.setReg("esp", esp);
    s.u32[G.instruction_pointer >> 2] = ENTRY;
    s.u32[G.flags >> 2] = 0x202;
    s.options = options;
    s.frame = { esp, ebp, bias: ebp + 20, stride: ebp + 12 };
    if (options.cold) s.cold();
    return s;
}

const snapshot = s => ({ memory: Buffer.from(s.u8), faults: s.faults, codeWrites: s.codeWrites,
    retired: s.calls.retired, faultEnd: s.calls.faultEnd });

function run(unit, options = {}, { instrumented = false, resume = false } = {}) {
    const s = seedK8(options);
    const bytes = instrumented ? traceLoads(unit.bytes) : unit.bytes;
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), s.imports());
    let index = 0;
    for (let i = 0; i < 100; i++) {
        instance.exports.f(index);
        if (!resume || s.eip === RETURN || s.faults.length) break;
        const entry = unit.info.entries.find(([offset]) => offset === (s.eip & 0xfff));
        assert.ok(entry, `budget continuation 0x${s.eip.toString(16)} has an entry`);
        index = entry[1];
    }
    return s;
}

export function conformance() {
    const checks = [];
    const check = (id, body) => {
        try { body(); checks.push({ id, ok: true }); }
        catch (error) { checks.push({ id, ok: false, error: error.message }); }
    };
    const pairs = new Map();
    const pair = (base = "flag-liveness,flags-in-locals", loopBound = 100003) => {
        const key = `${base}/${loopBound}`;
        if (!pairs.has(key)) pairs.set(key, {
            base: lower(ENTRY, KERNELS.k8.bytes, { passes: base, loopBound }),
            candidate: lower(ENTRY, KERNELS.k8.bytes, { passes: `${base},stack-load-forwarding`, loopBound }),
        });
        return pairs.get(key);
    };
    const ordinary = pair();
    check("formed two generic read-only cells and nine read sites", () => {
        assert.match(ordinary.candidate.info.stack_forwarding, /slots: 2, read_sites: 9/);
        assert.notDeepEqual(ordinary.base.bytes, ordinary.candidate.bytes);
        assert.deepEqual(ordinary.base.info.entries, ordinary.candidate.info.entries);
    });
    check("canonical payload and independent 490 guest-instruction oracle", () => {
        for (const unit of Object.values(ordinary)) {
            const s = run(unit);
            assert.equal(s.eip, RETURN);
            assert.equal(s.counter, 490);
            assert.deepEqual(s.calls.retired, [490]);
            assert.deepEqual(s.readBytes(DST, 512), expectedK8Payload());
        }
    });
    check("diagnostic tracing preserves complete native state", () => {
        for (const unit of Object.values(ordinary)) assert.deepEqual(snapshot(run(unit)), snapshot(run(unit, {}, { instrumented: true })));
    });
    check("observed bias physical reads 64 to 1 and stride reads 8 to 1", () => {
        const counted = unit => {
            const s = run(unit, {}, { instrumented: true });
            const count = linear => s.loads.filter(x => x.bytes === 4 && x.addr === s.physical(linear)).length;
            return { bias: count(s.frame.bias), stride: count(s.frame.stride) };
        };
        assert.deepEqual(counted(ordinary.base), { bias: 64, stride: 8 });
        assert.deepEqual(counted(ordinary.candidate), { bias: 1, stride: 1 });
    });
    const scenarios = [
        ["physical alias overwrites cached bias", { alias: true, dst: DST + 0xffc, dstHigh: true }],
        ["physical alias page with disjoint byte offsets", { alias: true, dst: DST + 0x100 }],
        ["partial overlapping unaligned store", { alias: true, dst: DST + 0xffa, dstHigh: true }],
        ["fault after two completed destination stores", { dst: DST + 0xff8 }],
        ["source fault after four completed destination stores", { src: SRC + 0xffc }],
        ["frame read crosses unrelated physical pages", { esp: 0x40fee }],
        ["destination write crosses unrelated physical pages", { dst: DST + 0xffe, dstHigh: true }],
        ["cold TLB refill helpers", { cold: true }],
        ["code-bearing writes retain slow path", { dstBits: TLB.VALID | TLB.HAS_CODE }],
        ["write permission fault", { dstBits: TLB.VALID | TLB.READONLY }],
    ];
    for (const passes of ["flag-liveness,flags-in-locals", "flag-liveness,scoped-memory,flags-in-locals", "flag-liveness,scoped-memory,dead-flag-stores"]) {
        const built = pair(passes);
        for (const [id, options] of scenarios) {
        check(`${passes}/${id}: complete memory, flags, registers, faults and retired ledger`, () => {
            const base = run(built.base, options), candidate = run(built.candidate, options);
            assert.deepEqual(snapshot(candidate), snapshot(base));
            assert.deepEqual(snapshot(run(built.candidate, options, { instrumented: true })), snapshot(candidate));
            if (id.includes("fault")) assert.equal(base.faults.length, 1);
            if (options.cold) assert.ok(base.calls.read8 > 0 && base.calls.write32 > 0);
            if (options.dstBits & TLB.HAS_CODE) assert.equal(base.codeWrites.length, 64);
            if (id.startsWith("frame read") || id.startsWith("destination write")) assert.ok(base.calls.crossings > 0);
            if (id.startsWith("fault after two")) assert.deepEqual(base.readBytes(DST + 0xff8, 8), expectedK8Payload().subarray(0, 8));
            if (id.startsWith("source fault after four")) assert.deepEqual(base.readBytes(DST, 16), expectedK8Payload().subarray(0, 16));
        });
        }
    }
    check("negative control detects reversed physical-alias guards", () => {
        const options = { alias: true, dst: DST + 0xffc, dstHigh: true };
        const mutant = { ...ordinary.candidate, bytes: reverseAliasGuards(ordinary.candidate.bytes) };
        assert.notDeepEqual(snapshot(run(mutant, options)), snapshot(run(ordinary.base, options)));
    });
    for (const basePasses of ["flag-liveness,flags-in-locals", "flag-liveness,scoped-memory,flags-in-locals", "flag-liveness,scoped-memory,dead-flag-stores"]) {
        check(`${basePasses}: budget exits resume at all reached dispatcher heads`, () => {
            const built = pair(basePasses, 17);
            const base = run(built.base, {}, { resume: true });
            const candidate = run(built.candidate, {}, { resume: true });
            assert.deepEqual(snapshot(candidate), snapshot(base));
            assert.equal(candidate.eip, RETURN);
            assert.equal(candidate.counter, 490);
            assert.ok(candidate.calls.retired.length > 1);
            assert.deepEqual(candidate.readBytes(DST, 512), expectedK8Payload());
        });
    }
    return { status: checks.every(x => x.ok) ? "passed" : "failed", checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const result = conformance();
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "passed") process.exitCode = 1;
}

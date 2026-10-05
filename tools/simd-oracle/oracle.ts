#!/usr/bin/env bun
// SIMD conformance oracle: the host CPU vs v86's interpreter vs v86's JIT.
//
//   bun tools/simd-oracle/oracle.ts [--filter re] [--cases N] [--mxcsr 1f80] [--strict-fpu]
//
// Every case (tools/simd-oracle/cases.ts) runs as a loop over N register states. The SAME
// instruction bytes execute natively (bun:ffi into executable memory — the CPU this runs on is
// the ground truth), in v86 with the JIT disabled, and in v86 with every code page force-
// compiled under the shipping JIT envelope (tools/jit-config/shipping.mjs), relaxed FPU and
// paging on — the shape the product runs. Two questions, reported separately:
//   JIT != interpreter      an optimisation bug (codegen diverged from the reference helper);
//   interpreter != native   a semantics bug in the helper itself.
// Floating-point lanes where both sides produced a NaN but different payloads are counted
// as NaN-only, not hidden.

import { dlopen, FFIType, CFunction, toArrayBuffer, ptr } from "bun:ffi";
import path from "node:path";
import { buildCases, type Case, type Lanes } from "./cases";
import { SHIPPING_JIT } from "../jit-config/shipping.mjs";
import { applyShape } from "../aot-oracle/lib/engine-unit.mjs";

const REPO = path.resolve(import.meta.dir, "../..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const FILTER = arg("--filter") ? new RegExp(arg("--filter")!, "i") : null;
const N = Number(arg("--cases") ?? 256);
const MXCSR = parseInt(arg("--mxcsr") ?? "1f80", 16);
const RELAXED = process.argv.includes("--strict-fpu") ? 0 : 1;

// ── per-case state block ────────────────────────────────────────────────────────────
const OFF_MM = 0x00, OFF_XMM = 0x40, OFF_MEM = 0xc0, OFF_EAX = 0x100, OFF_EDI = 0x104,
    OFF_MXCSR = 0x108, OFF_FLAGS = 0x10c, STRIDE = 0x140;

// ── shared body: load state from [ecx], run the case, store to [edx] ─────────────────
function modrm(mod: number, reg: number, rm: number) { return (mod << 6) | (reg << 3) | rm; }
const d32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
function body(c: Case, long: boolean): number[] {
    const b: number[] = [];
    for (let i = 0; i < 8; i++) b.push(0x0f, 0x6f, modrm(2, i, 1), ...d32(OFF_MM + 8 * i));
    for (let i = 0; i < 8; i++) b.push(0xf3, 0x0f, 0x6f, modrm(2, i, 1), ...d32(OFF_XMM + 16 * i));
    b.push(0x8b, modrm(2, 0, 1), ...d32(OFF_EAX));           // mov eax,[ecx+]
    b.push(0x8b, modrm(2, 7, 1), ...d32(OFF_EDI));           // mov edi,[ecx+]
    b.push(0x0f, 0xae, modrm(2, 2, 1), ...d32(OFF_MXCSR));   // ldmxcsr
    if (long) b.push(0x48);
    b.push(0x8d, modrm(2, 6, 1), ...d32(OFF_MEM));           // lea esi,[ecx+OFF_MEM]
    b.push(0x39, 0xc0);                                      // cmp eax,eax: flags known before the case
    b.push(...c.bytes);
    b.push(0x89, modrm(2, 0, 2), ...d32(OFF_EAX));           // mov [edx+],eax
    b.push(0x89, modrm(2, 7, 2), ...d32(OFF_EDI));
    b.push(0x9f);                                            // lahf
    b.push(0x88, modrm(2, 4, 2), ...d32(OFF_FLAGS));         // mov [edx+],ah
    b.push(0x0f, 0xae, modrm(2, 3, 2), ...d32(OFF_MXCSR));   // stmxcsr
    for (let i = 0; i < 8; i++) b.push(0x0f, 0x7f, modrm(2, i, 2), ...d32(OFF_MM + 8 * i));
    for (let i = 0; i < 8; i++) b.push(0xf3, 0x0f, 0x7f, modrm(2, i, 2), ...d32(OFF_XMM + 16 * i));
    for (let k = 0; k < 64; k += 16) {                       // the memory operand, after the case
        b.push(0xf3, 0x0f, 0x6f, modrm(1, 0, 6), k);
        b.push(0xf3, 0x0f, 0x7f, modrm(2, 0, 2), ...d32(OFF_MEM + k));
    }
    return b;
}

// ── native arm ───────────────────────────────────────────────────────────────────────
const k32 = dlopen("kernel32.dll", { VirtualAlloc: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.ptr } });
const EXEC_SIZE = 1 << 20;
const exec = k32.symbols.VirtualAlloc(null, EXEC_SIZE, 0x3000, 0x40)!;
const execMem = new Uint8Array(toArrayBuffer(exec, 0, EXEC_SIZE));
let execTop = 0;
function nativeRun(c: Case, input: Uint8Array): Uint8Array {
    // Win64: rcx=in, rdx=out, r8=count. rsi, rdi, xmm6, xmm7 and MXCSR are callee-saved.
    const pro = [0x56, 0x57, 0x48, 0x83, 0xec, 0x28, 0xf3, 0x0f, 0x7f, 0x34, 0x24, 0xf3, 0x0f, 0x7f, 0x7c, 0x24, 0x10,
        0x0f, 0xae, 0x5c, 0x24, 0x20];
    const loopBody = [...body(c, true), 0x48, 0x81, 0xc1, ...d32(STRIDE), 0x48, 0x81, 0xc2, ...d32(STRIDE), 0x49, 0xff, 0xc8];
    const jnz = [0x0f, 0x85, ...d32(-(loopBody.length + 6))];
    const epi = [0x0f, 0x77, 0x0f, 0xae, 0x54, 0x24, 0x20, 0xf3, 0x0f, 0x6f, 0x34, 0x24, 0xf3, 0x0f, 0x6f, 0x7c, 0x24, 0x10,
        0x48, 0x83, 0xc4, 0x28, 0x5f, 0x5e, 0xc3];
    const code = [...pro, ...loopBody, ...jnz, ...epi];
    if (execTop + code.length > EXEC_SIZE) execTop = 0;
    const at = execTop; execMem.set(code, at); execTop += (code.length + 63) & ~63;
    const fn = CFunction({ ptr: (Number(exec) + at) as any, args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void });
    const inp = new Uint8Array(input), out = new Uint8Array(input.length);
    fn(ptr(inp), ptr(out), BigInt(N));
    return out;
}

// ── v86 arm ──────────────────────────────────────────────────────────────────────────
const LOAD = 0x100000, ENTRY = LOAD + 0x20, PD = 0x108000, PT0 = 0x109000, STACK = 0x10c000,
    IN_ADDR = 0x200000, OUT_ADDR = 0x300000, PASS_ADDR = LOAD + 0x1000;
function image(c: Case, paging: boolean): Uint8Array {
    const buf = new Uint8Array(0x3000);
    const dv = new DataView(buf.buffer);
    const hdr = [0x1badb002, 0x10000, (-(0x1badb002 + 0x10000)) | 0, LOAD, LOAD, LOAD + buf.length, 0, ENTRY];
    hdr.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
    const pre: number[] = [0xfc, 0xbc, ...d32(STACK)];
    if (paging) {
        pre.push(0xbf, ...d32(PT0), 0xb8, ...d32(0x3), 0xb9, ...d32(2048));    // edi=PT0 eax=3 ecx=2048
        pre.push(0xab, 0x05, ...d32(0x1000), 0xe2, 0xf8);                       // stosd; add eax,4K; loop
        pre.push(0xc7, 0x05, ...d32(PD), ...d32(PT0 | 3), 0xc7, 0x05, ...d32(PD + 4), ...d32((PT0 + 0x1000) | 3));
        pre.push(0xb8, ...d32(PD), 0x0f, 0x22, 0xd8, 0x0f, 0x20, 0xc0, 0x0d, ...d32(0x80000000), 0x0f, 0x22, 0xc0);
    }
    pre.push(0xe9, ...d32(0));
    buf.set(pre, 0x20);
    dv.setInt32(0x20 + pre.length - 4, PASS_ADDR - (ENTRY + pre.length), true);   // jmp PASS_ADDR
    // One pass over the N states, then hlt. The driver re-enters by clearing in_hlt; the jmp
    // after the hlt starts the next pass, so the loop gets hot exactly as product code does.
    const head = [0xb9, ...d32(IN_ADDR), 0xba, ...d32(OUT_ADDR), 0xbd, ...d32(N)];
    const loopBody = [...body(c, false), 0x81, 0xc1, ...d32(STRIDE), 0x81, 0xc2, ...d32(STRIDE), 0x4d];
    const tail = [0x0f, 0x85, ...d32(-(loopBody.length + 6)), 0x0f, 0x77, 0xf4];
    const code = [...head, ...loopBody, ...tail];
    code.push(0xe9, ...d32(-(code.length + 5)));                                // jmp PASS_ADDR
    buf.set(code, PASS_ADDR - LOAD);
    return buf;
}

const wasmBytes = await Bun.file(path.join(REPO, "public/v86.wasm")).arrayBuffer();
const { V86 } = await import(path.join(REPO, "vendor/v86/build/libv86.mjs"));
async function makeEmulator(disableJit: boolean): Promise<any> {
    const emu = new V86({
        autostart: false, memory_size: 16 << 20, vga_memory_size: 1 << 20, log_level: 0, disable_jit: disableJit,
        wasm_fn: async (env: any) => (await WebAssembly.instantiate(wasmBytes, env)).instance.exports,
    });
    await new Promise<void>((r) => emu.add_listener("emulator-loaded", () => r()));
    if (!disableJit) applyShape(emu.v86.cpu.wm.exports, { flags: new Map(SHIPPING_JIT), relaxed: RELAXED });
    return emu;
}
function pageCompiled(cpu: any, page: number): boolean {
    const ex = cpu.wm.exports;
    const n = ex.jit_snapshot_cache();
    for (let i = 0; i < n; i++) if ((ex.jit_snapshot_get_phys_addr(i) >>> 12) === page) return true;
    return false;
}
const MAX_PASSES = 400;
const jitPasses: number[] = [];
async function v86Run(emu: any, c: Case, input: Uint8Array, jitted: boolean): Promise<Uint8Array | string> {
    const cpu = emu.v86.cpu;
    cpu.reboot_internal();
    cpu.reset_memory();
    cpu.load_multiboot(image(c, jitted).buffer);
    cpu.mem8.set(input, IN_ADDR);
    let exception: string | null = null;
    emu.cpu_exception_hook = (n: number) => { exception ??= `#${n} at eip=0x${(cpu.instruction_pointer[0] >>> 0).toString(16)}`; cpu.instruction_counter[0] += 100000; return false; };
    const page = PASS_ADDR >>> 12;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        // The measured pass is the first that STARTS with the loop page already compiled.
        const measured = !jitted || pageCompiled(cpu, page);
        const halted = new Promise<void>((r) => { const h = () => { emu.bus.unregister("cpu-event-halt", h); r(); }; emu.bus.register("cpu-event-halt", h); });
        const timeout = new Promise<string>((r) => setTimeout(() => r(`TIMEOUT eip=0x${(cpu.instruction_pointer[0] >>> 0).toString(16)}`), 20000));
        cpu.in_hlt[0] = 0;
        emu.run();
        const res = await Promise.race([halted.then(() => "ok"), timeout]);
        await emu.stop();
        if (exception) return `EXCEPTION ${exception}`;
        if (res !== "ok") return res;
        if (measured) { if (jitted) jitPasses.push(pass); return cpu.mem8.slice(OUT_ADDR, OUT_ADDR + N * STRIDE); }
        await new Promise((r) => setTimeout(r, 0));      // let an in-flight codegen_finalize land
    }
    return `NOT COMPILED after ${MAX_PASSES} passes`;
}

// ── inputs ───────────────────────────────────────────────────────────────────────────
function rnd(n: number) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
const F32_SPECIAL = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7fa00000, 0x00000001, 0x807fffff, 0x7f7fffff, 0x3f800000, 0xbf800000, 0x4b000000, 0xcf000000, 0x4f000000];
const F64_SPECIAL_HI = [0, 0x80000000, 0x7ff00000, 0xfff00000, 0x7ff80000, 0x7ff40000, 0x00000000, 0x3ff00000, 0xbff00000, 0x41e00000, 0xc1e00000, 0x43300000];
const I_EDGE = [0x00, 0xff, 0x80, 0x7f, 0x01];
function fillLanes(dv: DataView, off: number, len: number, lanes: Lanes, rare: boolean) {
    if (lanes === "f32") {
        for (let o = 0; o < len; o += 4) {
            if (rare && Math.random() < 0.3) dv.setUint32(off + o, F32_SPECIAL[(Math.random() * F32_SPECIAL.length) | 0], true);
            else dv.setFloat32(off + o, (Math.random() - 0.5) * 2 ** ((Math.random() * 60 - 30) | 0), true);
        }
    } else if (lanes === "f64") {
        for (let o = 0; o < len; o += 8) {
            if (rare && Math.random() < 0.3) { dv.setUint32(off + o, 0, true); dv.setUint32(off + o + 4, F64_SPECIAL_HI[(Math.random() * F64_SPECIAL_HI.length) | 0], true); }
            else dv.setFloat64(off + o, (Math.random() - 0.5) * 2 ** ((Math.random() * 80 - 40) | 0), true);
        }
    } else if (rare) {
        for (let o = 0; o < len; o++) if (Math.random() < 0.4) dv.setUint8(off + o, I_EDGE[(Math.random() * I_EDGE.length) | 0]);
    }
}
function makeInput(c: Case): Uint8Array {
    const buf = rnd(N * STRIDE);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < N; i++) {
        const base = i * STRIDE, rare = i % 2 === 1;
        fillLanes(dv, base + OFF_MM, 64, c.lanes === "i" ? "i" : c.lanes, rare);
        fillLanes(dv, base + OFF_XMM, 128, c.lanes, rare);
        fillLanes(dv, base + OFF_MEM, 64, c.lanes, rare);
        if (/cvtsi2s|pinsrw|movd|popcnt/.test(c.name) && rare) dv.setUint32(base + OFF_EDI, [0, 0x80000000, 0x7fffffff, 0xffffffff, 1][i % 5], true);
        dv.setUint32(base + OFF_MXCSR, MXCSR, true);
        dv.setUint32(base + OFF_FLAGS, 0, true);
    }
    return buf;
}

// ── compare ──────────────────────────────────────────────────────────────────────────
const isNaN32 = (v: number) => (v & 0x7f800000) === 0x7f800000 && (v & 0x7fffff) !== 0;
function diff(c: Case, a: Uint8Array, b: Uint8Array, input: Uint8Array) {
    let cases = 0, nanOnly = 0, mxcsrOnly = 0; let first = "";
    const dva = new DataView(a.buffer), dvb = new DataView(b.buffer);
    for (let i = 0; i < N; i++) {
        const base = i * STRIDE; let real = false, nan = false, flagsOnly = false; const where: string[] = [];
        for (let o = 0; o < 0x110; o += 4) {
            const x = dva.getUint32(base + o, true), y = dvb.getUint32(base + o, true);
            if (x === y) continue;
            if (o === OFF_FLAGS && ((x ^ y) & 0xd5) === 0) continue;       // ah: SF ZF AF PF CF only
            if (o === OFF_MXCSR && ((x ^ y) & ~0x3f) === 0) { flagsOnly = true; continue; }   // status bits only
            const both = c.lanes === "f32" ? isNaN32(x) && isNaN32(y)
                : c.lanes === "f64" && (o & 4) ? isNaN32(x) && isNaN32(y) : false;
            if (both) { nan = true; continue; }
            if (c.lanes === "f64" && !(o & 4) && o < OFF_EAX) {
                const hx = dva.getUint32(base + o + 4, true), hy = dvb.getUint32(base + o + 4, true);
                if (isNaN32(hx) && isNaN32(hy)) { nan = true; continue; }
            }
            real = true;
            where.push(regionName(o));
        }
        if (real) {
            cases++;
            if (!first) first = `[${i}] ${[...new Set(where)].join(",")}\n      in : ${hex(input, base, where)}\n      A  : ${hex(a, base, where)}\n      B  : ${hex(b, base, where)}`;
        } else if (nan) nanOnly++;
        else if (flagsOnly) mxcsrOnly++;
    }
    return { cases, nanOnly, mxcsrOnly, first };
}
function regionName(o: number) {
    if (o < OFF_XMM) return `mm${o >> 3}`;
    if (o < OFF_MEM) return `xmm${(o - OFF_XMM) >> 4}`;
    if (o < OFF_EAX) return "mem";
    return ["eax", "edi", "mxcsr", "flags"][(o - OFF_EAX) >> 2];
}
function hex(buf: Uint8Array, base: number, where: string[]) {
    const r = where[0]; let o = 0, n = 8;
    if (r.startsWith("mm")) { o = OFF_MM + 8 * +r.slice(2); n = 8; }
    else if (r.startsWith("xmm")) { o = OFF_XMM + 16 * +r.slice(3); n = 16; }
    else if (r === "mem") { o = OFF_MEM; n = 16; }
    else { o = OFF_EAX + 4 * ["eax", "edi", "mxcsr", "flags"].indexOf(r); n = 4; }
    return `${r}=` + [...buf.subarray(base + o, base + o + n)].reverse().map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── main ─────────────────────────────────────────────────────────────────────────────
const all = buildCases().filter((c) => !FILTER || FILTER.test(c.name));
console.log(`${all.length} forms × ${N} states, mxcsr=0x${MXCSR.toString(16)}, relaxed=${RELAXED}`);
const interp = await makeEmulator(true);
const jit = await makeEmulator(false);
let bad = 0, done = 0, nanForms = 0; const mxcsrForms: string[] = [];
for (const c of all) {
    const input = makeInput(c);
    if (process.env.ORACLE_TRACE) console.error(`[${c.name}] native`);
    const nat = nativeRun(c, input);
    if (process.env.ORACLE_TRACE) console.error(`[${c.name}] interpreter`);
    const ri = await v86Run(interp, c, input, false);
    if (process.env.ORACLE_TRACE) console.error(`[${c.name}] jit`);
    const rj = await v86Run(jit, c, input, true);
    const lines: string[] = [];
    if (typeof ri === "string") lines.push(`  interpreter: ${ri}`);
    if (typeof rj === "string") lines.push(`  jit: ${rj}`);
    if (typeof ri !== "string" && typeof rj !== "string") {
        const jvi = diff(c, ri, rj, input);
        if (jvi.cases) lines.push(`  JIT != interpreter: ${jvi.cases}/${N}  (A=interp B=jit)\n    ${jvi.first}`);
    }
    if (typeof ri !== "string") {
        const ivn = diff(c, nat, ri, input);
        if (ivn.cases) lines.push(`  interpreter != native: ${ivn.cases}/${N}  (A=native B=interp)\n    ${ivn.first}`);
        if (ivn.nanOnly) nanForms++;
        if (ivn.mxcsrOnly) mxcsrForms.push(c.name);
    }
    if (typeof rj !== "string") {
        const jvn = diff(c, nat, rj, input);
        if (jvn.cases) lines.push(`  jit != native: ${jvn.cases}/${N}  (A=native B=jit)\n    ${jvn.first}`);
    }
    // Streamed, so a run cut short still reports every form it reached.
    if (lines.length) { bad++; console.log(`${c.name}  [${c.bytes.map((x) => x.toString(16).padStart(2, "0")).join(" ")}]\n${lines.join("\n")}`); }
    if (++done % 50 === 0) console.error(`${done}/${all.length}`);
}
console.log(`\n${all.length} forms: ${bad} with divergences, ${nanForms} with NaN-payload-only differences`);
if (mxcsrForms.length) console.log(`MXCSR exception-status bits never raised by v86 (values correct): ${mxcsrForms.length} forms, e.g. ${mxcsrForms.slice(0, 6).join("; ")}`);
if (jitPasses.length) console.log(`JIT warm-up passes before the measured pass: min ${Math.min(...jitPasses)} max ${Math.max(...jitPasses)}`);
process.exit(0);

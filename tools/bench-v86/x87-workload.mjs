// Shared Node/browser workload and correctness gates; no platform-specific I/O.
export function createX87Workload(V86, {wasm, shipping, engineModule}) {
const SHIPPING_JIT = shipping;
const BASE = 0x100000, DATA = BASE + 0x3000, RES = DATA + 16;
function image(kind, top = 0, operand = 1, empty = 0) {
    const flagKernel = kind.startsWith('flags-');
    const sseKernel = kind.startsWith('flags-sse-');
    const bytes = new Uint8Array(0x4000), d = new DataView(bytes.buffer);
    [0x1badb002, 0x10000, (-0x1badb002 - 0x10000) >>> 0, BASE, BASE, BASE + bytes.length, BASE + bytes.length, BASE + (sseKernel ? 0x24 : 0x40)]
        .forEach((x, i) => d.setUint32(4 * i, x, true));
    // Enable SSE once during initial boot. Timed reruns start at 0x40 and do not
    // include serializing CR4 instructions or their extra JIT exits.
    if (sseKernel) bytes.set([0x0f,0x20,0xe0,0x0d,0,6,0,0,0x0f,0x22,0xe0,0xeb,0x0f],0x24);
    d.setUint32(DATA - BASE, 120000, true); d.setFloat64(DATA + 8 - BASE, 1, true);
    if (sseKernel) [1,1,-1,-1].forEach((v,i)=>d.setFloat64(DATA-BASE+160+i*8,v,true));
    if(kind==='flags-sse-broadcast')[0,1,2,3,1,2,3,4].forEach((v,i)=>d.setFloat32(DATA-BASE+160+i*4,v,true));
    let p = 0x40, count = 0;
    const e = (...b) => { bytes.set(b, p); p += b.length; count++; };
    const imm = n => { d.setUint32(p, n >>> 0, true); p += 4; };
    e(0x8b, 0x0d); imm(DATA); // mov ecx,[iterations]
    e(0x31, 0xf6);           // xor esi,esi
    if (flagKernel) e(0x31, 0xff); // independent carry accumulator EDI
    if (sseKernel) {
        e(0x66,0x0f,0x10,0x05); imm(DATA+160);
        e(0x66,0x0f,0x10,0x0d); imm(DATA+176);
    }
    if (kind !== 'matrix') {
        e(0xdb, 0xe3);
        if (flagKernel) {
            e(0xdd, 0x05); imm(DATA + 96); // ST1=0 accumulator, ST0=1
            e(0xdd, 0x05); imm(DATA + 8);
        } else if (kind === 'spread') {
            for (let i = 0; i < 7; i++) { e(0xdd, 0x05); imm(DATA + 96); }
            e(0xdd, 0x05); imm(DATA + 8);
        } else {
            e(0xdd, 0x05); imm(DATA + 8);  // fld m64 one: relaxed even in interpreter setup
            e(0xdd, 0x05); imm(DATA + 96); // zero, outside the result slots
        }
    }
    const setup = count, loop = p;
    if (flagKernel) {
        for (let i = 0; i < 4; i++) {
            if (kind !== 'flags-fp') {
                e(0xb8); imm(0xffffffff);
                e(0x83, 0xc0, 1); // CF=1, consumed after the FP helper
            }
            if (sseKernel) {
                if (kind === 'flags-sse-broadcast') {
                    e(0x0f,0xc6,0xc0,0); // broadcast previous low lane
                    e(0x0f,0x58,0xc1); // add [1,2,3,4]; every shuffle affects future work
                } else if (kind === 'flags-sse-shufps') {
                    e(0x0f,0xc6,0xc0,0x1b); // reverse all four lanes
                    e(0x0f,0xc6,0xc0,0x1b); // reverse back, preserve exact input bits
                } else {
                if (kind === 'flags-sse-reg') e(0x0f,0x16,0xc1); // MOVLHPS
                else { e(0x0f,0x16,0x05); imm(DATA+176); } // MOVHPS m64
                e(0x66,0x0f,0x59,0xc1); // MULPD: low lane alternates; high returns to 1
                }
            } else if (kind !== 'flags-integer') e(0xd9, 0xfa); // FSQRT(1), helper retains CF
            if (kind !== 'flags-fp') e(0x83, 0xd7, 0); // ADC EDI,0
            if (kind !== 'flags-integer' && !sseKernel) e(0xdc, 0xc1); // ST1 += ST0
        }
    } else if (kind === 'matrix') {
        e(0xdb, 0xe3); // fninit; fill all physical registers with tagged nonempty values
        for (let i = 0; i < 8; i++) e(0xd9, 0xe8);
        for (let i = 0; i < top; i++) e(0xd9, 0xf7);
        if (empty & 1) e(0xdd, 0xc0);
        if (empty & 2) e(0xdd, 0xc0 + operand);
        e(0xdb, 0xe2); // fnclex; isolate fault from the operation
        e(0xd8, 0xc0 + operand); // fadd st0,sti (including alias st0,st0)
    } else if (kind === 'spread') {
        for (let i = 1; i < 8; i++) e(0xdc, 0xc0 + i); // seven independent accumulators, ST0=1
    } else {
        for (let i = 0; i < 8; i++) {
            if (kind === 'pair') e(0xd8, 0xc1);
            else { e(0xdc, 0x05); imm(DATA + 8); } // single stack operand, memory control
        }
    }
    e(0x46); e(0x49); // inc esi; dec ecx
    e(0x0f, 0x85); const rel = p; imm(loop - (rel + 4));
    const body = count - setup;
    if (sseKernel) { e(0x66,0x0f,0x11,0x05); imm(DATA+192); }
    e(0xdf, 0xe0); e(0x89, 0xc3); // fnstsw ax; mov ebx,eax
    for (let i = 0; i < (kind === 'spread' ? 8 : flagKernel ? 2 : 1); i++) { e(0xdd, 0x1d); imm(RES + i * 8); }
    const first = RES + (kind === 'spread' || flagKernel ? 8 : 0);
    e(0xa1); imm(first); e(0x8b, 0x15); imm(first + 4);
    e(0xf4);
    return { bytes, kind, setup, body, end: count - setup - body, hash: null };
}
async function boot(im, { jit = true, locals = 0, flagLocals, stats = false } = {}) {
    const em = new V86({ autostart: false, memory_size: 16 << 20, wasm_path: wasm, log_level: 0,
        ...(engineModule ? { wasm_fn: async imports => (await WebAssembly.instantiate(engineModule, imports)).exports } : {}) });
    await new Promise(resolve => em.add_listener('emulator-loaded', resolve));
    const c = em.v86.cpu, w = c.wm.exports;
    c.reboot_internal(); c.reset_memory(); c.load_multiboot(im.bytes.buffer);
    for (const [i, v] of SHIPPING_JIT) {
        if (w.set_jit_config(i, v) !== 0 || (w.get_jit_config(i) >>> 0) !== v) throw Error(`config ${i}`);
    }
    w.set_jit_config(0, jit ? 0 : 1); w.set_jit_config(10, locals);
    if (flagLocals !== undefined && (w.set_jit_config(21, flagLocals) !== 0 || w.get_jit_config(21) !== flagLocals)) throw Error('config 21');
    w.set_relaxed_fpu(1); w.set_fpu_relaxed_stats(stats ? 1 : 0); w.profiler_init();
    globalThis.__jitCompileStats = { count: 0, bytes: 0 };
    globalThis.__wasmDump = { out: [] };
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { em.stop(); reject(Error('warmup timeout')); }, 30000);
        em.bus.register('cpu-event-halt', () => { clearTimeout(timer); em.stop(); resolve(); });
        em.run();
    });
    await new Promise(r => setTimeout(r, 0));
    if (jit && globalThis.__jitCompileStats.count === 0) throw Error('JIT never compiled');
    return { em, c, w };
}
function state(c, w, kind) {
    return { lo: c.reg32[0] >>> 0, hi: c.reg32[2] >>> 0, sw: c.reg32[3] & 0xffff,
        remaining: c.reg32[1] >>> 0, iterations: c.reg32[6] >>> 0,
        hits: w.profiler_fpu_relaxed_hit_get(), fallbacks: w.profiler_fpu_relaxed_fallback_get(),
        ...(kind?.startsWith('flags-') ? { integer: c.reg32[7] >>> 0 } : {}),
        ...(kind?.startsWith('flags-sse-') ? { simd: Array.from({length:4},(_,i)=>c.read32s(DATA+192+i*4)>>>0) } : {}),
        ...(kind === 'spread' ? { lanes: Array.from({length: 7}, (_, i) =>
            [c.read32s(RES + 8 * (i + 1)) >>> 0, c.read32s(RES + 8 * (i + 1) + 4) >>> 0]) } : {}) };
}
function checkResult(r, n, kind) {
    const flagKernel = kind.startsWith('flags-');
    const value = flagKernel ? (kind === 'flags-integer' || kind.startsWith('flags-sse-') ? 0 : n * 4) : kind === 'spread' ? n : n * 8;
    const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, value, true);
    const simdExpected=kind==='flags-sse-broadcast'?Array.from(new Uint32Array(new Float32Array([n*4,n*4+1,n*4+2,n*4+3]).buffer)):[0,0x3ff00000,0,0x3ff00000];
    if (r.lo !== d.getUint32(0, true) || r.hi !== d.getUint32(4, true)
        || r.iterations !== n || r.remaining !== 0 || r.sw !== (kind === 'spread' ? 0 : 0x3000)
        || (flagKernel && r.integer !== (kind === 'flags-fp' ? 0 : n * 4))
        || (kind.startsWith('flags-sse-') && r.simd.some((v,i)=>v !== simdExpected[i]))
        || (kind === 'spread' && !r.lanes.every(([lo, hi]) => lo === d.getUint32(0, true) && hi === d.getUint32(4, true))))
        throw Error(`absolute work/result mismatch ${JSON.stringify(r)}`);
}
function measure(engine, im, n, { warming = false } = {}) {
    const { c, w } = engine;
    c.write32(DATA, n); c.instruction_pointer[0] = BASE + 0x40; c.in_hlt[0] = 0;
    const compiled = globalThis.__jitCompileStats.count;
    const slots = [...new Set(globalThis.__wasmDump.out.map(r => r.table_index))];
    const entriesBefore = slots.map(i => w.jit_get_module_entry_total(i));
    const before = c.instruction_counter[0] >>> 0;
    let calls = 0;
    const start = performance.now();
    while (!c.in_hlt[0]) {
        c.main_loop();
        if (++calls > n + 100) throw Error('main_loop failed to halt');
    }
    const ms = performance.now() - start;
    const retired = ((c.instruction_counter[0] >>> 0) - before) >>> 0;
    const r = state(c, w, im.kind); checkResult(r, n, im.kind);
    const expected = im.setup + im.body * n + im.end;
    if (retired !== expected) throw Error(`retired ${retired}, expected ${expected}`);
    const compiledDuring = globalThis.__jitCompileStats.count - compiled;
    if (!warming && compiledDuring !== 0) throw Error('compilation inside timed window');
    const entries = slots.reduce((sum, slot, i) => sum + ((w.jit_get_module_entry_total(slot) - entriesBefore[i]) >>> 0), 0);
    // Bound activations by loop-safety chunks (cpu::LOOP_COUNTER=100003), allowing
    // the separate setup/FNINIT activation seen in the captured module. Unlike a mere
    // entries>0 check, this rejects a mostly-interpreted run with a few surviving JIT hits.
    const expectedEntries = Math.ceil(n / Math.ceil(100003 / im.body));
    if (!warming && (entries < expectedEntries || entries > expectedEntries + 1)) throw Error(`JIT activations ${entries}, outside loop/setup envelope ${expectedEntries}..${expectedEntries + 1}`);
    return { ms, retired, entries, calls, ...(warming ? {warming,compiledDuring} : {}), ...r };
}
return {image, boot, state, checkResult, measure};
}

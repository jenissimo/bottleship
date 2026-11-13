// Shared by bench.mjs (Node) and any browser page: module generator, arms, state checks and
// the timing loop. `now()` returns milliseconds as a double.

const enc = {
    u32(v) { const out = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); return out; },
    s32(v) { const out = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return out; } out.push(b | 0x80); } },
    str(s) { const b = [...new TextEncoder().encode(s)]; return [...enc.u32(b.length), ...b]; },
    vec(items) { return [...enc.u32(items.length), ...items.flat()]; },
    section(id, body) { return [id, ...enc.u32(body.length), ...body]; },
};
const I32 = 0x7f;
const functype = (params, results) => [0x60, ...enc.vec(params.map(p => [p])), ...enc.vec(results.map(r => [r]))];

function module({ types, imports = [], funcs, table, exports }) {
    const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    bytes.push(...enc.section(1, enc.vec(types)));
    const imp = [[...enc.str('env'), ...enc.str('mem'), 0x02, 0x00, ...enc.u32(1)]];
    if (table === 'import') imp.push([...enc.str('env'), ...enc.str('tab'), 0x01, 0x70, 0x00, ...enc.u32(4)]);
    for (const i of imports) imp.push([...enc.str('env'), ...enc.str(i.name), 0x00, ...enc.u32(i.type)]);
    bytes.push(...enc.section(2, enc.vec(imp)));
    bytes.push(...enc.section(3, enc.vec(funcs.map(f => enc.u32(f.type)))));
    bytes.push(...enc.section(7, enc.vec(exports.map(e => [...enc.str(e.name), 0x00, ...enc.u32(e.index)]))));
    const bodies = funcs.map(f => {
        const locals = f.locals ? enc.vec([[...enc.u32(f.locals), I32]]) : enc.vec([]);
        const body = [...locals, ...f.code, 0x0b];
        return [...enc.u32(body.length), ...body];
    });
    bytes.push(...enc.section(10, enc.vec(bodies)));
    return new Uint8Array(bytes);
}

const op = {
    localGet: i => [0x20, ...enc.u32(i)], localSet: i => [0x21, ...enc.u32(i)],
    i32c: v => [0x41, ...enc.s32(v)], add: [0x6a], sub: [0x6b], eqz: [0x45],
    load: off => [0x28, 0x02, ...enc.u32(off)], store: off => [0x36, 0x02, ...enc.u32(off)],
    call: i => [0x10, ...enc.u32(i)], callIndirect: t => [0x11, ...enc.u32(t), 0x00],
    loop: [0x03, 0x40], block: [0x02, 0x40], end: [0x0b], brIf: d => [0x0d, ...enc.u32(d)], br: d => [0x0c, ...enc.u32(d)],
};
export const REGS = 8, BASE = 64;

function leafMemCode() {
    return [
        ...op.i32c(0), ...op.i32c(0), ...op.load(BASE + 0), ...op.i32c(0), ...op.load(BASE + 4), ...op.add, ...op.store(BASE + 0),
        ...op.i32c(0), ...op.i32c(0), ...op.load(BASE + 8), ...op.i32c(0), ...op.load(BASE + 12), ...op.add, ...op.store(BASE + 8),
        ...op.i32c(0), ...op.i32c(0), ...op.load(BASE + 28), ...op.i32c(1), ...op.add, ...op.store(BASE + 28),
    ];
}
function leafRegCode() {
    const c = [];
    c.push(...op.localGet(0), ...op.localGet(1), ...op.add);
    c.push(...op.localGet(1));
    c.push(...op.localGet(2), ...op.localGet(3), ...op.add);
    for (let i = 3; i < 7; i++) c.push(...op.localGet(i));
    c.push(...op.localGet(7), ...op.i32c(1), ...op.add);
    return c;
}
const T_VOID = 0, T_REG = 1, T_LOOP = 2;
const types = [functype([], []), functype(Array(REGS).fill(I32), Array(REGS).fill(I32)), functype([I32], [])];

function loopMem(callInsn) {
    return [
        ...op.block, ...op.loop,
        ...op.localGet(0), ...op.eqz, ...op.brIf(1),
        ...callInsn,
        ...op.localGet(0), ...op.i32c(1), ...op.sub, ...op.localSet(0),
        ...op.br(0), ...op.end, ...op.end,
    ];
}
function loopReg(callInsn) {
    const c = [];
    for (let r = 0; r < REGS; r++) c.push(...op.i32c(0), ...op.load(BASE + r * 4), ...op.localSet(1 + r));
    c.push(...op.block, ...op.loop, ...op.localGet(0), ...op.eqz, ...op.brIf(1));
    for (let r = 0; r < REGS; r++) c.push(...op.localGet(1 + r));
    c.push(...callInsn);
    for (let r = REGS - 1; r >= 0; r--) c.push(...op.localSet(1 + r));
    c.push(...op.localGet(0), ...op.i32c(1), ...op.sub, ...op.localSet(0), ...op.br(0), ...op.end, ...op.end);
    for (let r = 0; r < REGS; r++) c.push(...op.i32c(0), ...op.localGet(1 + r), ...op.store(BASE + r * 4));
    return c;
}

export const MODULES = {
    'leaves': module({
        types, funcs: [{ type: T_VOID, code: leafMemCode() }, { type: T_REG, code: leafRegCode() }],
        exports: [{ name: 'leafMem', index: 0 }, { name: 'leafReg', index: 1 }],
    }),
    'same-call-mem': module({
        types, funcs: [{ type: T_VOID, code: leafMemCode() }, { type: T_LOOP, code: loopMem(op.call(0)) }],
        exports: [{ name: 'run', index: 1 }],
    }),
    'same-call-reg': module({
        types, funcs: [{ type: T_REG, code: leafRegCode() }, { type: T_LOOP, locals: REGS, code: loopReg(op.call(0)) }],
        exports: [{ name: 'run', index: 1 }],
    }),
    'other-indirect-mem': module({
        types, table: 'import',
        funcs: [{ type: T_LOOP, code: loopMem([...op.i32c(0), ...op.callIndirect(T_VOID)]) }],
        exports: [{ name: 'run', index: 0 }],
    }),
    'other-indirect-reg': module({
        types, table: 'import',
        funcs: [{ type: T_LOOP, locals: REGS, code: loopReg([...op.i32c(1), ...op.callIndirect(T_REG)]) }],
        exports: [{ name: 'run', index: 0 }],
    }),
    'other-import-mem': module({
        types, imports: [{ name: 'leafMem', type: T_VOID }],
        funcs: [{ type: T_LOOP, code: loopMem(op.call(0)) }],
        exports: [{ name: 'run', index: 1 }],
    }),
    'other-import-reg': module({
        types, imports: [{ name: 'leafReg', type: T_REG }],
        funcs: [{ type: T_LOOP, locals: REGS, code: loopReg(op.call(0)) }],
        exports: [{ name: 'run', index: 1 }],
    }),
};
export const ARMS = [
    ['same module, call, regs in memory', 'same-call-mem'],
    ['same module, call, regs as params/results', 'same-call-reg'],
    ['other module, call_indirect, regs in memory', 'other-indirect-mem'],
    ['other module, call_indirect, regs as params/results', 'other-indirect-reg'],
    ['other module, imported function, regs in memory', 'other-import-mem'],
    ['other module, imported function, regs as params/results', 'other-import-reg'],
    ['A/A: same module, call, regs in memory (second instance)', 'same-call-mem'],
];


export async function instantiateArms(modules = MODULES) {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new WebAssembly.Table({ initial: 4, element: 'anyfunc' });
    const inst = async (bytes, extra = {}) => (await WebAssembly.instantiate(bytes, { env: { mem: memory, tab: table, ...extra } })).instance.exports;
    const leaves = await inst(modules.leaves);
    table.set(0, leaves.leafMem);
    table.set(1, leaves.leafReg);
    const arms = [];
    for (const [label, key] of ARMS) arms.push({ label, key, run: (await inst(modules[key], { leafMem: leaves.leafMem, leafReg: leaves.leafReg })).run });
    return { arms, view: new Int32Array(memory.buffer, BASE, REGS) };
}

export const expectedState = n => {
    const r = Array.from({ length: REGS }, (_, i) => i * 3 + 1);
    r[0] = (r[0] + n * r[1]) | 0;
    r[2] = (r[2] + n * r[3]) | 0;
    r[7] = (r[7] + n) | 0;
    return r;
};

export function makeRunner(view, now) {
    const reset = () => { for (let i = 0; i < REGS; i++) view[i] = i * 3 + 1; };
    const stateOk = n => expectedState(n).every((v, i) => v === view[i]);
    const runChecked = (arm, n) => {
        reset();
        arm.run(n);
        return { state: Array.from(view), ok: stateOk(n) };
    };
    const timeRun = (arm, n) => {
        reset();
        const t0 = now();
        arm.run(n);
        const ms = now() - t0;
        if (!stateOk(n)) throw new Error(`${arm.label}: state after ${n} calls does not match (calls ${view[7] - 22}, r0 ${view[0]}, r2 ${view[2]})`);
        return ms;
    };
    return { reset, stateOk, runChecked, timeRun };
}

export function bench(arms, runner, { rounds = 8, ns = [1000000, 2000000], warmup = 5 } = {}) {
    for (const arm of arms) for (let w = 0; w < warmup; w++) runner.timeRun(arm, 20000);
    const raw = [];
    for (let r = 0; r < rounds; r++) {
        const order = r % 2 === 0 ? arms : arms.slice().reverse();
        for (const arm of order) {
            for (const n of ns) {
                const t1 = runner.timeRun(arm, n), t2 = runner.timeRun(arm, 2 * n);
                raw.push({ round: r, arm: arm.label, n, msN: t1, ms2N: t2, nsPerCall: ((t2 - t1) * 1e6) / n });
            }
        }
    }
    return raw;
}

const quantile = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

export function summarize(arms, raw, ns) {
    const out = [];
    for (const arm of arms) for (const n of ns) {
        const xs = raw.filter(x => x.arm === arm.label && x.n === n).map(x => x.nsPerCall);
        out.push({ arm: arm.label, n, median: quantile(xs, 0.5), min: Math.min(...xs), q25: quantile(xs, 0.25), q75: quantile(xs, 0.75), max: Math.max(...xs), negative: xs.filter(x => x < 0).length });
    }
    return out;
}

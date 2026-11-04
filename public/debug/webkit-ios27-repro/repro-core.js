// Environment-agnostic core of the repro (browser worker and Node self-test share it).
//
// It reproduces the SHAPE of what BottleShip's v86 JIT does, with no emulator inside:
//   - a "core" module that DEFINES the linear memory (not shared, grown by memory.grow from
//     inside wasm, like Rust's allocator does) and IMPORTS the funcref table;
//   - "JIT" modules generated at run time. Each imports the core's memory ("e.m"), the
//     table and a core function ("lookup"); its only export "f" has type (i32)->();
//   - the core's run(idx, state) enters a JIT module with call_indirect (v86 cpu.rs
//     call_indirect1), and every JIT module ends by asking the core for the next target and
//     TAIL-CALLING it with return_call_indirect through the shared table (v86 jit.rs
//     RET/AbsoluteEip dynamic chaining, the shipping default). So the hot edge is a
//     CROSS-INSTANCE return_call_indirect between freshly compiled modules;
//   - modules are compiled ASYNC with WebAssembly.instantiate over a Uint8Array VIEW of the
//     core memory (v86 cpu.js codegen_finalize), table slots are recycled (table.set(null),
//     later table.set(newF)), and memory grows while all of that is in flight;
//   - the driver is a same-thread MessageChannel loop (v86 main.js yield), so each tick is a
//     MessagePort event — the frame the WebKit crash report shows.
//
// Knobs (all from the page query string): see DEFAULTS.

export const DEFAULTS = {
    tail: 1,            // 1 = return_call_indirect, 0 = call_indirect + return (control arm)
    budget: 20000,      // chained module entries per tick (tail=0 clamps to 1500: real recursion)
    initialMB: 1600,    // grow the core memory to this at start (v86: 1.5 GB guest RAM + statics)
    growEvery: 25,      // ticks between memory.grow calls; 0 = never grow after start
    growPages: 16,      // pages per grow (16 = 1 MiB)
    growInChain: 1,     // 1 = the grow runs inside lookup(), i.e. with JIT frames on the stack
    maxMB: 2400,        // stop growing past this
    slots: 200,         // live JIT modules before slots are recycled (v86: 899)
    recycle: 1,         // 0 = never reuse a slot (stop compiling when full)
    clearEvery: 0,      // ticks between "clear the whole cache" events (v86 jit_clear_cache)
    sync: 0,            // 1 = new WebAssembly.Module/Instance instead of async instantiate
    copyBytes: 0,       // 1 = hand instantiate a copy instead of a view of wasm memory
    maxLocals: 96,      // JIT module i32 local count is 1..maxLocals (varies frame size)
    seconds: 0,         // stop after N seconds (0 = run until killed)
};

export const TABLE_OFFSET = 1024;
const TABLE_SIZE = TABLE_OFFSET + 900;
const ADDR_BUDGET = 16, ADDR_COUNT = 24, ADDR_GROW_FLAG = 28, ADDR_GROW_PAGES = 32;
const ADDR_TARGETS = 1024;          // i32[slots]
const ADDR_SCRATCH = 0x100000;      // module bytes are written here, then instantiated from a view
const PAGE = 65536;

// ── tiny wasm encoder ─────────────────────────────────────────────────────────────────
const u32 = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const s32 = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const str = (s) => { const b = [...new TextEncoder().encode(s)]; return [...u32(b.length), ...b]; };
const vec = (items) => [...u32(items.length), ...items.flat()];
const section = (id, body) => [id, ...u32(body.length), ...body];
const I32 = 0x7f, I64 = 0x7e, FUNCREF = 0x70;
const functype = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const op = {
    get: (i) => [0x20, ...u32(i)], set: (i) => [0x21, ...u32(i)], tee: (i) => [0x22, ...u32(i)],
    i32: (v) => [0x41, ...s32(v)], load: [0x28, 0x02, 0x00], store: [0x36, 0x02, 0x00],
    add: [0x6a], sub: [0x6b], mul: [0x6c], remu: [0x70], and: [0x71], shru: [0x76], eqz: [0x45], ges: [0x4e],
    ifv: [0x04, 0x40], end: [0x0b], ret: [0x0f], drop: [0x1a], grow: [0x40, 0x00],
    call: (f) => [0x10, ...u32(f)], callInd: (t) => [0x11, ...u32(t), 0x00], retCallInd: (t) => [0x13, ...u32(t), 0x00],
    i64extu: [0xad], i64add: [0x7c],
};
const body = (locals, code) => { const b = [...vec(locals.map(([n, t]) => [...u32(n), t])), ...code.flat(), 0x0b]; return [...u32(b.length), ...b]; };

function buildCore(initialPages) {
    const types = vec([functype([I32], []), functype([I32, I32], []), functype([I32], [I32]), functype([], [I32])]);
    const imports = vec([[...str("env"), ...str("__indirect_function_table"), 0x01, FUNCREF, 0x00, ...u32(TABLE_SIZE)]]);
    const funcs = vec([[1], [2], [3]]);
    const memory = vec([[0x00, ...u32(initialPages)]]);
    const exports = vec([
        [...str("memory"), 0x02, 0], [...str("run"), 0x00, 0], [...str("grow"), 0x00, 1], [...str("lookup"), 0x00, 2]]);
    const run = body([], [op.get(1), op.get(0), op.callInd(0)]);
    const grow = body([], [op.get(0), op.grow]);
    // lookup(): optional in-chain grow, then budget-- and the next packed target or -1.
    const lookup = body([[3, I32]], [
        op.i32(ADDR_GROW_FLAG), op.load, op.ifv,
            op.i32(ADDR_GROW_FLAG), op.i32(0), op.store,
            op.i32(ADDR_GROW_PAGES), op.load, op.grow, op.drop,
        op.end,
        op.i32(ADDR_BUDGET), op.load, op.tee(0), op.eqz, op.ifv, op.i32(-1), op.ret, op.end,
        op.i32(ADDR_BUDGET), op.get(0), op.i32(1), op.sub, op.store,
        op.i32(ADDR_COUNT), op.load, op.tee(1), op.eqz, op.ifv, op.i32(-1), op.ret, op.end,
        op.get(0), op.get(1), op.remu, op.i32(4), op.mul, op.i32(ADDR_TARGETS), op.add, op.load, op.tee(2),
        op.eqz, op.ifv, op.i32(-1), op.ret, op.end,
        op.get(2),
    ]);
    return new Uint8Array([...HEADER, ...section(1, types), ...section(2, imports), ...section(3, funcs),
        ...section(5, memory), ...section(7, exports), ...section(10, vec([run, grow, lookup]))]);
}

function buildJitModule(k, nLocals, tail) {
    const types = vec([functype([I32], []), functype([], [I32])]);
    const imports = vec([
        [...str("e"), ...str("m"), 0x02, 0x00, ...u32(1)],
        [...str("e"), ...str("__indirect_function_table"), 0x01, FUNCREF, 0x00, ...u32(1)],
        [...str("e"), ...str("lookup"), 0x00, ...u32(1)],
    ]);
    const funcs = vec([[0]]);
    const exports = vec([[...str("f"), 0x00, 1]]);
    // locals: 0 = param, 1 = packed target, 2..nLocals+1 = work, then two i64.
    const base = 4096 + (k % 256) * 1024;
    const code = [];
    for (let j = 0; j < nLocals; j++) {
        code.push(op.i32(base + j * 4), op.get(0), op.i32(j), op.add, op.store);
        code.push(op.i32(base + j * 4), op.load, op.set(2 + j));
    }
    code.push(op.get(2), op.i64extu, op.get(nLocals + 2), op.i64add, op.set(nLocals + 2));
    code.push(op.call(0), op.tee(1), op.i32(0), op.ges, op.ifv,
        op.get(1), op.i32(0xffff), op.and, op.get(1), op.i32(16), op.shru,
        tail ? op.retCallInd(0) : [...op.callInd(0), ...op.ret],
        op.end);
    const f = body([[nLocals + 1, I32], [2, I64]], code);
    return new Uint8Array([...HEADER, ...section(1, types), ...section(2, imports), ...section(3, funcs),
        ...section(7, exports), ...section(10, vec([f]))]);
}

export async function createRepro(opts, report) {
    const o = { ...DEFAULTS, ...opts };
    if (!o.tail) o.budget = Math.min(o.budget, 1500);
    const table = new WebAssembly.Table({ element: "anyfunc", initial: TABLE_SIZE });
    const core = (await WebAssembly.instantiate(buildCore(64), { env: { __indirect_function_table: table } })).instance.exports;
    const memory = core.memory;
    const mb = () => memory.buffer.byteLength / 1048576;
    const want = Math.ceil(o.initialMB * 1048576 / PAGE) - memory.buffer.byteLength / PAGE;
    if (want > 0 && core.grow(want) < 0) report({ kind: "warn", text: `initial grow to ${o.initialMB} MB refused` });
    const imports = { e: { m: memory, __indirect_function_table: table, lookup: core.lookup } };

    const st = { ticks: 0, chains: 0, compiled: 0, failed: 0, recycled: 0, clears: 0, grows: 0, k: 0, compiling: false, stopped: false, error: null };
    const free = Array.from({ length: o.slots }, (_, i) => o.slots - i);   // slots 1..slots
    const live = [];                                                         // [{slot, state}]
    const dv = () => new DataView(memory.buffer);                            // re-derived: grow detaches
    const publish = () => {
        const v = dv();
        for (let i = 0; i < o.slots; i++) v.setInt32(ADDR_TARGETS + i * 4, 0, true);
        live.forEach((e, i) => v.setInt32(ADDR_TARGETS + i * 4, ((e.slot + TABLE_OFFSET) << 16) | e.state, true));
        v.setInt32(ADDR_COUNT, live.length, true);
    };
    const release = (e) => { table.set(e.slot + TABLE_OFFSET, null); free.push(e.slot); };

    const compileOne = () => {
        if (st.compiling) return;
        if (!free.length) {
            if (!o.recycle || !live.length) return;
            release(live.shift()); st.recycled++; publish();
        }
        const slot = free.pop();
        const k = st.k++;
        const bytes = buildJitModule(k, 1 + (k * 7919) % o.maxLocals, !!o.tail);
        new Uint8Array(memory.buffer, ADDR_SCRATCH, bytes.length).set(bytes);
        const view = new Uint8Array(memory.buffer, ADDR_SCRATCH, bytes.length);
        const install = (instance) => {
            table.set(slot + TABLE_OFFSET, instance.exports.f);
            live.push({ slot, state: k & 0xff });
            publish();
            st.compiled++;
        };
        if (o.sync) { install(new WebAssembly.Instance(new WebAssembly.Module(view), imports)); return; }
        st.compiling = true;
        WebAssembly.instantiate(o.copyBytes ? view.slice() : view, imports)
            .then((r) => install(r.instance))
            .catch((e) => { st.failed++; free.push(slot); report({ kind: "warn", text: "compile failed: " + e }); })
            .finally(() => { st.compiling = false; });
    };

    const tick = () => {
        st.ticks++;
        if (o.clearEvery && st.ticks % o.clearEvery === 0) { live.splice(0).forEach(release); publish(); st.clears++; }
        compileOne();
        if (o.growEvery && st.ticks % o.growEvery === 0 && mb() + o.growPages / 16 <= o.maxMB) {
            if (o.growInChain) { const v = dv(); v.setInt32(ADDR_GROW_PAGES, o.growPages, true); v.setInt32(ADDR_GROW_FLAG, 1, true); }
            else core.grow(o.growPages);
            st.grows++;
        }
        if (!live.length) return;
        const e = live[st.ticks % live.length];
        dv().setInt32(ADDR_BUDGET, o.budget, true);
        core.run(e.slot + TABLE_OFFSET, e.state);
        st.chains += o.budget - dv().getInt32(ADDR_BUDGET, true);
    };

    return { st, opts: o, tick, memoryMB: mb, liveCount: () => live.length };
}

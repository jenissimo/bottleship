// module-stats' CPU-state classifier reads the ADDRESS OPERAND, not the memarg offset: v86 emits
// state traffic as `i32.const <addr>` + load/store offset=0 (wasm_builder load_fixed_*), which an
// offset-only classifier counts as guest RAM. The bodies here are hand-assembled so each expected
// bucket is known by construction; the corrupted-table cases prove the stack self-checks fire.
import test from "node:test";
import assert from "node:assert/strict";
import { moduleStats, OPS } from "./module-stats.mjs";

const uleb = (v) => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const sleb = (v) => {
    const o = [];
    for (;;) {
        const b = v & 0x7f; v >>= 7;
        if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; }
        o.push(b | 0x80);
    }
};
const sec = (id, b) => [id, ...uleb(b.length), ...b];
const str = (s) => [...uleb(s.length), ...Buffer.from(s)];
/** One function (i32, i32) -> () with one extra i32 local, importing memory e.m. */
const moduleOf = (body) => {
    const code = [1, 1, 0x7f, ...body, 0x0b];            // 1 local group: 1 x i32
    return Uint8Array.from([
        0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
        ...sec(1, [1, 0x60, 2, 0x7f, 0x7f, 0]),
        ...sec(2, [1, ...str("e"), ...str("m"), 2, 0, 1]),
        ...sec(3, [1, 0]),
        ...sec(10, [1, ...uleb(code.length), ...code]),
    ]);
};
const c = (v) => [0x41, ...sleb(v)];
const get = (i) => [0x20, i], set = (i) => [0x21, i];
const load = (off = 0) => [0x28, 2, ...uleb(off)], store = (off = 0) => [0x36, 2, ...uleb(off)];
const DROP = [0x1a];

const BODY = [
    // flags |= 1, the JIT's shape: address const below the loaded value -> 2 x cpuState
    ...c(120), ...c(120), ...load(), ...c(1), 0x72, ...store(),
    // memarg-offset form over a zero base -> cpuState (the ONLY case the old classifier saw)
    ...c(0), ...load(556), ...DROP,
    // computed address from a parameter -> guest
    ...get(0), ...load(), ...DROP,
    // store whose VALUE is a state address but whose ADDRESS is unknown -> guest
    ...get(1), ...c(120), ...store(),
    // relaxed-FPU shape: fpu_st + (i & 7) * 16 held in a local, then i64.load -> cpuState
    ...c(3), ...c(7), 0x71, ...c(16), 0x6c, ...c(1152), 0x6a, ...set(2), ...get(2), 0x29, 3, 0, ...DROP,
    // constant outside the state block -> constOther
    ...c(2000), ...load(), ...DROP,
    // v128.load of reg_xmm -> cpuState, also counted in the v128 split
    ...c(832), 0xfd, 0x00, 4, 0, ...DROP,
    // if/else join: local 2 is 64 or 68 -> [64, 68] -> cpuState
    ...get(0), 0x04, 0x40, ...c(64), ...set(2), 0x05, ...c(68), ...set(2), 0x0b, ...get(2), ...load(), ...DROP,
    // loop head forgets locals the loop assigns: local 2 is 120 on entry but not on the back edge
    ...c(120), ...set(2), 0x03, 0x40, ...get(2), ...load(), ...DROP, ...get(1), ...set(2), 0x0b,
];

test("CPU-state accesses are classified by the address operand, through locals and joins", () => {
    const s = moduleStats(moduleOf(BODY), "hand");
    assert.deepEqual(
        { cpuState: s.memSplit.cpuState, guest: s.memSplit.guest, constOther: s.memSplit.constOther,
            table: s.memSplit.table, boundedOther: s.memSplit.boundedOther },
        { cpuState: 6, guest: 3, constOther: 1, table: 0, boundedOther: 0 });
    assert.equal(s.memSplit.v128.cpuState, 1);
    assert.deepEqual(s.cpuStateByAddr["120 flags"], { load: 1, store: 1 });
    assert.deepEqual(s.cpuStateByAddr["64 reg32"], { load: 1, store: 0 });
});

test("a mis-modelled stack effect is a hard error, not a skewed count", () => {
    const bytes = moduleOf(BODY);
    const withAdd = (pop) => new Map([...OPS].map(([k, v]) => [k, k === 0x6a ? ["i32.add", "alu", pop, 1] : v]));
    assert.throws(() => moduleStats(bytes, "pop1", { ops: withAdd(1) }), /expected its result arity/);
    assert.throws(() => moduleStats(bytes, "pop3", { ops: withAdd(3) }), /operand stack underflow/);
});

test("a block whose depth does not match its result arity is rejected", () => {
    // block (result i32) with nothing on the stack at its end
    assert.throws(() => moduleStats(moduleOf([0x02, 0x7f, 0x0b, ...DROP]), "arity"), /expected its result arity 1/);
});

// Minimal WebAssembly binary encoder (MVP + multi-value + tail calls + sign-ext), written for
// func-ceiling. No dependencies.
export const I32 = 0x7f, I64 = 0x7e, F64 = 0x7c, FUNCREF = 0x70;

export const OP = {
    unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d,
    br_table: 0x0e, return: 0x0f, call: 0x10, call_indirect: 0x11, return_call: 0x12, return_call_indirect: 0x13,
    drop: 0x1a, select: 0x1b, local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
    i32_load: 0x28, i64_load: 0x29, f64_load: 0x2b, i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
    i32_store: 0x36, i64_store: 0x37, f64_store: 0x39, i32_store8: 0x3a, i32_store16: 0x3b,
    i32_const: 0x41, i64_const: 0x42, f64_const: 0x44,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49, i32_gt_s: 0x4a, i32_gt_u: 0x4b,
    i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
    i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52,
    i32_clz: 0x67, i32_ctz: 0x68, i32_popcnt: 0x69, i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e,
    i32_rem_s: 0x6f, i32_rem_u: 0x70, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i32_rotl: 0x77, i32_rotr: 0x78,
    i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80, i64_rem_s: 0x81, i64_rem_u: 0x82,
    i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
    i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad,
    i32_extend8_s: 0xc0, i32_extend16_s: 0xc1,
    f32_load: 0x2a, f32_store: 0x38, f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
    f64_abs: 0x99, f64_neg: 0x9a, f64_trunc: 0x9d, f64_nearest: 0x9e, f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
    f32_demote_f64: 0xb6, f64_convert_i32_s: 0xb7, f64_convert_i64_s: 0xb9, f64_promote_f32: 0xbb,
};

export class Bytes {
    constructor() { this.a = []; }
    u8(x) { this.a.push(x & 255); return this; }
    u32(x) { x >>>= 0; do { let b = x & 127; x >>>= 7; if (x) b |= 128; this.a.push(b); } while (x); return this; }
    s32(x) {
        x |= 0;
        for (;;) { const b = x & 127; x >>= 7; if ((x === 0 && !(b & 64)) || (x === -1 && (b & 64))) { this.a.push(b); return this; } this.a.push(b | 128); }
    }
    s64(x) {
        x = BigInt.asIntN(64, BigInt(x));
        for (;;) { const b = Number(x & 127n); x >>= 7n; if ((x === 0n && !(b & 64)) || (x === -1n && (b & 64))) { this.a.push(b); return this; } this.a.push(b | 128); }
    }
    bytes(arr) { for (const b of arr) this.a.push(b); return this; }
    str(s) { const e = new TextEncoder().encode(s); this.u32(e.length); return this.bytes(e); }
    get length() { return this.a.length; }
}

/** Function body builder. Every helper returns `this` so emission reads like a listing. */
export class Code extends Bytes {
    /** Branch hint for the NEXT if/br_if (1 = condition expected true, 0 = expected false). */
    hint(v) { (this.hints ||= []).push([this.a.length, v]); return this; }
    op(o) { return this.u8(o); }
    i32(v) { return this.u8(OP.i32_const).s32(v | 0); }
    i64(v) { return this.u8(OP.i64_const).s64(v); }
    f64(v) { const b = new Uint8Array(new Float64Array([v]).buffer); return this.u8(OP.f64_const).bytes(b); }
    /** 0xFC-prefixed op (saturating truncations: 2 = i32.trunc_sat_f64_s, 6 = i64.trunc_sat_f64_s). */
    fc(sub) { return this.u8(0xfc).u32(sub); }
    get(l) { return this.u8(OP.local_get).u32(l); }
    set(l) { return this.u8(OP.local_set).u32(l); }
    tee(l) { return this.u8(OP.local_tee).u32(l); }
    gget(g) { return this.u8(OP.global_get).u32(g); }
    gset(g) { return this.u8(OP.global_set).u32(g); }
    block(bt = 0x40) { return this.u8(OP.block).u8(bt); }
    loop(bt = 0x40) { return this.u8(OP.loop).u8(bt); }
    if_(bt = 0x40) { return this.u8(OP.if).u8(bt); }
    else_() { return this.u8(OP.else); }
    end() { return this.u8(OP.end); }
    br(d) { return this.u8(OP.br).u32(d); }
    br_if(d) { return this.u8(OP.br_if).u32(d); }
    br_table(labels, def) { this.u8(OP.br_table).u32(labels.length); for (const l of labels) this.u32(l); return this.u32(def); }
    call(f) { return this.u8(OP.call).u32(f); }
    return_call(f) { return this.u8(OP.return_call).u32(f); }
    call_indirect(t, tab = 0) { return this.u8(OP.call_indirect).u32(t).u32(tab); }
    return_call_indirect(t, tab = 0) { return this.u8(OP.return_call_indirect).u32(t).u32(tab); }
    mem(o, align, offset) { return this.u8(o).u32(align).u32(offset >>> 0); }
}

const ENC = (fn) => { const b = new Bytes(); fn(b); return b; };

export class Module {
    constructor() {
        this.types = []; this.typeKey = new Map();
        this.imports = []; this.funcs = []; this.globals = []; this.exports = [];
        this.elems = []; this.datas = []; this.memory = null; this.table = null;
        this.names = [];
    }
    type(params, results) {
        const k = params.join(",") + ">" + results.join(",");
        if (!this.typeKey.has(k)) { this.typeKey.set(k, this.types.length); this.types.push([params, results]); }
        return this.typeKey.get(k);
    }
    importFunc(mod, name, params, results) {
        if (this.funcs.length) throw Error("imports must precede functions");
        this.imports.push({ mod, name, type: this.type(params, results) });
        return this.imports.length - 1;
    }
    /** Reserve a function index now, fill the body later. */
    declareFunc(params, results, name = "") {
        const idx = this.imports.length + this.funcs.length;
        this.funcs.push({ type: this.type(params, results), nparams: params.length, locals: [], body: null, name });
        return idx;
    }
    defineFunc(idx, locals, code) { const f = this.funcs[idx - this.imports.length]; f.locals = locals; f.body = code; }
    global(type, mutable, init) { this.globals.push({ type, mutable, init }); return this.globals.length - 1; }
    export(name, kind, idx) { this.exports.push({ name, kind, idx }); }
    encode() {
        const out = new Bytes().bytes([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
        const sec = (id, b) => { if (!b) return; out.u8(id).u32(b.length).bytes(b.a); };
        sec(1, ENC((b) => { b.u32(this.types.length); for (const [p, r] of this.types) { b.u8(0x60).u32(p.length).bytes(p).u32(r.length).bytes(r); } }));
        if (this.imports.length) sec(2, ENC((b) => { b.u32(this.imports.length); for (const i of this.imports) { b.str(i.mod).str(i.name).u8(0).u32(i.type); } }));
        sec(3, ENC((b) => { b.u32(this.funcs.length); for (const f of this.funcs) b.u32(f.type); }));
        if (this.table) sec(4, ENC((b) => { b.u32(1).u8(FUNCREF).u8(1).u32(this.table.min).u32(this.table.max); }));
        if (this.memory) sec(5, ENC((b) => { b.u32(1).u8(1).u32(this.memory.min).u32(this.memory.max); }));
        if (this.globals.length) sec(6, ENC((b) => {
            b.u32(this.globals.length);
            for (const g of this.globals) {
                b.u8(g.type).u8(g.mutable ? 1 : 0);
                if (g.type === I64) b.u8(OP.i64_const).s64(g.init);
                else if (g.type === F64) b.u8(OP.f64_const).bytes(new Uint8Array(new Float64Array([g.init]).buffer));
                else b.u8(OP.i32_const).s32(g.init);
                b.u8(OP.end);
            }
        }));
        if (this.exports.length) sec(7, ENC((b) => { b.u32(this.exports.length); for (const e of this.exports) b.str(e.name).u8(e.kind).u32(e.idx); }));
        if (this.elems.length) sec(9, ENC((b) => {
            b.u32(this.elems.length);
            for (const e of this.elems) { b.u32(0).u8(OP.i32_const).s32(e.offset).u8(OP.end).u32(e.funcs.length); for (const f of e.funcs) b.u32(f); }
        }));
        const hinted = [];
        const code = ENC((b) => {
            b.u32(this.funcs.length);
            this.funcs.forEach((f, i) => {
                const body = new Bytes();
                // run-length encode locals
                const runs = [];
                for (const t of f.locals) { if (runs.length && runs[runs.length - 1][1] === t) runs[runs.length - 1][0]++; else runs.push([1, t]); }
                body.u32(runs.length); for (const [n, t] of runs) body.u32(n).u8(t);
                const declSize = body.length;
                if (this.branchHints && f.body.hints && f.body.hints.length) hinted.push([this.imports.length + i, f.body.hints.map(([o, v]) => [o + declSize, v])]);
                body.bytes(f.body.a); body.u8(OP.end);
                b.u32(body.length).bytes(body.a);
            });
        });
        this.codeSectionBytes = code.length;
        // "metadata.code.branch_hint" (must precede the code section); offsets from the locals declaration
        if (hinted.length) {
            const p = new Bytes();
            p.str("metadata.code.branch_hint");
            p.u32(hinted.length);
            for (const [fi, hs] of hinted) { p.u32(fi).u32(hs.length); for (const [o, v] of hs) p.u32(o).u32(1).u8(v); }
            out.u8(0).u32(p.length).bytes(p.a);
            this.hintBytes = p.length;
        }
        sec(10, code);
        if (this.datas.length) sec(11, ENC((b) => { b.u32(this.datas.length); for (const d of this.datas) { b.u32(0).u8(OP.i32_const).s32(d.offset).u8(OP.end).u32(d.bytes.length).bytes(d.bytes); } }));
        return new Uint8Array(out.a);
    }
}

// A minimal wasm encoder shaped to the AOT module contract (plan/aot-module-contract.md §1-§2).
//
// It is deliberately NOT a general wasm library: it emits exactly the module shape the
// contract's A-checklist describes — N function imports from "e" in first-use order, then the
// memory import `e.m` (min 64 pages, non-shared, no maximum), one local function typed
// (i32)->() exported as "f" — and nothing else. Anything it cannot express is a shape the
// verifier would reject anyway.
//
// Two things here exist only because an OFFLINE producer needs them and the live JIT does not:
//   - RELOCATIONS (design §S3): a constant whose value is a property of the live engine
//     instance is emitted as a fixed-width padded LEB the loader overwrites in place. This
//     slice needs exactly one kind, `tlb_data` — see lib/tlb-base.mjs for why.
//   - a body-offset log per emitted instruction, so the verifier can talk about "the store at
//     0x1c2" instead of re-deriving structure from bytes.

export const OP = {
    UNREACHABLE: 0x00, NOP: 0x01, BLOCK: 0x02, LOOP: 0x03, IF: 0x04, ELSE: 0x05, END: 0x0b,
    BR: 0x0c, BR_IF: 0x0d, BR_TABLE: 0x0e, RETURN: 0x0f, CALL: 0x10,
    DROP: 0x1a, SELECT: 0x1b,
    LOCAL_GET: 0x20, LOCAL_SET: 0x21, LOCAL_TEE: 0x22,
    I32LOAD: 0x28, I32LOAD8U: 0x2d, I32LOAD16U: 0x2f,
    I32STORE: 0x36, I64STORE: 0x37, I32STORE8: 0x3a, I32STORE16: 0x3b,
    I32CONST: 0x41, I64CONST: 0x42,
    I32EQZ: 0x45, I32EQ: 0x46, I32NE: 0x47, I32LTS: 0x48, I32LTU: 0x49, I32GTS: 0x4a,
    I32GTU: 0x4b, I32LES: 0x4c, I32LEU: 0x4d, I32GES: 0x4e, I32GEU: 0x4f,
    I32ADD: 0x6a, I32SUB: 0x6b, I32MUL: 0x6c,
    I32AND: 0x71, I32OR: 0x72, I32XOR: 0x73, I32SHL: 0x74, I32SHRS: 0x75, I32SHRU: 0x76,
    I32EXTEND8S: 0xc0, I32EXTEND16S: 0xc1,
};
export const TYPE = { I32: 0x7f, I64: 0x7e, VOID_BLOCK: 0x40, FUNC: 0x60, ANYFUNC: 0x70 };
export const ALIGN = { B1: 0, B2: 1, B4: 2, B8: 3 };

export function lebU(out, v) {
    v >>>= 0;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
}
export function lebS(out, v) {
    v |= 0;
    for (;;) {
        const b = v & 0x7f;
        v >>= 7;
        if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return; }
        out.push(b | 0x80);
    }
}
/** Non-canonical 5-byte unsigned LEB — the payload a relocation overwrites in place. */
export function lebU5(out, v) {
    v >>>= 0;
    for (let i = 0; i < 5; i++) { out.push((v & 0x7f) | (i < 4 ? 0x80 : 0)); v >>>= 7; }
}
export function patchLebU5(bytes, at, v) {
    v >>>= 0;
    for (let i = 0; i < 5; i++) { bytes[at + i] = (v & 0x7f) | (i < 4 ? 0x80 : 0); v >>>= 7; }
}

/** Wasm function types this producer can emit, in the order they are written. */
const FT = [
    { key: "v_v", params: [], results: [] },
    { key: "i_v", params: [TYPE.I32], results: [] },
    { key: "v_i", params: [], results: [TYPE.I32] },
    { key: "ii_i", params: [TYPE.I32, TYPE.I32], results: [TYPE.I32] },
    { key: "iii_i", params: [TYPE.I32, TYPE.I32, TYPE.I32], results: [TYPE.I32] },
];
const FT_INDEX = Object.fromEntries(FT.map((t, i) => [t.key, i]));

export class ModuleBuilder {
    constructor() {
        this.body = [];
        this.imports = [];          // {name, typeKey}
        this.importIndex = new Map();
        this.localTypes = [];       // types of locals beyond the single i32 argument
        this.freeI32 = [];
        this.labelStack = [];       // innermost last
        this.relocs = [];           // {kind, at, width, note}
        this.marks = [];            // {offset, tag} — provenance for the verifier
    }

    // ── imports ─────────────────────────────────────────────────────────────
    importFn(name, typeKey) {
        let i = this.importIndex.get(name);
        if (i === undefined) {
            i = this.imports.length;
            this.imports.push({ name, typeKey });
            this.importIndex.set(name, i);
        }
        else if (this.imports[i].typeKey !== typeKey) {
            throw new Error(`import ${name} used with two types`);
        }
        return i;
    }

    // ── locals ──────────────────────────────────────────────────────────────
    allocLocal() {
        if (this.freeI32.length) return this.freeI32.pop();
        // local 0 is the module argument (the dispatcher target), contract N4.
        const idx = 1 + this.localTypes.length;
        this.localTypes.push(TYPE.I32);
        // wasm_builder.rs:717 pushes local indices as a single raw byte; keep the same ceiling
        // so a body produced here stays byte-compatible with the engine's own decoder habits.
        if (idx > 127) throw new Error("local index > 127 (design §S4 hard budget)");
        return idx;
    }
    freeLocal(i) { if (i !== 0) this.freeI32.push(i); }

    // ── raw emit ────────────────────────────────────────────────────────────
    u8(b) { this.body.push(b & 0xff); return this; }
    mark(tag) { this.marks.push({ offset: this.body.length, tag }); return this; }
    get here() { return this.body.length; }

    constI32(v) { this.u8(OP.I32CONST); lebS(this.body, v | 0); return this; }
    constI64(lo, hi) {
        // Only used for the packed (last_op_size, flags_changed) store; both halves are small.
        this.u8(OP.I64CONST);
        let v = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
        if (v >= 1n << 63n) v -= 1n << 64n;
        for (;;) {
            const b = Number(v & 0x7fn);
            v >>= 7n;
            if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { this.u8(b); return this; }
            this.u8(b | 0x80);
        }
    }
    getLocal(i) { this.u8(OP.LOCAL_GET); lebU(this.body, i); return this; }
    setLocal(i) { this.u8(OP.LOCAL_SET); lebU(this.body, i); return this; }
    teeLocal(i) { this.u8(OP.LOCAL_TEE); lebU(this.body, i); return this; }
    op(o) { return this.u8(o); }

    load(op, align, offset) { this.u8(op); this.u8(align); lebU(this.body, offset >>> 0); return this; }
    store(op, align, offset) { this.u8(op); this.u8(align); lebU(this.body, offset >>> 0); return this; }

    /** `i32.load align=4 offset=<relocated>` — the tlb_data probe (contract N45). */
    loadRelocOffset(op, align, kind) {
        this.u8(op); this.u8(align);
        const at = this.body.length;
        lebU5(this.body, 0);
        this.relocs.push({ kind, at, width: 5, note: "memarg offset" });
        return this;
    }

    loadFixedI32(addr) { this.constI32(addr); return this.load(OP.I32LOAD, ALIGN.B4, 0); }
    storeFixedI32(addr, emitValue) {
        this.constI32(addr); emitValue(); return this.store(OP.I32STORE, ALIGN.B4, 0);
    }

    call(name, typeKey, argc) {
        const idx = this.importFn(name, typeKey);
        this.u8(OP.CALL); lebU(this.body, idx);
        return this;
    }

    // ── structured control flow ─────────────────────────────────────────────
    block(name) { this.u8(OP.BLOCK); this.u8(TYPE.VOID_BLOCK); this.labelStack.push(name); return this; }
    blockI32(name) { this.u8(OP.BLOCK); this.u8(TYPE.I32); this.labelStack.push(name); return this; }
    loop(name) { this.u8(OP.LOOP); this.u8(TYPE.VOID_BLOCK); this.labelStack.push(name); return this; }
    ifVoid() { this.u8(OP.IF); this.u8(TYPE.VOID_BLOCK); this.labelStack.push(null); return this; }
    ifI32() { this.u8(OP.IF); this.u8(TYPE.I32); this.labelStack.push(null); return this; }
    else_() { return this.u8(OP.ELSE); }
    end() { this.labelStack.pop(); return this.u8(OP.END); }

    depthOf(name) {
        for (let i = this.labelStack.length - 1, d = 0; i >= 0; i--, d++) {
            if (this.labelStack[i] === name) return d;
        }
        throw new Error(`label ${name} not in scope`);
    }
    br(name) { this.u8(OP.BR); lebU(this.body, this.depthOf(name)); return this; }
    brIf(name) { this.u8(OP.BR_IF); lebU(this.body, this.depthOf(name)); return this; }
    brTable(names, defaultName) {
        this.u8(OP.BR_TABLE); lebU(this.body, names.length);
        for (const n of names) lebU(this.body, this.depthOf(n));
        lebU(this.body, this.depthOf(defaultName));
        return this;
    }
    return_() { return this.u8(OP.RETURN); }

    // ── module assembly ─────────────────────────────────────────────────────
    finish() {
        if (this.labelStack.length) throw new Error("unbalanced labels at finish()");
        const out = [];
        const push = (...b) => out.push(...b);
        push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

        const section = (id, payload) => { out.push(id); lebU(out, payload.length); out.push(...payload); };

        // type section — only the signatures actually used, in FT order
        const usedTypes = new Set(this.imports.map((i) => i.typeKey));
        usedTypes.add("i_v"); // the exported function itself
        const types = FT.filter((t) => usedTypes.has(t.key));
        const typeIdx = new Map(types.map((t, i) => [t.key, i]));
        {
            const p = []; lebU(p, types.length);
            for (const t of types) {
                p.push(TYPE.FUNC); lebU(p, t.params.length); p.push(...t.params);
                lebU(p, t.results.length); p.push(...t.results);
            }
            section(1, p);
        }
        // import section: functions in first-use order, then the memory (contract N6)
        {
            const p = []; lebU(p, this.imports.length + 1);
            for (const im of this.imports) {
                lebU(p, 1); p.push(0x65 /* 'e' */);
                const n = [...Buffer.from(im.name, "utf8")];
                lebU(p, n.length); p.push(...n);
                p.push(0x00); lebU(p, typeIdx.get(im.typeKey));
            }
            lebU(p, 1); p.push(0x65); lebU(p, 1); p.push(0x6d /* 'm' */);
            p.push(0x02);      // EXT_MEMORY
            p.push(0x00);      // limits: min only, NOT shared
            lebU(p, 64);       // 64 pages, exactly as wasm_builder.rs:595
            section(2, p);
        }
        // function section: one function, type (i32)->()
        { const p = []; lebU(p, 1); lebU(p, typeIdx.get("i_v")); section(3, p); }
        // export section: exactly one export, named "f"
        {
            const p = []; lebU(p, 1); lebU(p, 1); p.push(0x66 /* 'f' */);
            p.push(0x00); lebU(p, this.imports.length);
            section(7, p);
        }
        // code section
        const bodyStart = { value: 0 };
        {
            const p = [];
            const locals = [];
            if (this.localTypes.length) locals.push([this.localTypes.length, TYPE.I32]);
            const fn = [];
            lebU(fn, locals.length);
            for (const [count, t] of locals) { lebU(fn, count); fn.push(t); }
            const instrStart = fn.length;
            fn.push(...this.body, OP.END);
            lebU(p, 1); lebU(p, fn.length); p.push(...fn);
            // section id + size LEB precede the function count
            const sizeLebLen = (() => { const t = []; lebU(t, p.length); return t.length; })();
            bodyStart.value = out.length + 1 + sizeLebLen +
                (() => { const t = []; lebU(t, 1); return t.length; })() +
                (() => { const t = []; lebU(t, fn.length); return t.length; })() + instrStart;
            section(10, p);
        }
        const bytes = Uint8Array.from(out);
        return {
            bytes,
            bodyStart: bodyStart.value,
            relocs: this.relocs.map((r) => ({ ...r, fileOffset: bodyStart.value + r.at })),
            marks: this.marks.map((m) => ({ ...m, fileOffset: bodyStart.value + m.offset })),
            imports: this.imports.map((i) => i.name),
            localCount: this.localTypes.length,
        };
    }
}

// A small wasm reader: enough of the binary format to let the verifier make claims about our
// own output instead of trusting the producer that wrote it.
//
// Two consumers: `verify.mjs` (the contract checklist as executable code) and the reporting
// path (module size / shape versus the JIT's module for the same page).

export function readSections(bytes) {
    if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error("not a wasm module");
    }
    let p = 8;
    const out = [];
    while (p < bytes.length) {
        const id = bytes[p++];
        const [size, n] = uleb(bytes, p); p += n;
        out.push({ id, start: p, size, end: p + size });
        p += size;
    }
    return out;
}

export function uleb(b, p) {
    let v = 0, s = 0, n = 0;
    for (;;) { const x = b[p + n]; v |= (x & 0x7f) << s; n++; s += 7; if (!(x & 0x80)) break; }
    return [v >>> 0, n];
}
export function sleb(b, p) {
    let v = 0, s = 0, n = 0, x;
    do { x = b[p + n]; v |= (x & 0x7f) << s; s += 7; n++; } while (x & 0x80);
    if (s < 32 && (x & 0x40)) v |= -(1 << s);
    return [v | 0, n];
}
function skipLeb(b, p) { let n = 0; while (b[p + n] & 0x80) n++; return n + 1; }

/** Parse the module's declarative shape (no code). */
export function parseModule(bytes) {
    const sections = readSections(bytes);
    const info = {
        sections: sections.map((s) => ({ id: s.id, size: s.size })),
        types: [], imports: [], functions: [], exports: [], memories: [], globals: [],
        hasData: false, hasStart: false, hasElem: false, hasTable: false,
        code: null, customNames: [],
    };
    for (const s of sections) {
        let p = s.start;
        if (s.id === 0) {
            const [len, n] = uleb(bytes, p); p += n;
            info.customNames.push(Buffer.from(bytes.subarray(p, p + len)).toString("utf8"));
        }
        else if (s.id === 1) {
            const [count, n] = uleb(bytes, p); p += n;
            for (let i = 0; i < count; i++) {
                p++; // 0x60
                const [np, a] = uleb(bytes, p); p += a;
                const params = [...bytes.subarray(p, p + np)]; p += np;
                const [nr, c] = uleb(bytes, p); p += c;
                const results = [...bytes.subarray(p, p + nr)]; p += nr;
                info.types.push({ params, results });
            }
        }
        else if (s.id === 2) {
            const [count, n] = uleb(bytes, p); p += n;
            for (let i = 0; i < count; i++) {
                const [ml, a] = uleb(bytes, p); p += a;
                const mod = Buffer.from(bytes.subarray(p, p + ml)).toString("utf8"); p += ml;
                const [fl, c] = uleb(bytes, p); p += c;
                const field = Buffer.from(bytes.subarray(p, p + fl)).toString("utf8"); p += fl;
                const kind = bytes[p++];
                const im = { module: mod, name: field, kind };
                if (kind === 0) { const [t, d] = uleb(bytes, p); p += d; im.type = t; }
                else if (kind === 1) {
                    im.elemType = bytes[p++];
                    const flags = bytes[p++];
                    const [min, d] = uleb(bytes, p); p += d; im.min = min;
                    if (flags & 1) { const [mx, e] = uleb(bytes, p); p += e; im.max = mx; }
                    info.hasTable = true;
                }
                else if (kind === 2) {
                    const flags = bytes[p++];
                    im.shared = (flags & 2) !== 0;
                    im.hasMax = (flags & 1) !== 0;
                    const [min, d] = uleb(bytes, p); p += d; im.min = min;
                    if (im.hasMax) { const [mx, e] = uleb(bytes, p); p += e; im.max = mx; }
                    info.memories.push(im);
                }
                else if (kind === 3) { im.globalType = bytes[p++]; im.mutable = bytes[p++]; info.globals.push(im); }
                info.imports.push(im);
            }
        }
        else if (s.id === 3) {
            const [count, n] = uleb(bytes, p); p += n;
            for (let i = 0; i < count; i++) { const [t, d] = uleb(bytes, p); p += d; info.functions.push(t); }
        }
        else if (s.id === 4) info.hasTable = true;
        else if (s.id === 5) info.definesMemory = true;
        else if (s.id === 6) info.definesGlobal = true;
        else if (s.id === 7) {
            const [count, n] = uleb(bytes, p); p += n;
            for (let i = 0; i < count; i++) {
                const [nl, a] = uleb(bytes, p); p += a;
                const name = Buffer.from(bytes.subarray(p, p + nl)).toString("utf8"); p += nl;
                const kind = bytes[p++];
                const [idx, d] = uleb(bytes, p); p += d;
                info.exports.push({ name, kind, index: idx });
            }
        }
        else if (s.id === 8) info.hasStart = true;
        else if (s.id === 9) info.hasElem = true;
        else if (s.id === 10) {
            let q = p;
            const [count, n] = uleb(bytes, q); q += n;
            const [bodySize, m] = uleb(bytes, q); q += m;
            const localsStart = q;
            const [groups, g] = uleb(bytes, q); q += g;
            let localCount = 0;
            for (let i = 0; i < groups; i++) {
                const [c, a] = uleb(bytes, q); q += a; q++;   // count, type
                localCount += c;
            }
            info.code = { count, bodySize, localsStart, instrStart: q, instrEnd: localsStart + bodySize, localCount };
        }
        else if (s.id === 11) info.hasData = true;
    }
    return info;
}

// ── body instruction walk ──────────────────────────────────────────────────

const MEMARG = new Set([
    0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35,
    0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e,
]);
const ONE_ULEB = new Set([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24]);

/**
 * Walk the function body, yielding {offset, op, depth, imm}. `depth` is the label depth BEFORE
 * the instruction, so a `br` at depth d targets label depth d - imm.
 */
export function* walkBody(bytes, from, to) {
    let p = from, depth = 0;
    while (p < to) {
        const off = p;
        const op = bytes[p++];
        let imm = null;
        if (op === 0x02 || op === 0x03 || op === 0x04) { p++; yield { offset: off, op, depth, imm: null }; depth++; continue; }
        if (op === 0x0b) { depth--; yield { offset: off, op, depth, imm: null }; continue; }
        if (op === 0x05) { yield { offset: off, op, depth, imm: null }; continue; }
        if (op === 0x0e) {
            const [n, a] = uleb(bytes, p); p += a;
            const targets = [];
            for (let i = 0; i <= n; i++) { const [t, b] = uleb(bytes, p); p += b; targets.push(t); }
            yield { offset: off, op, depth, imm: targets };
            continue;
        }
        if (ONE_ULEB.has(op)) { const [v, a] = uleb(bytes, p); p += a; imm = v; }
        else if (op === 0x41) { const [v, a] = sleb(bytes, p); p += a; imm = v; }
        else if (op === 0x42) { p += skipI64Leb(bytes, p); }
        else if (op === 0x43) p += 4;
        else if (op === 0x44) p += 8;
        else if (MEMARG.has(op)) {
            const align = bytes[p++];
            const [o, a] = uleb(bytes, p); p += a;
            imm = { align, offset: o, offsetAt: p - a };
        }
        else if (op === 0x11) { p += skipLeb(bytes, p); p += skipLeb(bytes, p); }
        else if (op === 0x3f || op === 0x40) p++;
        yield { offset: off, op, depth, imm };
    }
}
function skipI64Leb(b, p) { let n = 0; while (b[p + n] & 0x80) n++; return n + 1; }

/** Histogram + total instruction count of a function body. */
export function bodyStats(bytes, from, to) {
    let n = 0, maxDepth = 0;
    const hist = new Map();
    for (const ins of walkBody(bytes, from, to)) {
        n++;
        hist.set(ins.op, (hist.get(ins.op) ?? 0) + 1);
        if (ins.depth > maxDepth) maxDepth = ins.depth;
    }
    return { instructions: n, bytes: to - from, maxDepth, hist };
}

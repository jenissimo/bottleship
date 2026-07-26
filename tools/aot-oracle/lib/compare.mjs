// aot-oracle — the differential comparator.
//
// Its only job: given the reference arm's result and a candidate's, say whether they are
// byte-identical and, if not, name the FIRST divergence precisely enough to debug it — a
// guest address (with the register name when it lands in the spilled register file) or a
// state field name. "The shas differ" is not an answer anyone can act on.

import { flattenState } from "./state.mjs";

const hexByte = (n) => n.toString(16).padStart(2, "0");

function bytesOf(region) {
    const b = Buffer.from(region.hex, "hex");
    if (b.length !== region.len) throw new Error(`region ${region.name}: ${b.length} bytes, expected ${region.len}`);
    return b;
}

/** Name the field a byte offset lands in, for regions that declare a layout (STATE). */
function fieldAt(region, off) {
    if (!region.fields) return null;
    for (const [name, base, len] of region.fields) {
        if (off >= base && off < base + len) return { name, byteInField: off - base };
    }
    return null;
}

function context(buf, off, radius = 8) {
    const from = Math.max(0, off - radius), to = Math.min(buf.length, off + radius + 1);
    return { from, hex: [...buf.subarray(from, to)].map(hexByte).join(" ") };
}

/**
 * Compare the compared-region sets of two arms.
 * @returns {{identical:boolean, regions:object[], first:object|null}}
 */
export function compareRegions(ref, cand) {
    const byName = new Map(cand.map((r) => [r.name, r]));
    const regions = [];
    let first = null;
    for (const r of ref) {
        const c = byName.get(r.name);
        if (!c) {
            const rec = { name: r.name, status: "MISSING_IN_CANDIDATE" };
            regions.push(rec);
            first ??= { region: r.name, why: "candidate produced no such region" };
            continue;
        }
        if (c.sha256 === r.sha256) { regions.push({ name: r.name, status: "identical", sha256: r.sha256 }); continue; }
        const a = bytesOf(r), b = bytesOf(c);
        let off = -1;
        for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) { off = i; break; } }
        if (off < 0) off = Math.min(a.length, b.length);   // one is a prefix of the other
        const f = fieldAt(r, off);
        const aligned = off - (off % 4);
        const d = {
            region: r.name,
            guest_addr: "0x" + (r.addr + off).toString(16),
            offset: off,
            field: f ? f.name : null,
            field_byte: f ? f.byteInField : null,
            ref_byte: "0x" + hexByte(a[off] ?? 0),
            cand_byte: "0x" + hexByte(b[off] ?? 0),
            ref_dword: aligned + 4 <= a.length ? "0x" + a.readUInt32LE(aligned).toString(16) : null,
            cand_dword: aligned + 4 <= b.length ? "0x" + b.readUInt32LE(aligned).toString(16) : null,
            ref_context: context(a, off),
            cand_context: context(b, off),
            differing_bytes: (() => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; })(),
        };
        regions.push({ name: r.name, status: "DIVERGENT", ...d });
        first ??= d;
    }
    return { identical: first === null, regions, first };
}

/**
 * Compare architectural state. Fields the candidate does not model are NOT treated as equal:
 * they are returned in `uncompared`, and the caller reports them.
 */
export function compareState(ref, cand) {
    if (!ref || !cand) {
        return {
            available: false, identical: null, first: null, uncompared: [],
            why: !ref ? "reference produced no host-side state" : "candidate publishes no host-side state",
        };
    }
    const a = flattenState(ref), b = new Map(flattenState(cand));
    const diffs = [], uncompared = [];
    for (const [k, va] of a) {
        const vb = b.get(k);
        if (va === undefined && vb === undefined) continue;
        if (va === null || vb === null || va === undefined || vb === undefined) {
            if (!(va === null && vb === null)) uncompared.push(k);
            continue;
        }
        if (va !== vb) {
            diffs.push({
                field: k,
                ref: typeof va === "number" ? "0x" + (va >>> 0).toString(16) : String(va),
                cand: typeof vb === "number" ? "0x" + (vb >>> 0).toString(16) : String(vb),
            });
        }
    }
    return { available: true, identical: diffs.length === 0, first: diffs[0] ?? null, diffs, uncompared };
}

/** One-line human summary of the first divergence, for stderr. */
export function describeFirst(regionDiff, stateDiff) {
    if (regionDiff) {
        const where = regionDiff.field
            ? `${regionDiff.region}.${regionDiff.field} (guest ${regionDiff.guest_addr})`
            : `${regionDiff.region} @ guest ${regionDiff.guest_addr}`;
        return `${where}: ref ${regionDiff.ref_dword ?? regionDiff.ref_byte} vs candidate ${regionDiff.cand_dword ?? regionDiff.cand_byte}`;
    }
    if (stateDiff) return `state.${stateDiff.field}: ref ${stateDiff.ref} vs candidate ${stateDiff.cand}`;
    return "no divergence";
}

/**
 * codegen — capture and DIFF the wasm module bytes the JIT emits for a page set.
 *
 * The decisive test for any codegen flag: emit a hot page with the flag ON and with it
 * OFF and compare the module BYTES. Identical bytes mean the flag never reached codegen
 * on this workload — it is dead there, and no FPS measurement can say anything else.
 * Differing bytes move the question to whether the new shape is better, which the
 * per-section/local-count summary and an exported module (`export` → base64) answer.
 *
 * Capture reuses the `__wasmDump` hook in codegen_finalize (one falsy check in
 * production). Arms default to the engine's own tier-2 page set: those pages crossed the
 * retired-instruction threshold, so they are hot by the engine's measure, not by a guess.
 *
 * Method note: a flag toggle clears the JIT cache, so the ONLY sound comparison is
 * label-vs-label from captures taken after equal re-warm, and an A/B/A rotation is what
 * separates "the flag changed the bytes" from "the module was composed differently this
 * time" (module page sets are discovered by BFS and can drift between compiles).
 */

import type { HarnessService } from "../service";

interface DumpRec { start: number; table_index: number; len: number; bytes: Uint8Array }

interface CapturedModule {
    page: number;
    tableIndex: number;
    len: number;
    sha: string;
    bytes: Uint8Array;
    /** wasm section id → total byte length, plus the declared local-group summary. */
    sections: Record<string, number>;
    localGroups: Array<[number, string]>;
    localCount: number;
}

const slots = new Map<string, Map<number, CapturedModule>>();

function wasmExports(): any {
    return (globalThis as any).preemption?.getWasmExports?.() ?? null;
}

function hex(buf: ArrayBuffer): string {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    // crypto.subtle refuses a shared backing store; the capture is already a copy, but
    // re-copying keeps this safe for callers that hand in a wasm-heap view.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return hex(await crypto.subtle.digest("SHA-256", copy.buffer));
}

const SECTION_NAMES: Record<number, string> = {
    0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory",
    6: "global", 7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount",
};

const WASM_TYPES: Record<number, string> = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128" };

function readLeb(b: Uint8Array, pos: number): [number, number] {
    let result = 0, shift = 0, p = pos;
    for (;;) {
        const byte = b[p++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [result >>> 0, p];
}

/**
 * Section census + the code section's declared local groups.
 *
 * Locals are the load-bearing number for the "locals instead of memory" family of flags
 * (x87Locals, flagLocals): a wasm function zero-initialises every declared local on entry,
 * so locals a module barely uses are a per-ENTRY cost paid by the whole module.
 */
function summarize(bytes: Uint8Array): Pick<CapturedModule, "sections" | "localGroups" | "localCount"> {
    const sections: Record<string, number> = {};
    const localGroups: Array<[number, string]> = [];
    let localCount = 0;
    let p = 8; // magic + version
    while (p < bytes.length) {
        const id = bytes[p++];
        const [size, after] = readLeb(bytes, p);
        p = after;
        let name = SECTION_NAMES[id] ?? `id${id}`;
        if (id === 0) {
            const [nameLen, q] = readLeb(bytes, p);
            name = `custom:${new TextDecoder().decode(bytes.subarray(q, q + nameLen))}`;
        }
        sections[name] = (sections[name] ?? 0) + size;
        if (id === 10) {
            // code section: count = 1 function for a v86 module; read its local groups.
            const [count, q0] = readLeb(bytes, p);
            let q = q0;
            if (count >= 1) {
                const [, q1] = readLeb(bytes, q); // body size
                q = q1;
                const [groups, q2] = readLeb(bytes, q);
                q = q2;
                for (let g = 0; g < groups; g++) {
                    const [n, q3] = readLeb(bytes, q);
                    const t = bytes[q3];
                    q = q3 + 1;
                    localGroups.push([n, WASM_TYPES[t] ?? `t${t}`]);
                    localCount += n;
                }
            }
        }
        p += size;
    }
    return { sections, localGroups, localCount };
}

function tier2Pages(): number[] {
    const w = wasmExports();
    const out: number[] = [];
    const n = w?.jit_get_tier2_page_count ? w.jit_get_tier2_page_count() >>> 0 : 0;
    for (let i = 0; i < n; i++) {
        const addr = w.jit_get_tier2_page_at(i) >>> 0;
        if (addr) out.push(addr >>> 12);
    }
    return out;
}

export function registerCodegenCommands(svc: HarnessService): void {
    /**
     * jitBytes(action, a, b) — module-byte capture/diff.
     *   arm [pages]        arm __wasmDump for pages (default: the tier-2 page set)
     *   snap <label>       drain the capture into a named slot (per entry page)
     *   diff <la> <lb>     per-page byte comparison of two slots
     *   slots              what has been captured
     *   export <label> <page>   module bytes as base64 (for offline disassembly)
     *   pages              the current tier-2 page set
     *   clear / off
     */
    svc.register("jitBytes", async (args) => {
        const [action, a, b] = args as [string, unknown, unknown];
        const g = globalThis as any;
        switch (String(action ?? "slots")) {
            case "arm": {
                const list = Array.isArray(a) && a.length ? (a as number[]) : tier2Pages();
                g.__wasmDump = { pages: new Set(list), out: [], keepLatestPerPage: true };
                return { armed: list.length, pages: list.map((p) => `0x${p.toString(16)}`) };
            }
            case "off":
                g.__wasmDump = undefined;
                return { armed: 0 };
            case "snap": {
                const label = String(a ?? "default");
                const dump = g.__wasmDump;
                const out: DumpRec[] = dump?.out ?? [];
                const slot = new Map<number, CapturedModule>();
                for (const rec of out) {
                    const bytes = new Uint8Array(rec.bytes.length);
                    bytes.set(rec.bytes);
                    slot.set(rec.start >>> 12, {
                        page: rec.start >>> 12,
                        tableIndex: rec.table_index >>> 0,
                        len: rec.len >>> 0,
                        sha: await sha256(bytes),
                        bytes,
                        ...summarize(bytes),
                    });
                }
                slots.set(label, slot);
                // Drain so the NEXT arm only sees modules compiled after this point.
                if (dump) dump.out = [];
                return {
                    label,
                    modules: slot.size,
                    totalBytes: [...slot.values()].reduce((s, m) => s + m.len, 0),
                    entries: [...slot.values()].map((m) => ({
                        page: `0x${m.page.toString(16)}`, len: m.len, locals: m.localCount,
                        sha: m.sha.slice(0, 12),
                    })),
                };
            }
            case "diff": {
                const la = String(a), lb = String(b);
                const A = slots.get(la), B = slots.get(lb);
                if (!A || !B) throw new Error(`jitBytes diff: unknown slot(s) ${!A ? la : ""} ${!B ? lb : ""}`);
                const pages = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
                const rows = pages.map((p) => {
                    const ma = A.get(p), mb = B.get(p);
                    if (!ma || !mb) {
                        return { page: `0x${p.toString(16)}`, onlyIn: ma ? la : lb };
                    }
                    let firstDiff = -1, diffBytes = 0;
                    const n = Math.min(ma.len, mb.len);
                    for (let i = 0; i < n; i++) {
                        if (ma.bytes[i] !== mb.bytes[i]) {
                            if (firstDiff < 0) firstDiff = i;
                            diffBytes++;
                        }
                    }
                    const identical = ma.len === mb.len && diffBytes === 0;
                    const secKeys = [...new Set([...Object.keys(ma.sections), ...Object.keys(mb.sections)])];
                    const sectionDelta: Record<string, string> = {};
                    for (const k of secKeys) {
                        const va = ma.sections[k] ?? 0, vb = mb.sections[k] ?? 0;
                        if (va !== vb) sectionDelta[k] = `${va}→${vb}`;
                    }
                    return {
                        page: `0x${p.toString(16)}`,
                        identical,
                        len: ma.len === mb.len ? ma.len : `${ma.len}→${mb.len}`,
                        lenDelta: mb.len - ma.len,
                        locals: ma.localCount === mb.localCount ? ma.localCount : `${ma.localCount}→${mb.localCount}`,
                        localDelta: mb.localCount - ma.localCount,
                        firstDiffAt: firstDiff < 0 ? null : firstDiff,
                        diffBytes,
                        sectionDelta: Object.keys(sectionDelta).length ? sectionDelta : null,
                    };
                });
                const both = rows.filter((r: any) => r.identical !== undefined);
                return {
                    a: la, b: lb,
                    comparable: both.length,
                    identical: both.filter((r: any) => r.identical).length,
                    changed: both.filter((r: any) => !r.identical).length,
                    onlyInOne: rows.length - both.length,
                    totalBytesA: [...A.values()].reduce((s, m) => s + m.len, 0),
                    totalBytesB: [...B.values()].reduce((s, m) => s + m.len, 0),
                    rows,
                };
            }
            case "export": {
                const slot = slots.get(String(a));
                if (!slot) throw new Error(`jitBytes export: unknown slot ${String(a)}`);
                const page = typeof b === "string" ? parseInt(b, 16) : Number(b);
                const m = slot.get(page >>> 0);
                if (!m) throw new Error(`jitBytes export: slot ${String(a)} has no page 0x${(page >>> 0).toString(16)}`);
                let s = "";
                for (let i = 0; i < m.bytes.length; i++) s += String.fromCharCode(m.bytes[i]);
                return { page: `0x${m.page.toString(16)}`, len: m.len, sha: m.sha, base64: btoa(s) };
            }
            case "pages":
                return { tier2: tier2Pages().map((p) => `0x${p.toString(16)}`) };
            case "clear":
                slots.clear();
                return { cleared: true };
            default:
                return {
                    slots: [...slots.entries()].map(([k, v]) => ({
                        label: k, modules: v.size,
                        totalBytes: [...v.values()].reduce((s, m) => s + m.len, 0),
                    })),
                    armed: !!(globalThis as any).__wasmDump,
                };
        }
    });
}

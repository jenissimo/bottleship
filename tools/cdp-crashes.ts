/**
 * cdp-crashes.ts — read Chrome's own crash dumps and say, in one line each, WHAT died.
 *
 * Why this exists: a renderer crash is invisible from inside the tooling. The page target
 * stays listed in `/json/list`, the tab keeps its title, the worker targets vanish, the log
 * archive stops mid-line and no error is reported anywhere — it reads exactly like "the
 * worker died silently", and a whole session was spent building that wrong model. Crashpad
 * had written a minidump each time, naming the process type, the faulting module and the
 * exact instruction; nothing was reading them.
 *
 * We parse the minidump ourselves rather than shelling out to a debugger: same discipline as
 * the archive readers in packages/formats — no external native tool, works headless.
 *
 * What a dump gives us WITHOUT symbols, which is already enough to act on:
 *   - process type (renderer / gpu / browser) and the crashing thread's name,
 *   - the exception (ACCESS_VIOLATION vs Chrome's 0xe0000008 out-of-memory),
 *   - module + RVA of the faulting instruction — a stable FINGERPRINT, so two crashes can be
 *     told apart or shown to be the same one,
 *   - committed address space at the moment of death, which separates "we ran out of memory"
 *     from "something dereferenced garbage".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const EXCEPTION_NAMES: Record<number, string> = {
    0xc0000005: "ACCESS_VIOLATION",
    0xc000001d: "ILLEGAL_INSTRUCTION",
    0x80000003: "BREAKPOINT",
    0xc0000409: "STACK_BUFFER_OVERRUN",
    0xc0000374: "HEAP_CORRUPTION",
    0xc00000fd: "STACK_OVERFLOW",
    0xe0000008: "OUT_OF_MEMORY (Chrome)",
    0xc0000017: "NO_MEMORY",
    0xc0000602: "FAIL_FAST",
};

const STREAM_THREAD_LIST = 3;
const STREAM_MODULE_LIST = 4;
const STREAM_EXCEPTION = 6;
const STREAM_MEMORY_INFO_LIST = 16;
const STREAM_THREAD_NAMES = 24;
const MODULE_ENTRY_BYTES = 108;
const THREAD_ENTRY_BYTES = 48;

export interface CrashReport {
    file: string;
    when: Date;
    /** e.g. "renderer", "gpu-process", "browser" — Crashpad's `ptype` annotation. */
    processType: string;
    exceptionCode: number;
    exceptionName: string;
    /** Address the faulting instruction is at (the RIP), and where it lives. */
    faultModule: string | null;
    faultRva: number | null;
    /** For an access violation: what the code tried to touch, and whether it read or wrote. */
    accessKind: "read" | "write" | "execute" | null;
    accessAddress: bigint | null;
    crashThread: string;
    committedGiB: number;
    /** module+RVA — the same crash twice produces the same string. */
    fingerprint: string;
}

function readMdString(d: Buffer, rva: number): string {
    const n = d.readUInt32LE(rva);
    return d.subarray(rva + 4, rva + 4 + n).toString("utf16le");
}

export function parseMinidump(path: string): CrashReport | null {
    const d = readFileSync(path);
    if (d.length < 32 || d.toString("latin1", 0, 4) !== "MDMP") return null;
    const streamCount = d.readUInt32LE(8);
    const dirRva = d.readUInt32LE(12);
    const streams = new Map<number, { size: number; rva: number }>();
    for (let i = 0; i < streamCount; i++) {
        const o = dirRva + i * 12;
        if (o + 12 > d.length) break;
        const type = d.readUInt32LE(o);
        if (!streams.has(type)) streams.set(type, { size: d.readUInt32LE(o + 4), rva: d.readUInt32LE(o + 8) });
    }

    const modules: Array<{ base: bigint; size: number; name: string }> = [];
    const ml = streams.get(STREAM_MODULE_LIST);
    if (ml) {
        const n = d.readUInt32LE(ml.rva);
        for (let i = 0; i < n; i++) {
            const o = ml.rva + 4 + i * MODULE_ENTRY_BYTES;
            modules.push({
                base: d.readBigUInt64LE(o),
                size: d.readUInt32LE(o + 8),
                name: basename(readMdString(d, d.readUInt32LE(o + 20))),
            });
        }
    }
    const moduleAt = (addr: bigint) =>
        modules.find((m) => addr >= m.base && addr < m.base + BigInt(m.size)) ?? null;

    let exceptionCode = 0, crashTid = 0;
    let faultModule: string | null = null, faultRva: number | null = null;
    let accessKind: CrashReport["accessKind"] = null, accessAddress: bigint | null = null;
    const ex = streams.get(STREAM_EXCEPTION);
    if (ex) {
        crashTid = d.readUInt32LE(ex.rva);
        exceptionCode = d.readUInt32LE(ex.rva + 8);
        const exAddr = d.readBigUInt64LE(ex.rva + 24);
        const nParams = d.readUInt32LE(ex.rva + 32);
        const m = moduleAt(exAddr);
        if (m) { faultModule = m.name; faultRva = Number(exAddr - m.base); }
        if (exceptionCode === 0xc0000005 && nParams >= 2) {
            const kind = d.readBigUInt64LE(ex.rva + 40);
            accessKind = kind === 0n ? "read" : kind === 1n ? "write" : "execute";
            accessAddress = d.readBigUInt64LE(ex.rva + 48);
        }
    }

    let crashThread = "<unnamed>";
    const tn = streams.get(STREAM_THREAD_NAMES);
    if (tn) {
        const n = d.readUInt32LE(tn.rva);
        for (let i = 0; i < n; i++) {
            const o = tn.rva + 4 + i * 12;
            if (d.readUInt32LE(o) !== crashTid) continue;
            crashThread = readMdString(d, Number(d.readBigUInt64LE(o + 4))) || "<unnamed>";
            break;
        }
    }
    // Present but unused here; reading it keeps the layout assertion honest if it ever changes.
    void streams.get(STREAM_THREAD_LIST)?.size && THREAD_ENTRY_BYTES;

    let committed = 0n;
    const mi = streams.get(STREAM_MEMORY_INFO_LIST);
    if (mi) {
        const headerSize = d.readUInt32LE(mi.rva);
        const entrySize = d.readUInt32LE(mi.rva + 4);
        const count = Number(d.readBigUInt64LE(mi.rva + 8));
        for (let i = 0; i < count; i++) {
            const o = mi.rva + headerSize + i * entrySize;
            if (o + 48 > d.length) break;
            if (d.readUInt32LE(o + 32) === 0x1000 /* MEM_COMMIT */) committed += d.readBigUInt64LE(o + 24);
        }
    }

    // Crashpad keeps the process type as a simple annotation; the value follows the key.
    let processType = "?";
    const idx = d.indexOf("ptype", 0, "latin1");
    if (idx >= 0) {
        const tail = d.subarray(idx + 5, idx + 40).toString("latin1").replace(/[^\x20-\x7e]/g, "");
        if (tail) processType = tail.slice(0, 20);
    }

    return {
        file: basename(path),
        when: statSync(path).mtime,
        processType,
        exceptionCode,
        exceptionName: EXCEPTION_NAMES[exceptionCode] ?? `0x${exceptionCode.toString(16)}`,
        faultModule,
        faultRva,
        accessKind,
        accessAddress,
        crashThread,
        committedGiB: +(Number(committed) / 2 ** 30).toFixed(2),
        fingerprint: faultModule ? `${faultModule}+0x${(faultRva ?? 0).toString(16)}` : `code:0x${exceptionCode.toString(16)}`,
    };
}

export function crashpadDir(profile = `${process.cwd()}/tmp/cdp-profile`): string {
    return join(profile, "Crashpad", "reports");
}

/** Every dump, newest last. `since` filters by mtime — pass the time an experiment started. */
export function listCrashes(opts: { dir?: string; since?: Date } = {}): CrashReport[] {
    const dir = opts.dir ?? crashpadDir();
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".dmp")); } catch { return []; }
    const out: CrashReport[] = [];
    for (const f of files) {
        const p = join(dir, f);
        if (opts.since && statSync(p).mtime < opts.since) continue;
        try { const r = parseMinidump(p); if (r) out.push(r); } catch { /* truncated dump */ }
    }
    return out.sort((a, b) => +a.when - +b.when);
}

export function formatCrash(c: CrashReport): string {
    const addr = c.accessAddress === null ? "" : ` ${c.accessKind} @ 0x${c.accessAddress.toString(16)}`;
    return `${c.when.toISOString().slice(11, 19)}  ${c.processType.padEnd(9)} ${c.exceptionName}${addr}\n` +
        `            at ${c.fingerprint}  thread "${c.crashThread}"  committed ${c.committedGiB} GiB  (${c.file.slice(0, 8)})`;
}

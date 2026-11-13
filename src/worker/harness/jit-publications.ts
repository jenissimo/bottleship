/** One basic block of a generated module (v86 jit_block_map.rs). `bodyStart`/`bodyEnd` are byte
 *  offsets into the function body counted from its first instruction (after the locals
 *  declaration); the range covers the block's code and its terminator. */
export interface JitBlockMapBlock {
    addr: number; virtAddr: number; endAddr: number; lastInstructionAddr: number;
    instructions: number; bodyStart: number; bodyEnd: number; entry: boolean; traced: boolean;
}
export interface JitBlockMap { bodyLength: number; blocks: JitBlockMapBlock[] }

const BLOCK_MAP_STRIDE = 8; // u32 words per record
const FLAG_ENTRY = 1, FLAG_TRACED = 2;

/** Read the map v86 recorded for the module it generated LAST. Valid only synchronously inside
 *  codegen_finalize (the publication `begin` hook): the next compile overwrites it. */
export function readJitBlockMap(exports: any, buffer: ArrayBufferLike): JitBlockMap | null {
    if (typeof exports?.jit_block_map_count !== 'function') return null;
    const n = exports.jit_block_map_count() >>> 0;
    if (!n) return null;
    const words = new Uint32Array(buffer, exports.jit_block_map_ptr() >>> 0, n * BLOCK_MAP_STRIDE);
    const blocks: JitBlockMapBlock[] = [];
    for (let i = 0; i < n; i++) {
        const o = i * BLOCK_MAP_STRIDE, flags = words[o + 7];
        blocks.push({ addr: words[o], virtAddr: words[o + 1], endAddr: words[o + 2], lastInstructionAddr: words[o + 3],
            instructions: words[o + 4], bodyStart: words[o + 5], bodyEnd: words[o + 6],
            entry: (flags & FLAG_ENTRY) !== 0, traced: (flags & FLAG_TRACED) !== 0 });
    }
    return { bodyLength: exports.jit_block_map_body_length() >>> 0, blocks };
}

/** Instruction-body length of a single-function module (final `end` excluded), or -1. The
 *  check that a map read at finalize belongs to the bytes captured with it. */
export function moduleBodyLength(bytes: Uint8Array): number {
    let p = 8;
    const leb = () => { let v = 0, s = 0, b: number; do { b = bytes[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; };
    while (p < bytes.length) {
        const id = bytes[p++], size = leb(), end = p + size;
        if (id === 10) {
            if (leb() !== 1) return -1;
            const bodySize = leb(), localsStart = p;
            const groups = leb();
            for (let i = 0; i < groups; i++) { leb(); p++; }
            return localsStart + bodySize - p - 1;
        }
        p = end;
    }
    return -1;
}

type BlockMapStatus =
    | { status: 'ok'; bodyLength: number; blocks: JitBlockMapBlock[] }
    | { status: 'absent' | 'mismatch'; note: string };

/** Bounded diagnostic storage. Hashing/export happens only after sealing the journal. */
export function createJitPublicationCapture(
    options: { maxRecords?: number; maxBytes?: number } = {},
    readBlockMap?: () => JitBlockMap | null,
) {
    const maxRecords = options.maxRecords ?? 8192;
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) {
        throw new Error('Invalid JIT capture limits');
    }
    const sessionId = crypto.randomUUID();
    const timeOrigin = performance.timeOrigin;
    const records: Array<{
        generation: number; start: number; tableIndex: number; tableSlot: number;
        compiledAt: number; publishedAt: number | null; publicationOrder: number | null;
        status: 'pending' | 'published' | 'failed'; bytes: Uint8Array; blockMap?: BlockMapStatus;
    }> = [];
    let seen = 0, retainedBytes = 0, dropped = 0, droppedBytes = 0, order = 0, sealed = false;
    return {
        begin(start: number, tableIndex: number, tableSlot: number, bytes: Uint8Array) {
            if (sealed) return null;
            const generation = ++seen;
            if (records.length >= maxRecords || retainedBytes + bytes.length > maxBytes) {
                dropped++;
                droppedBytes += bytes.length;
                return null;
            }
            const rec: (typeof records)[number] = { generation, start, tableIndex, tableSlot, compiledAt: performance.now(),
                publishedAt: null as number | null, publicationOrder: null as number | null,
                status: 'pending' as 'pending' | 'published' | 'failed', bytes: bytes.slice() };
            if (readBlockMap) {
                // Read NOW: the map describes the module v86 generated last, and this hook runs
                // synchronously inside its codegen_finalize. The body-length check rejects a map
                // left over from another module (AOT bytes, a failed generation) instead of
                // attributing its ranges to these bytes.
                const map = readBlockMap();
                const len = moduleBodyLength(rec.bytes);
                rec.blockMap = !map ? { status: 'absent', note: 'v86 recorded no blocks for this module' }
                    : map.bodyLength !== len ? { status: 'mismatch', note: `map body ${map.bodyLength} B != module body ${len} B` }
                    : { status: 'ok', ...map };
            }
            records.push(rec);
            retainedBytes += bytes.length;
            return {
                published() {
                    if (sealed || rec.status !== 'pending') return;
                    rec.status = 'published';
                    rec.publishedAt = performance.now();
                    rec.publicationOrder = ++order;
                },
                failed() {
                    if (!sealed && rec.status === 'pending') rec.status = 'failed';
                },
            };
        },
        status() {
            return { sessionId, timeOrigin, maxRecords, maxBytes, seen, retainedBytes, dropped,
                droppedBytes, records: records.length, sealed, blockMap: !!readBlockMap };
        },
        seal() { sealed = true; },
        async export() {
            if (!sealed) throw new Error('Seal JIT capture before export');
            const modules = new Map<string, string>();
            const events = [];
            for (const { bytes, ...rec } of records) {
                const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
                const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                if (!modules.has(sha256)) {
                    let binary = '';
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    modules.set(sha256, btoa(binary));
                }
                events.push({ ...rec, sha256, byteLength: bytes.length });
            }
            return { ...this.status(), events, modules: [...modules].map(([sha256, base64]) => ({ sha256, base64 })),
                guestInstructionMap: readBlockMap
                    ? { status: 'blocks', note: 'events[].blockMap: physical block address, instruction count and body byte range per block. Join with guestBlocks via tools/bench-v86/jit-exec-density.mjs.' }
                    : { status: 'unavailable', note: "arm with {blockMap:true} to record each module's block map" },
                note: 'Pending at seal and repeated identical bytes do not identify an execution generation.' };
        },
    };
}

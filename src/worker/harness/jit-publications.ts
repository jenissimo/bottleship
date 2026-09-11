/** Bounded diagnostic storage. Hashing/export happens only after sealing the journal. */
export function createJitPublicationCapture(options: { maxRecords?: number; maxBytes?: number } = {}) {
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
        status: 'pending' | 'published' | 'failed'; bytes: Uint8Array;
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
            const rec = { generation, start, tableIndex, tableSlot, compiledAt: performance.now(),
                publishedAt: null as number | null, publicationOrder: null as number | null,
                status: 'pending' as 'pending' | 'published' | 'failed', bytes: bytes.slice() };
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
                droppedBytes, records: records.length, sealed };
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
                guestInstructionMap: { status: 'unavailable' },
                note: 'Pending at seal and repeated identical bytes do not identify an execution generation.' };
        },
    };
}

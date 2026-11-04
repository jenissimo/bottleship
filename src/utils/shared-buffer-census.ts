/**
 * SharedArrayBuffer census for harness `footprint`: every SAB this realm CREATES at a noted
 * site, by label, while it is still reachable. One module instance per realm (page, emulator
 * worker, ...); the facade merges the page's census with the worker's.
 *
 * WeakRef-held, so noting a buffer never keeps it alive. A SAB shared between realms is
 * noted once, by its creator, and is one mapping in the process however many views it has.
 */

const entries: Array<{ label: string; ref: WeakRef<SharedArrayBuffer>; bytes: number }> = [];

export function noteSharedBuffer(label: string, sab: SharedArrayBuffer): SharedArrayBuffer {
    entries.push({ label, ref: new WeakRef(sab), bytes: sab.byteLength });
    if (entries.length > 512) compact();
    return sab;
}

function compact(): void {
    for (let i = entries.length - 1; i >= 0; i--) if (!entries[i]!.ref.deref()) entries.splice(i, 1);
}

export function sharedBufferCensus(): { count: number; bytes: number; byLabel: Record<string, { count: number; bytes: number }> } {
    compact();
    const byLabel: Record<string, { count: number; bytes: number }> = {};
    let bytes = 0;
    for (const e of entries) {
        const live = e.ref.deref();
        if (!live) continue;
        const b = live.byteLength;
        bytes += b;
        const row = (byLabel[e.label] ??= { count: 0, bytes: 0 });
        row.count++; row.bytes += b;
    }
    return { count: entries.length, bytes, byLabel };
}

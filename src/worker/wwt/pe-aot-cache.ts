import { sha256Hex } from "../savestate/chunk-store";

const HEADER_BYTES = 32;
const DISK_BUDGET = 1024 * 1024 * 1024;
const stats = { hits: 0, misses: 0, writes: 0, writeErrors: 0, bytesRead: 0, bytesWritten: 0 };
type Directory = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

export function peAotCacheStats() { return { ...stats }; }

async function cacheDirectory(): Promise<Directory | null> {
    if (!globalThis.navigator?.storage?.getDirectory) return null;
    try {
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle("bottleship", { create: true });
        return await app.getDirectoryHandle("wwt-pe-aot-v1", { create: true }) as Directory;
    } catch {
        return null;
    }
}

async function readEntry(dir: Directory, key: string): Promise<PeAotCacheEntry | undefined> {
    try {
        const file = await (await dir.getFileHandle(key)).getFile();
        if (file.size <= HEADER_BYTES || file.size > DISK_BUDGET) return;
        const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
        const payload = new Uint8Array(await file.slice(HEADER_BYTES).arrayBuffer());
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
        if (!header.every((b, i) => b === hash[i]) || payload.length <= 4) return;
        const view = new DataView(payload.buffer);
        const count = view.getUint32(0, true);
        const wasmStart = 4 + count * 4;
        if (wasmStart >= payload.length) return;
        const seeds = Array.from({ length: count }, (_, i) => view.getUint32(4 + i * 4, true));
        return { bytes: payload.subarray(wasmStart), seeds };
    } catch { /* Missing or unreadable cache entries are rebuilt from the PE. */ }
}

async function makeRoom(dir: Directory, except: string, required: number): Promise<void> {
    const files = [];
    let total = required;
    for await (const [, handle] of dir.entries()) {
        if (handle.kind !== "file" || !/^[0-9a-f]{64}\.wasm$/.test(handle.name) || handle.name === except) continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        total += file.size;
        files.push({name: file.name, size: file.size, date: file.lastModified});
    }
    if (total <= DISK_BUDGET) return;
    files.sort((a,b) => a.date - b.date);
    for (const file of files) {
        if (total <= DISK_BUDGET) break;
        await dir.removeEntry(file.name);
        total -= file.size;
    }
}

export interface PeAotCacheEntry {
    bytes: Uint8Array<ArrayBuffer>;
    seeds: number[];
}

export async function peAotCacheKey(image: Uint8Array<ArrayBuffer>, modeKey: string): Promise<string> {
    const digest = await sha256Hex(image);
    return await sha256Hex(new TextEncoder().encode(modeKey + "/" + digest)) + ".wasm";
}

async function writeFile(dir: Directory, name: string, parts: BufferSource[]): Promise<void> {
    const handle = await dir.getFileHandle(name, {create: true});
    const writer = await handle.createWritable();
    try {
        for (const part of parts) await writer.write(part);
        await writer.close();
    } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
    }
}

export async function readPeAot(key: string): Promise<PeAotCacheEntry | null> {
    const dir = await cacheDirectory();
    return dir ? (await readEntry(dir, key)) ?? null : null;
}

export function notePeAotLookup(hit: Uint8Array<ArrayBuffer> | null): void {
    if (!hit) { stats.misses++; return; }
    stats.hits++;
    stats.bytesRead += hit.byteLength;
}

export type PeAotPlan = "use" | "use-and-refresh" | "rebuild";

export function planPeAot(cachedSeeds: readonly number[] | null, profile: readonly number[], refreshInBackground: boolean): PeAotPlan {
    if (!cachedSeeds) return "rebuild";
    const known = new Set(cachedSeeds);
    if (profile.every(address => known.has(address))) return "use";
    return refreshInBackground ? "use-and-refresh" : "rebuild";
}

export async function writePeAot(key: string, bytes: Uint8Array<ArrayBuffer>, seeds: readonly number[] = []): Promise<void> {
    const dir = await cacheDirectory();
    const metadataBytes = 4 + seeds.length * 4;
    const size = HEADER_BYTES + metadataBytes + bytes.length;
    if (!dir || !bytes.length || size > DISK_BUDGET) return;
    try {
        await makeRoom(dir, key, size);
        const payload = new Uint8Array(metadataBytes + bytes.length);
        const view = new DataView(payload.buffer);
        view.setUint32(0, seeds.length, true);
        for (let i = 0; i < seeds.length; i++) view.setUint32(4 + i * 4, seeds[i]!, true);
        payload.set(bytes, metadataBytes);
        const hash = await crypto.subtle.digest("SHA-256", payload);
        await writeFile(dir, key, [hash, payload]);
        stats.writes++;
        stats.bytesWritten += bytes.byteLength;
    } catch { stats.writeErrors++; }
}

export async function getOrBuild(
    image: Uint8Array<ArrayBuffer>, modeKey: string,
    build: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer>> {
    const key = await peAotCacheKey(image, modeKey);
    const cached = await readPeAot(key);
    notePeAotLookup(cached?.bytes ?? null);
    if (cached) return cached.bytes;
    const bytes = await build();
    await writePeAot(key, bytes);
    return bytes;
}

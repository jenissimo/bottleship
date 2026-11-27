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

async function readEntry(dir: Directory, key: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    try {
        const file = await (await dir.getFileHandle(key)).getFile();
        if (file.size <= HEADER_BYTES || file.size > DISK_BUDGET) return;
        const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
        const payload = new Uint8Array(await file.slice(HEADER_BYTES).arrayBuffer());
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
        if (header.every((b, i) => b === hash[i])) return payload;
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

/** A translation is specific to the mapped image and the compiler/backend configuration. */
export async function getOrBuild(
    image: Uint8Array<ArrayBuffer>, modeKey: string,
    build: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer>> {
    const dir = await cacheDirectory();
    if (!dir) { stats.misses++; return build(); }
    const digest = await sha256Hex(image);
    const key = await sha256Hex(new TextEncoder().encode(modeKey + "/" + digest)) + ".wasm";
    const cached = await readEntry(dir, key);
    if (cached) {
        stats.hits++;
        stats.bytesRead += cached.byteLength;
        return cached;
    }
    stats.misses++;
    const bytes = await build();
    if (!bytes.length || bytes.length + HEADER_BYTES > DISK_BUDGET) return bytes;
    try {
        await makeRoom(dir, key, bytes.length + HEADER_BYTES);
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const handle = await dir.getFileHandle(key, {create: true});
        const writer = await handle.createWritable();
        try {
            await writer.write(hash);
            await writer.write(bytes);
            await writer.close();
        } catch (error) {
            await writer.abort().catch(() => {});
            throw error;
        }
        stats.writes++;
        stats.bytesWritten += bytes.byteLength;
    } catch { stats.writeErrors++; }
    return bytes;
}

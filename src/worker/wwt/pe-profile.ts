const MAX_ENTRIES = 65536;
type CodeRange = { start: number; end: number };

async function openDirectory(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    try {
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle("bottleship", { create });
        return await app.getDirectoryHandle("wwt-pe-profiles-v1", { create });
    } catch {
        return undefined;
    }
}

async function readRvas(dir: FileSystemDirectoryHandle, name: string): Promise<number[]> {
    try {
        const file = await (await dir.getFileHandle(name)).getFile();
        if (file.size > MAX_ENTRIES * 4 || file.size % 4) return [];
        return Array.from(new Uint32Array(await file.arrayBuffer()));
    } catch {
        return [];
    }
}

export async function peProfileEntries(digest: string, base: number, size: number): Promise<number[]> {
    const profiles = (globalThis as { __wwtPeProfile?: Record<string, unknown> }).__wwtPeProfile;
    const dir = profiles ? undefined : await openDirectory(false);
    const hints = profiles?.[digest] ?? (dir ? await readRvas(dir, digest) : []);
    if (!Array.isArray(hints) || hints.length > MAX_ENTRIES) return [];
    return [...new Set<number>(hints.filter(rva => Number.isSafeInteger(rva) && rva >= 0 && rva < size))]
        .sort((a, b) => a - b).map(rva => base + rva);
}

/** Record demand translations while the game runs. Disk operations stay outside the miss handler. */
export class PeProfileRecorder {
    private ranges: Array<CodeRange & { base: number; hash: string }> = [];
    private seen = new Map<string, Set<number>>();
    private dirty = new Set<string>();
    private timer?: ReturnType<typeof setTimeout>;
    private pending = Promise.resolve();

    watch(hash: string, base: number, ranges: CodeRange[]): void {
        if (!this.seen.has(hash)) this.seen.set(hash, new Set());
        for (const range of ranges) this.ranges.push({ ...range, hash, base });
    }

    miss(pc: number): void {
        for (let i = this.ranges.length - 1; i >= 0; i--) {
            const range = this.ranges[i];
            if (pc < range.start || pc >= range.end) continue;
            const rva = pc - range.base;
            const values = this.seen.get(range.hash)!;
            if (values.size >= MAX_ENTRIES || values.has(rva)) return;
            values.add(rva);
            this.dirty.add(range.hash);
            this.timer ??= setTimeout(() => { void this.flush(); }, 2500);
            return;
        }
    }

    flush(): Promise<void> {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (!this.dirty.size) return this.pending;
        const batch = Array.from(this.dirty, hash => [hash, [...this.seen.get(hash)!]] as const);
        this.dirty.clear();
        this.pending = this.pending.then(async () => {
            const dir = await openDirectory(true);
            if (!dir) return;
            for (const [hash, samples] of batch) {
                const merge = async () => {
                    const merged = new Set(await readRvas(dir, hash));
                    for (const rva of samples) {
                        if (merged.size >= MAX_ENTRIES) break;
                        merged.add(rva);
                    }
                    const handle = await dir.getFileHandle(hash, {create:true});
                    const writer = await handle.createWritable();
                    try {
                        await writer.write(new Uint8Array(Uint32Array.from(merged).sort().buffer));
                        await writer.close();
                    } catch (error) {
                        await writer.abort().catch(() => {});
                        throw error;
                    }
                };
                try {
                    if (navigator.locks) await navigator.locks.request("bottleship-wwt-profile-" + hash, merge);
                    else await merge();
                } catch { /* A quota error or an interrupted tab can lose hints. Demand translation covers them. */ }
            }
        });
        return this.pending;
    }

    reset(): void {
        void this.flush();
        this.ranges = [];
        this.seen.clear();
    }
}

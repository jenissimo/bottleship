import { type DlsCollection, parseDls } from "@bottleship/formats/dmusic/dls";
import { decodeCompressedWaves, hasCompressedWaves, parseSoundFont } from "@bottleship/formats/dmusic/sf2";
import { DEPLOYMENT_CONFIG_URL, loadDeploymentConfig } from "../../../deployment-config";
import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { decodeOggVorbis, webCodecsVorbisPresent } from "./vorbis-decode";

export const GM_DLS_PATHS = ["C:\\WINDOWS\\SYSTEM32\\DRIVERS\\GM.DLS", "C:\\WINDOWS\\SYSTEM\\GM.DLS"];
const MAX_BANK_BYTES = 256 * 1024 * 1024;
const DECODE_PARALLEL = 8;

// @transient(the General MIDI bank is read-only and the same for every session in this worker)
let sources: string[] | null = null;
// @transient(the General MIDI bank is read-only and the same for every session in this worker)
let sourcesPromise: Promise<string[]> | null = null;
// @transient(the General MIDI bank is read-only and the same for every session in this worker)
let bankPromise: Promise<DlsCollection | null> | null = null;
// @transient(the General MIDI bank is read-only and the same for every session in this worker)
let bank: DlsCollection | null = null;
// @transient(the General MIDI bank is read-only and the same for every session in this worker)
const listeners = new Set<(bank: DlsCollection) => void>();

export function readGuestFile(paths: string[], maxBytes = MAX_BANK_BYTES): Uint8Array | null {
    const vfs = System.getInstance().fileSystem;
    for (const path of paths) {
        try {
            const size = vfs.getFileSize(path);
            if (size <= 0 || size > maxBytes) continue;
            const handle = vfs.openSync(path, 0x80000000, 3);
            if (!handle) continue;
            const out = new Uint8Array(size);
            let at = 0;
            while (at < size) {
                const chunk = vfs.readSync(handle, Math.min(size - at, 4 * 1024 * 1024));
                if (!chunk || chunk.length === 0) break;
                out.set(chunk, at);
                at += chunk.length;
            }
            if (at === size) return out;
        } catch (e) {
            void e;
        }
    }
    return null;
}

export function prefetchGmBankSources(): Promise<string[]> {
    if (sourcesPromise) return sourcesPromise;
    sourcesPromise = loadDeploymentConfig().then((config) => {
        const base = new URL(DEPLOYMENT_CONFIG_URL, self.location.href);
        sources = (config.soundFonts ?? []).filter((s) => typeof s === "string" && s.length > 0)
            .map((s) => new URL(s, base).href);
        return sources;
    }).catch(() => (sources = []));
    return sourcesPromise;
}

export function gmBankAvailable(): boolean {
    if (bank) return true;
    if (sources && sources.length > 0) return true;
    const vfs = System.getInstance().fileSystem;
    return GM_DLS_PATHS.some((p) => {
        try { return vfs.getFileSize(p) > 0; } catch { return false; }
    });
}

export function currentGmBank(): DlsCollection | null {
    return bank;
}

export function onGmBank(listener: (bank: DlsCollection) => void): () => void {
    if (bank) listener(bank);
    else listeners.add(listener);
    return () => listeners.delete(listener);
}

export function resetGmBankForTests(): void {
    sources = null;
    sourcesPromise = null;
    bankPromise = null;
    bank = null;
    listeners.clear();
}

async function decodeAll(collection: DlsCollection): Promise<boolean> {
    let ok = true;
    const pending = collection.waves.map((w, i) => ({ w, i })).filter(({ w }) => w && w.formatTag !== 1);
    const work = async (): Promise<void> => {
        for (let next = pending.shift(); next; next = pending.shift()) {
            const one: DlsCollection = { ...collection, waves: [next.w] };
            await decodeCompressedWaves(one, (ogg) => decodeOggVorbis(ogg));
            if (!one.waves[0]) ok = false;
            collection.waves[next.i] = one.waves[0] ?? null;
        }
    };
    await Promise.all(Array.from({ length: DECODE_PARALLEL }, work));
    return ok;
}

async function fromUrl(url: string): Promise<DlsCollection | null> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const parsed = parseSoundFont(bytes) ?? parseDls(bytes);
    if (!parsed) throw new Error("not a SoundFont or DLS bank");
    if (hasCompressedWaves(parsed)) {
        if (!webCodecsVorbisPresent()) throw new Error("no Vorbis decoder in this browser");
        const first = parsed.waves.find((w) => w && w.formatTag !== 1);
        if (first && !(await decodeOggVorbis(first.data))) throw new Error("Vorbis decoding unsupported");
        if (!(await decodeAll(parsed))) Logger.warn(LogCategory.SYSTEM, `[GM bank] ${url}: some samples did not decode and stay silent`);
    }
    return parsed;
}

async function load(): Promise<DlsCollection | null> {
    const local = readGuestFile(GM_DLS_PATHS);
    const fromBundle = local ? parseDls(local) : null;
    if (fromBundle && fromBundle.instruments.length > 0) {
        Logger.log(LogCategory.SYSTEM, `[GM bank] gm.dls from the bundle: ${fromBundle.instruments.length} instruments`);
        return fromBundle;
    }
    for (const url of await prefetchGmBankSources()) {
        const started = Date.now();
        try {
            const collection = await fromUrl(url);
            if (collection && collection.instruments.length > 0) {
                Logger.log(LogCategory.SYSTEM,
                    `[GM bank] ${url}: ${collection.instruments.length} instruments in ${Date.now() - started} ms`);
                return collection;
            }
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[GM bank] ${url} unusable: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    Logger.log(LogCategory.SYSTEM, "[GM bank] none available: General MIDI output stays silent");
    return null;
}

export function loadGmBank(): Promise<DlsCollection | null> {
    if (!bankPromise) {
        bankPromise = load().then((loaded) => {
            bank = loaded;
            if (loaded) for (const l of [...listeners]) l(loaded);
            listeners.clear();
            return loaded;
        });
    }
    return bankPromise;
}

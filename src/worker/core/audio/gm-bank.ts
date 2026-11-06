import { type DlsCollection, type DlsInstrument, type DlsWave, parseDls } from "@bottleship/formats/dmusic/dls";
import { hasCompressedWaves, parseSoundFont } from "@bottleship/formats/dmusic/sf2";
import { DEPLOYMENT_CONFIG_URL, loadDeploymentConfig } from "../../../deployment-config";
import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { setWaveDecoder } from "./directmusic/synth";
import { decodeOggVorbisBatch, webCodecsVorbisPresent } from "./vorbis-decode";

export const GM_DLS_PATHS = ["C:\\WINDOWS\\SYSTEM32\\DRIVERS\\GM.DLS", "C:\\WINDOWS\\SYSTEM\\GM.DLS"];
const MAX_BANK_BYTES = 256 * 1024 * 1024;
const DECODE_BATCH = 32;
const BACKGROUND_DECODE_DELAY_MS = 3000;

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
    decoding.clear();
    instrumentDecodes.clear();
    progressListeners.clear();
    setWaveDecoder(null);
}

// @transient(decodes of the read-only bank, shared by every session in this worker)
const decoding = new Map<DlsWave, Promise<void>>();

function decodeWaves(collection: DlsCollection, indices: number[]): Promise<void> {
    const todo = indices.filter((index) => {
        const wave = collection.waves[index];
        return wave && wave.formatTag !== 1 && !decoding.has(wave);
    });
    const waves = todo.map((index) => collection.waves[index]!);
    if (todo.length > 0) {
        const batch = decodeOggVorbisBatch(waves.map((w) => w.data)).then((pcms) => {
            todo.forEach((index, n) => {
                if (collection.waves[index] !== waves[n]) return;
                const pcm = pcms[n];
                collection.waves[index] = pcm
                    ? { ...waves[n]!, formatTag: 1, data: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) }
                    : null;
            });
        });
        for (const wave of waves) decoding.set(wave, batch);
    }
    const pending = indices.map((index) => collection.waves[index]).filter((w): w is DlsWave => !!w && decoding.has(w)).map((w) => decoding.get(w)!);
    return Promise.all(pending).then(() => undefined);
}

// @transient(decodes of the read-only bank, shared by every session in this worker)
const instrumentDecodes = new Map<DlsInstrument, Promise<void>>();
// @transient(subscribers to a running decode; they only refresh synth channels)
const progressListeners = new Map<DlsInstrument, Set<() => void>>();

function decodeInstrument(collection: DlsCollection, inst: DlsInstrument, progress: () => void): Promise<void> {
    let listeners = progressListeners.get(inst);
    if (!listeners) progressListeners.set(inst, listeners = new Set());
    listeners.add(progress);
    let pending = instrumentDecodes.get(inst);
    if (!pending) {
        pending = (async () => {
            const started = Date.now();
            const indices = [...new Set(inst.regions.map((r) => r.waveIndex))];
            for (let i = 0; i < indices.length; i += DECODE_BATCH) {
                await decodeWaves(collection, indices.slice(i, i + DECODE_BATCH));
                for (const notify of progressListeners.get(inst) ?? []) notify();
            }
            progressListeners.delete(inst);
            Logger.log(LogCategory.SYSTEM, `[GM bank] "${inst.name}": ${indices.length} samples ready in ${Date.now() - started} ms`);
        })();
        instrumentDecodes.set(inst, pending);
    }
    return pending;
}

async function decodeRest(collection: DlsCollection): Promise<void> {
    for (const inst of collection.instruments) {
        await decodeInstrument(collection, inst, () => undefined);
    }
}

async function fromUrl(url: string): Promise<DlsCollection | null> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const parsed = parseSoundFont(bytes) ?? parseDls(bytes);
    if (!parsed) throw new Error("not a SoundFont or DLS bank");
    if (hasCompressedWaves(parsed)) {
        if (!webCodecsVorbisPresent()) throw new Error("no Vorbis decoder in this browser");
        const first = parsed.waves.findIndex((w) => w && w.formatTag !== 1);
        if (first >= 0) {
            await decodeWaves(parsed, [first]);
            if (!parsed.waves[first]) throw new Error("Vorbis decoding unsupported");
        }
        setWaveDecoder(decodeInstrument);
        setTimeout(() => void decodeRest(parsed), BACKGROUND_DECODE_DELAY_MS);
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

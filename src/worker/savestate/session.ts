import { savestateParticipants, uncoveredModules, type CaptureContext, type CpuOverride, type ParticipantRegistry } from './participant';
import { restoreRam, snapshotRam, validateRamManifest, type RamCaptureStats, type RamManifest, type RamPatch } from './ram';
import type { ChunkStore } from './chunk-store';
import {
    decodeSavestate, encodeSavestate, incompatibilities, type CompatibilityKey, type Savestate,
} from './container';
import { encodeValue, type SaveValue } from './value-codec';
import { CaptureRefusal, newObjectGraph, restoreObjectGraph } from './object-codecs';
import { BLOBS, loadBlobs, missingBlobs, savedBlobs, type BlobList } from './blobs';

const OBJECTS = '$objects';

export interface SavestateTarget {
    guestMemory(): Uint8Array;
    compatibilityKey(): CompatibilityKey;
    overlayState(): string;
    gameId(): string;
    touchedModules(): Iterable<string>;
}

export interface CaptureRun extends CaptureContext {
    readonly objects: Array<[string, SaveValue]>;
    readonly blobs: ReadonlyMap<string, Uint8Array>;
    readonly ramPatches: readonly RamPatch[];
}

export function newCaptureRun(): CaptureRun {
    const graph = newObjectGraph();
    const ramPatches: RamPatch[] = [];
    let cpu: CpuOverride | null = null;
    return {
        objects: graph.objects,
        blobs: graph.blobs,
        ramPatches,
        ref: (obj, where) => graph.ref(obj, where),
        blob: (bytes) => graph.blob(bytes),
        patchRam: (address, bytes) => { ramPatches.push({ address, bytes: [...bytes] }); },
        overrideCpu: (regs) => {
            if (cpu) throw new CaptureRefusal('savestate: two threads claim the live CPU');
            cpu = { ...regs };
        },
        cpuOverride: () => cpu,
    };
}

export interface CaptureResult {
    bytes: Uint8Array;
    manifest: RamManifest;
    pending: Map<string, Uint8Array>;
    blobs: BlobList;
    ram: RamCaptureStats;
    sections: Record<string, number>;
    captureMs: Record<string, number>;
    ramHashMs: number;
}

export function coverageRefusal(target: Pick<SavestateTarget, 'touchedModules'>, participants: ParticipantRegistry = savestateParticipants): string | null {
    const missing = uncoveredModules(target.touchedModules(), participants.coveredModules());
    return missing.length > 0 ? `savestate: no participant captures ${missing.join(', ')}` : null;
}

export async function captureSession(
    target: SavestateTarget, known: ReadonlySet<string>, stillReady: () => void = () => undefined,
    participants: ParticipantRegistry = savestateParticipants,
): Promise<CaptureResult> {
    const refusal = coverageRefusal(target, participants);
    if (refusal) throw new CaptureRefusal(refusal);
    for (const p of participants.all()) await p.prepare?.();
    stillReady();
    const sections = new Map<string, SaveValue>();
    const sizes: Record<string, number> = {};
    const captureMs: Record<string, number> = {};
    const run = newCaptureRun();
    for (const p of participants.all()) {
        const started = performance.now();
        const value = p.capture(run);
        captureMs[p.id] = Math.round((performance.now() - started) * 10) / 10;
        sections.set(p.id, value);
        const enc = encodeValue(value);
        sizes[p.id] = enc.json.length + enc.blobs.reduce((n, b) => n + b.length, 0);
    }
    sections.set(OBJECTS, run.objects as unknown as SaveValue);
    const blobs: BlobList = [...run.blobs].map(([hash, bytes]) => [hash, bytes.byteLength] as [string, number]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (blobs.length > 0) sections.set(BLOBS, blobs);
    const t0 = performance.now();
    const snap = snapshotRam(target.guestMemory(), known, run.ramPatches);
    const ramHashMs = performance.now() - t0;
    for (const [hash, bytes] of run.blobs) if (!known.has(hash)) snap.pending.set(hash, bytes);
    stillReady();
    const state: Savestate = {
        header: {
            key: target.compatibilityKey(), overlay: target.overlayState(),
            createdAt: Date.now(), gameId: target.gameId(), ram: snap.manifest,
        },
        sections,
    };
    return { bytes: encodeSavestate(state), manifest: snap.manifest, pending: snap.pending, blobs, ram: snap.stats, sections: sizes, captureMs, ramHashMs };
}

export interface LoadCheck { ok: boolean; reasons: string[]; overlayChanged: boolean; state: Savestate }

export function checkSavestate(target: SavestateTarget, bytes: Uint8Array): LoadCheck {
    const state = decodeSavestate(bytes);
    const reasons = incompatibilities(state.header.key, target.compatibilityKey());
    if (state.header.gameId !== target.gameId()) reasons.unshift(`snapshot is for ${state.header.gameId}`);
    return { ok: reasons.length === 0, reasons, overlayChanged: state.header.overlay !== target.overlayState(), state };
}

export class RestoreFailed extends Error {}

export async function missingChunks(manifest: RamManifest, store: ChunkStore): Promise<string[]> {
    const present = new Set(await store.list());
    const out: string[] = [];
    for (const [, hash] of manifest.chunks) {
        if (!present.has(hash) || (await store.size(hash)) <= 1) out.push(hash);
    }
    return out;
}

/**
 * Nothing is written until every chunk the manifest names is present, every blob is read
 * and verified, and every participant has verified its section. After the first write, any failure is a RestoreFailed: the guest is half
 * restored and must not run.
 */
export async function restoreSession(
    target: SavestateTarget, state: Savestate, store: ChunkStore, participants: ParticipantRegistry = savestateParticipants,
): Promise<void> {
    validateRamManifest(state.header.ram, target.guestMemory().length);
    const missing = await missingChunks(state.header.ram, store);
    if (missing.length > 0) throw new Error(`savestate: ${missing.length} RAM chunk(s) are missing, e.g. ${missing[0]}`);
    const list = savedBlobs(state);
    const missingBlob = await missingBlobs(list, store);
    if (missingBlob.length > 0) throw new Error(`savestate: ${missingBlob.length} blob(s) are missing, e.g. ${missingBlob[0]}`);
    const blobs = await loadBlobs(list, store);
    const blob = restoreObjectGraph([], blobs).blob;
    for (const p of participants.all()) {
        const value = state.sections.get(p.id);
        if (value !== undefined) await p.verify?.(value, blob);
    }
    try {
        await restoreWritten(target, state, store, participants, blobs);
    } catch (e) {
        throw new RestoreFailed(e instanceof Error ? e.message : String(e));
    }
}

async function restoreWritten(
    target: SavestateTarget, state: Savestate, store: ChunkStore, participants: ParticipantRegistry, blobs: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
    await restoreRam(target.guestMemory(), state.header.ram, store);
    const ctx = restoreObjectGraph((state.sections.get(OBJECTS) ?? []) as unknown as Array<[string, SaveValue]>, blobs);
    for (const p of participants.all()) {
        const value = state.sections.get(p.id);
        if (value === undefined) throw new Error(`savestate: no section for participant ${p.id}`);
        await p.restore(value, ctx);
    }
}

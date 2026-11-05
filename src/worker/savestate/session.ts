import { savestateParticipants, uncoveredModules, type CaptureContext, type CpuOverride } from './participant';
import { restoreRam, snapshotRam, type RamCaptureStats, type RamPatch } from './ram';
import type { ChunkStore } from './chunk-store';
import {
    decodeSavestate, encodeSavestate, incompatibilities, type CompatibilityKey, type Savestate,
} from './container';
import { encodeValue, type SaveValue } from './value-codec';
import { CaptureRefusal, newObjectGraph, restoreObjectGraph } from './object-codecs';

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
    readonly ramPatches: readonly RamPatch[];
}

export function newCaptureRun(): CaptureRun {
    const graph = newObjectGraph();
    const ramPatches: RamPatch[] = [];
    let cpu: CpuOverride | null = null;
    return {
        objects: graph.objects,
        ramPatches,
        ref: (obj, where) => graph.ref(obj, where),
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
    pending: Map<string, Uint8Array>;
    ram: RamCaptureStats;
    sections: Record<string, number>;
}

export async function captureSession(target: SavestateTarget, known: ReadonlySet<string>, stillReady: () => void = () => undefined): Promise<CaptureResult> {
    const missing = uncoveredModules(target.touchedModules(), savestateParticipants.coveredModules());
    if (missing.length > 0) throw new CaptureRefusal(`savestate: no participant captures ${missing.join(', ')}`);
    const sections = new Map<string, SaveValue>();
    const sizes: Record<string, number> = {};
    const run = newCaptureRun();
    for (const p of savestateParticipants.all()) {
        const value = p.capture(run);
        sections.set(p.id, value);
        const enc = encodeValue(value);
        sizes[p.id] = enc.json.length + enc.blobs.reduce((n, b) => n + b.length, 0);
    }
    sections.set(OBJECTS, run.objects as unknown as SaveValue);
    const snap = await snapshotRam(target.guestMemory(), known, run.ramPatches);
    stillReady();
    const state: Savestate = {
        header: {
            key: target.compatibilityKey(), overlay: target.overlayState(),
            createdAt: Date.now(), gameId: target.gameId(), ram: snap.manifest,
        },
        sections,
    };
    return { bytes: encodeSavestate(state), pending: snap.pending, ram: snap.stats, sections: sizes };
}

export interface LoadCheck { ok: boolean; reasons: string[]; overlayChanged: boolean; state: Savestate }

export function checkSavestate(target: SavestateTarget, bytes: Uint8Array): LoadCheck {
    const state = decodeSavestate(bytes);
    const reasons = incompatibilities(state.header.key, target.compatibilityKey());
    if (state.header.gameId !== target.gameId()) reasons.unshift(`snapshot is for ${state.header.gameId}`);
    return { ok: reasons.length === 0, reasons, overlayChanged: state.header.overlay !== target.overlayState(), state };
}

export async function restoreSession(target: SavestateTarget, state: Savestate, store: ChunkStore): Promise<void> {
    await restoreRam(target.guestMemory(), state.header.ram, store);
    const ctx = restoreObjectGraph((state.sections.get(OBJECTS) ?? []) as unknown as Array<[string, SaveValue]>);
    for (const p of savestateParticipants.all()) {
        const value = state.sections.get(p.id);
        if (value === undefined) throw new Error(`savestate: no section for participant ${p.id}`);
        await p.restore(value, ctx);
    }
}

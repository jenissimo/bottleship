import { System } from '../core/system';
import { Logger, LogCategory } from '../core/logger';
import { OpfsChunkStore, sha256Hex } from './chunk-store';
import { writeRamChunks } from './ram';
import { captureSession, checkSavestate, coverageRefusal, restoreSession, RestoreFailed, type SavestateTarget } from './session';
import { CaptureRefusal } from './object-codecs';
import type { ChunkStore } from './chunk-store';
import type { SafePoint } from './halt';
import { savestateParticipants, savestatesEnabled, type ParticipantRegistry } from './participant';
import { coverageModules } from './core-participants';
import { incompatibilities, type CompatibilityKey } from './container';
import { OpfsDir, SlotStore, type Dir, type SlotInfo } from './slots';
import { gameIdToContainerDir } from '@bottleship/formats/wgb/container-id';
import { WGB_BLOCK_INDEX_ENTRY } from '@bottleship/formats/zip';

declare const __BUILD_SHA__: string;

export interface BootIdentity {
    gameId: string;
    contentHash: string;
    configHash: string;
    bootLayout: string;
}

/** @transient(identity of the current boot, recomputed at every entry point) */
let boot: BootIdentity | null = null;

const text = (s: string) => new TextEncoder().encode(s);

/** @transient(text of the last entry-point failure, named by every later save or load) */
let bootError = '';


export function noteBootError(message: string): void { bootError = message; }


const safeJson = (v: unknown): string => {
    try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? ''; } catch { return ''; }
};

export interface BundleEntryKey { name: string; size: number; crc32?: number }

const HOST_ONLY_CONFIG = ['quality', 'qualityUserPref', 'network'];

export function guestConfig(config: Record<string, unknown>): Record<string, unknown> {
    const out = { ...config };
    for (const key of HOST_ONLY_CONFIG) delete out[key];
    return out;
}

function isPackingOnlyEntry(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === 'manifest.json' || lower === WGB_BLOCK_INDEX_ENTRY;
}

function withoutBlockIndex(manifest: unknown): unknown {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest;
    const { blockIndex: _blockIndex, ...rest } = manifest as Record<string, unknown>;
    return rest;
}

export async function noteBootIdentity(input: {
    gameId: string; manifest: unknown; entries: BundleEntryKey[]; config: Record<string, unknown>; layout: unknown;
}): Promise<BootIdentity> {
    const entries = input.entries.filter(e => !isPackingOnlyEntry(e.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(e => [e.name, e.size, e.crc32 ?? null]);
    boot = {
        gameId: input.gameId,
        contentHash: await sha256Hex(text(safeJson([withoutBlockIndex(input.manifest), entries]))),
        configHash: await sha256Hex(text(safeJson(guestConfig(input.config)))),
        bootLayout: await sha256Hex(text(safeJson(input.layout))),
    };
    return boot;
}

export { savestatesEnabled };

function requireEnabled(): void {
    if (!savestatesEnabled()) throw new Error('savestate: disabled (set the worker flag __savestates before loading the game)');
}

function requireBoot(): BootIdentity {
    requireEnabled();
    if (!boot) throw new Error(bootError ? `savestate: ${bootError}` : 'savestate: no boot identity (the game has not reached its entry point)');
    return boot;
}

function target(overlay: string): SavestateTarget {
    const identity = requireBoot();
    return {
        guestMemory: () => {
            const process = System.getInstance().process;
            if (!process) throw new Error('savestate: no process');
            return process.getCurrentMemory();
        },
        compatibilityKey: (): CompatibilityKey => ({
            buildSha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev',
            contentHash: identity.contentHash,
            configHash: identity.configHash,
            bootLayout: identity.bootLayout,
            participants: savestateParticipants.schemas(),
        }),
        overlayState: () => overlay,
        gameId: () => identity.gameId,
        touchedModules: () => coverageModules(),
    };
}

async function overlayDigest(): Promise<string> {
    return sha256Hex(text((await System.getInstance().fileSystem.describeOverlay()).join('\n')));
}

/** @transient(in-flight save/delete/collect operations per game, serialised so a collection never runs inside a save) */
const gameLocks = new Map<string, Promise<unknown>>();

export async function withGameLock<T>(game: string, run: () => Promise<T>): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: { request<R>(name: string, cb: () => Promise<R>): Promise<R> } } }).navigator?.locks;
    const guarded = locks ? () => locks.request(`savestate:${game}`, run) : run;
    const previous = gameLocks.get(game) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(guarded);
    gameLocks.set(game, next);
    try {
        return await next;
    } finally {
        if (gameLocks.get(game) === next) gameLocks.delete(game);
    }
}

const SLOT_NAME = /^[a-z0-9_-]{1,32}$/i;

function checkSlotName(slot: string): string {
    if (!SLOT_NAME.test(slot)) throw new Error(`savestate: bad slot name ${slot}`);
    return slot;
}

function gameDir(): string {
    return gameIdToContainerDir(requireBoot().gameId);
}

export interface SavestateStorage {
    gameDir(game: string): Promise<Dir>;
    chunks(game: string): Promise<ChunkStore>;
}

const STORAGE_ROOT = ['bottleship', 'savestates'];

const opfsStorage: SavestateStorage = {
    gameDir: (game) => OpfsDir.open([...STORAGE_ROOT, game]),
    chunks: (game) => OpfsChunkStore.open([...STORAGE_ROOT, game, 'chunks']),
};

export async function openGameStore(storage: SavestateStorage, game: string): Promise<SlotStore> {
    const dir = await storage.gameDir(game);
    const slots = await dir.dir('slots', true);
    if (!slots) throw new Error(`savestate: no slot directory for ${game}`);
    return new SlotStore(slots, await storage.chunks(game));
}

const gameStore = (game: string) => openGameStore(opfsStorage, game);

const PENDING = 'pending-load.json';
export const PENDING_TTL_MS = 15 * 60 * 1000;

export async function writePendingLoad(storage: SavestateStorage, game: string, slot: string, now: number): Promise<void> {
    await (await storage.gameDir(game)).write(PENDING, text(JSON.stringify({ slot, at: now })));
}

export async function requestLoadOnNextBoot(slot: string): Promise<void> {
    const game = gameDir();
    if (!(await (await gameStore(game)).read(checkSlotName(slot)))) throw new Error(`savestate: slot ${slot} is empty`);
    await writePendingLoad(opfsStorage, game, slot, Date.now());
}

export type PendingLoadOutcome =
    | { kind: 'none' }
    | { kind: 'needs-fresh-worker'; slot: string }
    | { kind: 'expired'; slot: string }
    | { kind: 'restored'; name: string; ms: number; overlayChanged: boolean };

export interface PendingLoadInput {
    participants?: ParticipantRegistry;
    storage: SavestateStorage;
    game: string;
    target: SavestateTarget;
    freshWorker: boolean;
    now: number;
}

/**
 * Runs the pending load of this game, if any. The pending file belongs to the game; a boot of
 * another game never sees it. A load is only attempted in a worker whose first boot this is;
 * otherwise the request stays for the next fresh worker. Anything thrown before the first
 * write leaves the guest untouched; a RestoreFailed means it is half restored.
 */
export function runPendingLoad(input: PendingLoadInput): Promise<PendingLoadOutcome> {
    return withGameLock(input.game, () => runPendingLoadLocked(input));
}

async function runPendingLoadLocked(input: PendingLoadInput): Promise<PendingLoadOutcome> {
    const dir = await input.storage.gameDir(input.game);
    const bytes = await dir.read(PENDING);
    if (!bytes) return { kind: 'none' };
    let pending: { slot?: unknown; at?: unknown };
    try { pending = JSON.parse(new TextDecoder().decode(bytes)) as typeof pending; } catch { pending = {}; }
    const slot = typeof pending.slot === 'string' ? pending.slot : '';
    if (!input.freshWorker) {
        Logger.warn(LogCategory.SYSTEM, `[SAVESTATE] load of ${slot} needs a fresh worker (reload the tab); the request stays pending`);
        return { kind: 'needs-fresh-worker', slot };
    }
    await dir.remove(PENDING);
    const at = typeof pending.at === 'number' ? pending.at : 0;
    if (!(input.now - at >= 0 && input.now - at <= PENDING_TTL_MS)) return { kind: 'expired', slot };
    const name = checkSlotName(slot);
    const store = await openGameStore(input.storage, input.game);
    const state = await store.read(name);
    if (!state) throw new Error(`savestate: slot ${name} is empty`);
    const t0 = performance.now();
    const check = checkSavestate(input.target, state);
    if (!check.ok) throw new Error(`savestate ${name} does not fit this boot: ${check.reasons.join('; ')}`);
    if (check.overlayChanged) Logger.warn(LogCategory.SYSTEM, `[SAVESTATE] ${name}: the game's files changed since it was taken`);
    await restoreSession(input.target, check.state, store.chunkStore, input.participants);
    return { kind: 'restored', name, ms: Math.round(performance.now() - t0), overlayChanged: check.overlayChanged };
}

export type LastLoad = PendingLoadOutcome | { kind: 'refused'; error: string } | { kind: 'failed'; error: string };

/** @transient(outcome of this worker's entry-point load, reported by savestateLastLoad) */
let lastLoadOutcome: LastLoad | null = null;

export function lastLoad(): LastLoad | null {
    requireEnabled();
    return lastLoadOutcome;
}

export async function listSlots(): Promise<{ gameId: string; game: string; slots: SlotInfo[] }> {
    const game = gameDir();
    const t = target('');
    const list = await (await gameStore(game)).list((state) => {
        const reasons = incompatibilities(state.header.key, t.compatibilityKey());
        if (state.header.gameId !== t.gameId()) reasons.unshift('other game');
        return reasons;
    });
    return { gameId: t.gameId(), game, slots: list };
}

export async function deleteSlot(slot: string): Promise<{ removedChunks: number }> {
    const game = gameDir();
    checkSlotName(slot);
    return withGameLock(game, async () => ({ removedChunks: await (await gameStore(game)).remove(slot) }));
}

export interface SaveReport {
    name: string; bytes: number; chunkBytes: number; chunkWrites: number;
    ms: { paused: number; ramHash: number; store: number }; sections: Record<string, number>; captureMs: Record<string, number>; ram: unknown;
}

export async function saveToSlot(name: string, halt: () => Promise<SafePoint>, permanentBlockers: () => string[] = () => []): Promise<SaveReport> {
    checkSlotName(name);
    const game = gameDir();
    const early = coverageRefusal({ touchedModules: coverageModules }) ?? permanentBlockers().map(b => `savestate: ${b}`)[0] ?? null;
    if (early) throw new CaptureRefusal(early);
    return withGameLock(game, async () => {
        const store = await gameStore(game);
        const known = new Set(await store.chunkStore.list());
        const t = target(await overlayDigest());
        const t0 = performance.now();
        const safe = await halt();
        let result;
        try {
            result = await captureSession(t, known, () => safe.stillReady());
        } finally {
            safe.release();
        }
        const t1 = performance.now();
        await writeRamChunks(result.pending, store.chunkStore);
        let chunkBytes = 0;
        for (const [, hash] of result.manifest.chunks) chunkBytes += await store.chunkStore.size(hash);
        for (const [hash] of result.blobs) chunkBytes += await store.chunkStore.size(hash);
        await store.save(name, result.bytes, chunkBytes);
        const t2 = performance.now();
        return {
            name, bytes: result.bytes.length, chunkBytes, chunkWrites: result.ram.written,
            ms: { paused: Math.round(t1 - t0), ramHash: Math.round(result.ramHashMs), store: Math.round(t2 - t1) }, sections: result.sections, captureMs: result.captureMs, ram: result.ram,
        };
    });
}

export async function restorePendingAtEntry(freshWorker: boolean): Promise<PendingLoadOutcome> {
    lastLoadOutcome = null;
    try {
        const outcome = await runPendingLoad({ storage: opfsStorage, game: gameDir(), target: target(await overlayDigest()), freshWorker, now: Date.now() });
        lastLoadOutcome = outcome;
        if (outcome.kind === 'restored') Logger.log(LogCategory.SYSTEM, `[SAVESTATE] restored ${outcome.name} in ${outcome.ms} ms`);
        return outcome;
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (e instanceof RestoreFailed) {
            lastLoadOutcome = { kind: 'failed', error };
            boot = null;
            bootError = `the load failed after it started writing, so this session cannot be saved: ${error}`;
        } else {
            lastLoadOutcome = { kind: 'refused', error };
        }
        throw e;
    }
}

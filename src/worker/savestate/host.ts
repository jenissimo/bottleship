import { System } from '../core/system';
import { Logger, LogCategory } from '../core/logger';
import { OpfsChunkStore, sha256Hex } from './chunk-store';
import { writeRamChunks } from './ram';
import { captureSession, checkSavestate, restoreSession, type SavestateTarget } from './session';
import { savestateParticipants } from './participant';
import { touchedModules } from './core-participants';
import { decodeSavestate, incompatibilities, type CompatibilityKey } from './container';
import { OpfsDir, SlotStore, type SlotInfo } from './slots';
import { gameIdToContainerDir } from '@bottleship/formats/wgb/container-id';

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

export async function noteBootIdentity(input: {
    gameId: string; manifest: unknown; bundleSize: number; config: unknown; layout: unknown;
}): Promise<BootIdentity> {
    boot = {
        gameId: input.gameId,
        contentHash: await sha256Hex(text(safeJson([input.manifest, input.bundleSize]))),
        configHash: await sha256Hex(text(safeJson(input.config))),
        bootLayout: await sha256Hex(text(safeJson(input.layout))),
    };
    return boot;
}

export function savestatesEnabled(): boolean {
    return (globalThis as { __savestates?: unknown }).__savestates === true;
}

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
        touchedModules: () => touchedModules(),
    };
}

async function overlayDigest(): Promise<string> {
    return sha256Hex(text((await System.getInstance().fileSystem.describeOverlay()).join('\n')));
}

/** @transient(in-flight save/delete/collect operations per game, serialised so a collection never runs inside a save) */
const gameLocks = new Map<string, Promise<unknown>>();

export async function withGameLock<T>(game: string, run: () => Promise<T>): Promise<T> {
    const previous = gameLocks.get(game) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
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

async function gameStore(game: string): Promise<SlotStore> {
    return new SlotStore(await OpfsDir.open(['savestates', game, 'slots']), await OpfsChunkStore.open(['savestates', game, 'chunks']));
}

const PENDING = 'pending-load.json';

export async function requestLoadOnNextBoot(slot: string): Promise<void> {
    const game = gameDir();
    if (!(await (await gameStore(game)).read(checkSlotName(slot)))) throw new Error(`savestate: slot ${slot} is empty`);
    await (await OpfsDir.open(['savestates'])).write(PENDING, text(JSON.stringify({ game, slot, at: Date.now() })));
}

async function takePendingLoad(): Promise<{ game: string; slot: string } | null> {
    const root = await OpfsDir.open(['savestates']);
    const bytes = await root.read(PENDING);
    if (!bytes) return null;
    await root.remove(PENDING);
    try { return JSON.parse(new TextDecoder().decode(bytes)) as { game: string; slot: string }; } catch { return null; }
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

export interface SafePoint {
    release(): void;
    stillReady(): void;
}

export interface SaveReport {
    name: string; bytes: number; chunkBytes: number; chunkWrites: number;
    ms: { paused: number; store: number }; sections: Record<string, number>; ram: unknown;
}

export async function saveToSlot(name: string, halt: () => Promise<SafePoint>): Promise<SaveReport> {
    checkSlotName(name);
    const game = gameDir();
    return withGameLock(game, async () => {
        const store = await gameStore(game);
        const known = new Set(await store.chunkStore.list());
        const t0 = performance.now();
        const safe = await halt();
        let result;
        try {
            result = await captureSession(target(await overlayDigest()), known, () => safe.stillReady());
        } finally {
            safe.release();
        }
        const t1 = performance.now();
        await writeRamChunks(result.pending, store.chunkStore);
        const manifest = decodeSavestate(result.bytes).header.ram;
        let chunkBytes = 0;
        for (const [, hash] of manifest.chunks) chunkBytes += await store.chunkStore.size(hash);
        await store.save(name, result.bytes, chunkBytes);
        const t2 = performance.now();
        return {
            name, bytes: result.bytes.length, chunkBytes, chunkWrites: result.ram.written,
            ms: { paused: Math.round(t1 - t0), store: Math.round(t2 - t1) }, sections: result.sections, ram: result.ram,
        };
    });
}

export async function restorePendingAtEntry(): Promise<{ name: string; ms: number; overlayChanged: boolean } | null> {
    const pending = await takePendingLoad();
    if (!pending) return null;
    if (pending.game !== gameDir()) return null;
    const name = checkSlotName(pending.slot);
    const store = await gameStore(pending.game);
    const bytes = await store.read(name);
    if (!bytes) throw new Error(`savestate: slot ${name} is empty`);
    const t0 = performance.now();
    const t = target(await overlayDigest());
    const check = checkSavestate(t, bytes);
    if (!check.ok) throw new Error(`savestate ${name} does not fit this boot: ${check.reasons.join('; ')}`);
    if (check.overlayChanged) Logger.warn(LogCategory.SYSTEM, `[SAVESTATE] ${name}: the game's files changed since it was taken`);
    await restoreSession(t, check.state, store.chunkStore);
    const ms = Math.round(performance.now() - t0);
    Logger.log(LogCategory.SYSTEM, `[SAVESTATE] restored ${name} in ${ms} ms`);
    return { name, ms, overlayChanged: check.overlayChanged };
}

/**
 * Detour three exports of a real, guest-loaded `avcodec-*.dll` so video decode can be served
 * from WebCodecs (see avcodec-decode-hle.ts for the why and the contract).
 *
 * The exports are 5-byte `E9` thunks in these incrementally linked DLLs, so the patch targets
 * the body they jump to — and each patch carries a relocated-prologue trampoline, because every
 * handler here can DECLINE and must then be able to run the guest's own implementation.
 */

import { Logger, LogCategory } from '../../core/logger';
import { applyPatch, resolveExportBodyRva, type PatchContext } from '../../core/hle-lib/lib-patcher';
import { nativeModulePatcherDispatches, nativeModulePatcherIds } from '../../core/hooks/native-module-patchers';
import { toPlainGuestMemory } from '../../core/memory/guest-memory';
import type { LoadedPEModule } from '../../core/module-registry';
import type { Process } from '../../core/process';
import { VideoEngine } from '../../../video/video-engine';
import { measureAvcodecAbi } from './avcodec-abi';
import {
    declineToOriginal, makeDecodeVideo2Handler, onCodecClose, onFlushBuffers, probeCodecSupport,
    type DecodeHleState,
} from './avcodec-decode-hle';

/**
 * Bytes of each body's prologue to relocate into the trampoline. Measured on Lavc 56.1.100 and
 * re-validated at patch time: `applyPatch` decodes them and refuses the whole patch if the
 * length splits an instruction or the bytes are not position-independent.
 */
const PROLOGUE_LEN: Record<string, number> = {
    avcodec_decode_video2: 7,   // push ebp; mov ebp,esp; sub esp,0x54; push ebx
    avcodec_flush_buffers: 7,   // push ebp; mov ebp,esp; push esi; mov esi,[ebp+8]
    avcodec_close: 7,           // push ebp; mov ebp,esp; push esi; mov esi,[ebp+8]
};

let state: DecodeHleState | null = null;

export function isAvcodecModule(module: LoadedPEModule): boolean {
    return /^avcodec-\d+$/.test(module.name.toLowerCase());
}

/** Live counters for the harness / diagnostics. */
export function getFfmpegHleStats(): unknown {
    // The registry contents come first: "no patcher registered" and "registered but declined"
    // are different failures and look identical from `active: false` alone.
    const registered = nativeModulePatcherIds();
    if (!state) return { active: false, registered, dispatched: nativeModulePatcherDispatches() };
    return {
        active: !state.degraded,
        degraded: state.degraded,
        registered,
        abi: state.abi.version,
        sessions: state.sessions.size,
        refused: state.refused.size,
        support: Object.fromEntries(state.support),
        ...state.stats,
        // The reason a stream went back to the guest — the counters alone cannot say it.
        refusals: state.refusals,
    };
}

/**
 * Called from pe-loader once a real avcodec DLL is registered and its imports are bound.
 * Every failure path here leaves the guest's own decoder untouched.
 */
export function patchAvcodecModule(process: Process, module: LoadedPEModule): boolean {
    // A reload builds a new Process; the previous run's sessions and trampolines died with it.
    if (state && state.process !== process) state = null;
    if (!isAvcodecModule(module)) return false;
    if (state) {
        Logger.log(LogCategory.SYSTEM, `[ffmpeg-hle] already hooked for this process — ignoring ${module.name}`);
        return false;
    }
    // A/B lever: `setWorkerFlag('__noFfmpegHle', true)` before a load leaves the guest's own
    // decoder in place, so the same binary can measure both sides.
    if ((globalThis as { __noFfmpegHle?: boolean }).__noFfmpegHle) {
        Logger.log(LogCategory.SYSTEM, '[ffmpeg-hle] disabled by __noFfmpegHle — leaving the guest decoder alone');
        return false;
    }
    if (!VideoEngine.webCodecsAvailable()) {
        Logger.log(LogCategory.SYSTEM, '[ffmpeg-hle] WebCodecs is not available in this scope — leaving the guest decoder alone');
        return false;
    }

    const rawMem = process.getCurrentMemory();
    if (!rawMem) {
        Logger.warn(LogCategory.SYSTEM, '[ffmpeg-hle] guest memory unavailable at patch time — leaving the guest decoder alone');
        return false;
    }
    const mem = toPlainGuestMemory(rawMem);

    const avutil = process.moduleRegistry.getAllModules()
        .find((m) => /^avutil-\d+$/.test(m.name.toLowerCase()));
    const abi = measureAvcodecAbi(module, avutil, mem);
    if (!abi) return false;

    const next: DecodeHleState = {
        process, abi, degraded: false,
        trampolines: new Map(),
        sessions: new Map(),
        refused: new Set(),
        support: new Map(),
        stats: { served: 0, declined: 0, packets: 0, got0: 0, keyFlagMismatch: 0 },
        refusals: [],
    };

    const patchCtx: PatchContext = {
        dispatcher: process.dispatcher,
        thunkGenerator: process.thunkGenerator,
        getMemory: () => process.getCurrentMemory(),
    };

    const handlers: Record<string, (ctx: { esp: number }, mem: Uint8Array, args: number[]) => { value: number; skipStackCheck?: boolean }> = {
        avcodec_decode_video2: makeDecodeVideo2Handler(next),
        avcodec_flush_buffers: (ctx, m, args) => {
            onFlushBuffers(next, args[0]! >>> 0);
            return declineToOriginal(next, ctx, toPlainGuestMemory(m), 'avcodec_flush_buffers');
        },
        avcodec_close: (ctx, m, args) => {
            onCodecClose(next, args[0]! >>> 0);
            return declineToOriginal(next, ctx, toPlainGuestMemory(m), 'avcodec_close');
        },
    };

    // Every export is resolved BEFORE anything is patched: a missing one must cost no patch,
    // because a patch cannot be taken back (lib-patcher is one-way).
    const bodies = new Map<string, number>();
    for (const name of Object.keys(handlers)) {
        const exportAddr = module.exports.get(name);
        if (!exportAddr) {
            Logger.warn(LogCategory.SYSTEM, `[ffmpeg-hle] ${module.name} does not export ${name} — no patches applied`);
            return false;
        }
        bodies.set(name, module.baseAddress + resolveExportBodyRva(module, exportAddr - module.baseAddress));
    }

    const patched: string[] = [];
    for (const [name, handler] of Object.entries(handlers)) {
        const bodyAddr = bodies.get(name)!;
        const handle = applyPatch(patchCtx, {
            libId: 'ffmpeg',
            functionName: name,
            moduleName: module.name,
            targetAddress: bodyAddr,
            callingConvention: 'cdecl',
            handler,
            prologueLen: PROLOGUE_LEN[name],
        });
        // A hook without its trampoline cannot decline, and a decline it cannot honour would
        // silently drop a frame. The patches already applied cannot be undone, so the set is
        // abandoned by DECLINING from them: `degraded` makes every handler run the guest's own
        // body, which is the same observable behaviour as never having patched.
        if (!handle?.trampolineAddress) {
            Logger.warn(LogCategory.SYSTEM,
                `[ffmpeg-hle] could not patch ${name} — abandoning the hook set` +
                (patched.length ? ` (${patched.join(', ')} already patched; they will decline)` : ''));
            if (patched.length > 0) {
                next.degraded = true;
                state = next;
            }
            return false;
        }
        next.trampolines.set(name, handle.trampolineAddress);
        patched.push(name);
    }

    state = next;
    probeCodecSupport(next);
    Logger.log(LogCategory.SYSTEM,
        `[ffmpeg-hle] ${module.name} (Lavc ${abi.version}) hooked: ${patched.join(', ')}`);
    return true;
}

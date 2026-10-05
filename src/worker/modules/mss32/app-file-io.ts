/**
 * The app's own file I/O for Miles (AIL_set_file_callbacks), DRIVEN.
 *
 * A title whose assets live inside an archive installs four AILCALLBACKs so
 * Miles reads through ITS reader; the names it then asks for are not files and
 * no file system — ours or Windows' — can resolve them. Honouring the contract
 * means CALLING them, and they are guest code that itself calls kernel32, so
 * they cannot run inside the OUT trap: a nested v86 cycle loop (run_guest_until)
 * cannot service an async thunk, and a cold ReadFile is one. They run as
 * ORDINARY guest execution instead, on the suspended-thunk chain the
 * enumeration APIs already use — a thread that parks on a cold read simply
 * resumes and returns through its stub.
 *
 * ABI (Miles: every AILCALLBACK is __stdcall):
 *   U32  open(char const *Filename, U32 *FileHandle)   1 = ok, 0 = failure
 *   void close(U32 FileHandle)
 *   S32  seek(U32 FileHandle, S32 Offset, U32 Type)    0=begin 1=current 2=end
 *   U32  read(U32 FileHandle, void *Buffer, U32 Bytes) bytes actually read
 */

import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { MSSContext } from "./context";
import { getMemory, makeView } from "./helpers";

export const AIL_FILE_SEEK_BEGIN = 0;
export const AIL_FILE_SEEK_CURRENT = 1;
export const AIL_FILE_SEEK_END = 2;

/** Bytes per read callback. Large enough that a multi-MB stream costs a handful
 *  of round trips, small enough to keep one guest-visible buffer modest. */
const READ_CHUNK = 256 * 1024;

/** Refuse to whole-file a stream larger than this — a decode buffer that size is not
 *  a stream, and failing loudly beats silently truncating one. Sized to admit a
 *  CD-era encoded radio bank, which the browser decoder still takes as one buffer;
 *  the peak cost is roughly twice this while the chunks are copied into one array. */
const MAX_WHOLE_FILE = 96 * 1024 * 1024;

/** One guest call in a chain: stdcall `fn(args…)`, result delivered to the yield. */
export interface GuestCall {
    fn: number;
    args: number[];
    label: string;
}

/** A chain generator: yields calls, receives each callee's EAX, returns the value
 *  the suspended thunk finally hands back to the guest. */
export type GuestCallChain = Generator<GuestCall, number, number>;

export function hasAppFileCallbacks(ctx: MSSContext): boolean {
    const cb = ctx.fileCallbacks;
    return !!cb && cb.open !== 0 && cb.read !== 0 && cb.seek !== 0;
}

/**
 * Run `chain` as guest code and complete the calling thunk with its return value.
 *
 * Returns a suspended-thunk ThunkResult once the first call is in flight, or a
 * plain number when the chain finished (or could not start) without running any
 * guest code — in which case the thunk returns normally.
 */
export function runGuestCallChain(
    ctx: MSSContext,
    thunkCtx: any,
    stackCleanup: number,
    source: string,
    chain: GuestCallChain,
): ThunkResult | number {
    const cm = ctx.process?.dispatcher?.callbackManager;
    if (!cm) {
        Logger.error(LogCategory.SYSTEM, `MSS32: ${source}: no callback manager — cannot drive app callbacks`);
        return abandon(chain);
    }

    let step = chain.next();
    if (step.done) return step.value >>> 0;

    const frameId = cm.saveSuspendedThunkContext(thunkCtx, stackCleanup, source);
    if (!frameId) {
        Logger.error(LogCategory.SYSTEM, `MSS32: ${source}: could not park the caller — app callbacks not driven`);
        return abandon(chain);
    }

    let firstCallbackId = 0;

    const issue = (call: GuestCall): void => {
        let callbackId = 0;
        try {
            ({ callbackId } = cm.invokeCallback(
                call.fn,
                call.args,
                0,
                (eax: number) => {
                    step = chain.next(eax >>> 0);
                    return step.done ? (step.value >>> 0) : null;
                },
                false,
                `${source}:${call.label}`,
                frameId,
            ));
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `MSS32: ${source}: ${call.label} invoke threw: ${e}`);
            callbackId = 0;
        }
        if (!callbackId) {
            // The frame is parked with nothing left to wake it. Releasing it is what
            // unpins the owning thread — without this the thread waits forever for a
            // callback nobody will issue, and the leaked frame also makes the
            // dispatcher skip its auto-save for the NEXT suspending thunk anywhere.
            cm.abandonSuspendedFrame(frameId);
            abandon(chain);
            return;
        }
        const invocation = cm.getPendingCallback(callbackId);
        if (invocation) {
            invocation.enumerationState = {
                continueEnumeration: () => { if (!step.done) issue(step.value as GuestCall); },
                finishEnumeration: () => { },
            };
        }
        if (!firstCallbackId) firstCallbackId = callbackId;
    };

    issue(step.value as GuestCall);
    if (!firstCallbackId) {
        cm.abandonSuspendedFrame(frameId);
        return 0;
    }

    return { value: 0, suspendedForCallback: true, callbackId: firstCallbackId, stackCleanup };
}

/** Let the generator's `finally` release its guest scratch, and take its value. */
function abandon(chain: GuestCallChain): number {
    try {
        const r = chain.return(0);
        return (typeof r.value === "number" ? r.value : 0) >>> 0;
    } catch {
        return 0;
    }
}

/**
 * Read a whole file through the app's callbacks: open → size → read* → close.
 * Yields guest calls; returns the bytes, or null if the app could not open it.
 */
export function* readWholeFileViaApp(
    ctx: MSSContext,
    namePtr: number,
    what: string,
    maxBytes = 0,
): Generator<GuestCall, Uint8Array | null, number> {
    const cb = ctx.fileCallbacks!;
    // handle out-param (4 bytes) + the read buffer the app writes into.
    const scratch = ctx.process.memory.alloc(4 + READ_CHUNK);
    if (!scratch) {
        Logger.error(LogCategory.SYSTEM, `MSS32: app file I/O: no guest memory for "${what}"`);
        return null;
    }
    const handleOut = scratch;
    const buffer = scratch + 4;

    try {
        const opened = yield { fn: cb.open, args: [namePtr, handleOut], label: "open" };
        if (!opened) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: app file callback could not open "${what}"`);
            return null;
        }
        const handle = readU32(ctx, handleOut);

        const size = (yield { fn: cb.seek, args: [handle, 0, AIL_FILE_SEEK_END], label: "seek(end)" }) >>> 0;
        yield { fn: cb.seek, args: [handle, 0, AIL_FILE_SEEK_BEGIN], label: "seek(begin)" };

        let want = maxBytes > 0 ? Math.min(size, maxBytes >>> 0) : size;
        if (want > MAX_WHOLE_FILE) {
            Logger.error(LogCategory.SYSTEM,
                `MSS32: app file "${what}" is ${want} bytes — refusing to buffer more than ${MAX_WHOLE_FILE}`);
            want = 0;
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < want) {
            const ask = Math.min(READ_CHUNK, want - total);
            const got = (yield { fn: cb.read, args: [handle, buffer, ask], label: "read" }) >>> 0;
            if (got === 0 || got > ask) break;
            const mem = getMemory(ctx);
            if (!MemoryGuard.isValidRange(mem, buffer, got)) {
                Logger.error(LogCategory.SYSTEM, `MSS32: app read buffer out of range for "${what}"`);
                break;
            }
            chunks.push(mem.slice(buffer, buffer + got));
            total += got;
            if (got < ask) break;
        }

        yield { fn: cb.close, args: [handle], label: "close" };

        if (total === 0) {
            Logger.error(LogCategory.SYSTEM,
                `MSS32: app file callbacks returned 0 bytes for "${what}" (reported size ${size})`);
            return null;
        }
        if (total < want) {
            Logger.warn(LogCategory.SYSTEM,
                `MSS32: short read via app callbacks for "${what}": ${total}/${want}`);
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: read ${total} bytes of "${what}" through the app's file callbacks`);

        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out;
    } finally {
        ctx.process.memory.free(scratch);
    }
}

/** Size of a file as the app's callbacks report it: open → seek(end) → close. */
export function* fileSizeViaApp(
    ctx: MSSContext,
    namePtr: number,
    what: string,
): Generator<GuestCall, number, number> {
    const cb = ctx.fileCallbacks!;
    const handleOut = ctx.process.memory.alloc(4);
    if (!handleOut) return 0;
    try {
        const opened = yield { fn: cb.open, args: [namePtr, handleOut], label: "open" };
        if (!opened) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: app file callback could not open "${what}"`);
            return 0;
        }
        const handle = readU32(ctx, handleOut);
        const size = (yield { fn: cb.seek, args: [handle, 0, AIL_FILE_SEEK_END], label: "seek(end)" }) >>> 0;
        yield { fn: cb.close, args: [handle], label: "close" };
        return size;
    } finally {
        ctx.process.memory.free(handleOut);
    }
}

/** Each chain step is its own JS turn, so the guest view is re-derived per read. */
function readU32(ctx: MSSContext, addr: number): number {
    const mem = getMemory(ctx);
    if (!MemoryGuard.isValidRange(mem, addr, 4)) return 0;
    return makeView(mem).getUint32(addr, true) >>> 0;
}

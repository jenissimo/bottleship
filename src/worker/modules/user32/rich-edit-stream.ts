/**
 * EM_STREAMIN / EM_STREAMOUT — the two Rich Edit messages that re-enter the guest.
 *
 * EDITSTREAM.pfnCallback is the app's own function, called repeatedly until it
 * reports end-of-data, so the control cannot answer without running guest code
 * mid-message. That is exactly the suspended-thunk callback chain DispatchMessage
 * and the DirectDraw enumerators use: park the SendMessage thunk, drive the callback
 * chain, and complete the thunk with the byte count once the stream ends. It
 * therefore only works from an entry point that HAS a guest return frame — the
 * SendMessage* / SendDlgItemMessage* thunks — which is why these two messages are
 * intercepted there rather than in the generic control-message sink.
 */

import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import type { ThunkResult, X86Context } from '../../core/thunking/thunk-dispatcher';
import type { WindowInfo } from './shared-state';
import { eraseControlOverlayRect, repaintDialogAfterContentChange } from './dialog-paint';
import {
    EM_STREAMIN,
    EM_STREAMOUT,
    applyRichEditStream,
    buildRichEditStreamBytes,
    isRichEditControl,
} from './rich-edit-control';

/** EDITSTREAM { DWORD_PTR dwCookie; DWORD dwError; EDITSTREAMCALLBACK pfnCallback; } */
const EDITSTREAM_SIZE = 12;
const EDITSTREAM_COOKIE = 0;
const EDITSTREAM_ERROR = 4;
const EDITSTREAM_CALLBACK = 8;

/** Bytes offered per callback. Real Rich Edit uses a comparable read-ahead chunk. */
const STREAM_CHUNK = 4096;
/** Ceiling on one stream, so a callback that never reports EOF cannot run forever. */
const STREAM_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Intercept EM_STREAMIN/EM_STREAMOUT for a Rich Edit control. Returns the ThunkResult
 * that parks the calling thunk, or null when the message is not a stream (the caller
 * proceeds with normal control-message handling).
 */
export function tryRichEditStreamMessage(
    ctx: X86Context,
    mem: Uint8Array,
    child: WindowInfo,
    msg: number,
    wParam: number,
    lParam: number,
    stackCleanup: number,
    tag: string,
): ThunkResult | null {
    if (msg !== EM_STREAMIN && msg !== EM_STREAMOUT) return null;
    if (!isRichEditControl(child)) return null;

    const editStream = lParam >>> 0;
    if (!editStream || !isValidAddress(mem, editStream, EDITSTREAM_SIZE, 'rw')) {
        Logger.warn(LogCategory.USER32,
            `${tag}: EDITSTREAM 0x${editStream.toString(16)} is not writable guest memory`);
        return { value: 0, stackCleanup };
    }
    const cookie = (Mem.readUint32(editStream + EDITSTREAM_COOKIE) ?? 0) >>> 0;
    const callback = (Mem.readUint32(editStream + EDITSTREAM_CALLBACK) ?? 0) >>> 0;
    if (!callback) return { value: 0, stackCleanup };

    const system = System.getInstance();
    const process = system.process;
    const callbackManager = process?.dispatcher?.callbackManager;
    if (!process || !callbackManager) return { value: 0, stackCleanup };

    const format = wParam >>> 0;
    const outBytes = msg === EM_STREAMOUT ? buildRichEditStreamBytes(child, format) : null;
    // An EM_STREAMOUT of nothing still has to answer without ever calling back. It has to
    // decide that BEFORE parking: a suspended frame pins the calling thread and only a
    // completion path releases it, so a park with no callback chain behind it is a thread
    // that is never preemptible again.
    if (msg === EM_STREAMOUT && (!outBytes || outBytes.length === 0)) {
        return { value: 0, stackCleanup };
    }

    // pbBuff and the LONG* pcb the callback writes through live in one allocation.
    const scratch = process.memory.alloc(STREAM_CHUNK + 4) >>> 0;
    if (!scratch) return { value: 0, stackCleanup };
    const buffer = scratch;
    const pcb = scratch + STREAM_CHUNK;

    let frameId = 0;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let outPos = 0;
    let firstCallbackId = 0;

    const finish = (): number => {
        process.memory.free(scratch);
        if (msg === EM_STREAMIN) {
            const all = new Uint8Array(total);
            let at = 0;
            for (const c of chunks) { all.set(c, at); at += c.length; }
            applyRichEditStream(child, format, all);
            eraseControlOverlayRect(child);
            repaintDialogAfterContentChange(child.parent ?? child.handle);
        }
        Logger.log(LogCategory.USER32,
            `${tag}: ${msg === EM_STREAMIN ? 'EM_STREAMIN' : 'EM_STREAMOUT'} ` +
            `hwnd=0x${child.handle.toString(16)} format=0x${format.toString(16)} bytes=${total}`);
        return total;
    };

    const invokeNext = (): void => {
        let chunkSize = STREAM_CHUNK;
        if (msg === EM_STREAMOUT && outBytes) {
            chunkSize = Math.min(STREAM_CHUNK, outBytes.length - outPos);
            Mem.writeBytes(buffer, outBytes.subarray(outPos, outPos + chunkSize));
        }
        Mem.writeUint32(pcb, 0);

        const { callbackId } = callbackManager.invokeCallback(
            callback,
            [cookie, buffer, chunkSize, pcb],
            0,
            (ret: number): number | null => {
                // A non-zero return is the callback reporting failure: Rich Edit stores
                // it in EDITSTREAM.dwError and stops.
                if (ret !== 0) {
                    Mem.writeUint32(editStream + EDITSTREAM_ERROR, ret >>> 0);
                    return finish();
                }
                const moved = Mem.readInt32(pcb) ?? 0;
                if (moved <= 0) return finish();

                if (msg === EM_STREAMIN) {
                    const taken = Math.min(moved, STREAM_CHUNK);
                    chunks.push(Mem.readBytes(buffer, taken)?.slice() ?? new Uint8Array(0));
                    total += taken;
                    if (total >= STREAM_MAX_BYTES) {
                        Logger.warn(LogCategory.USER32,
                            `${tag}: EM_STREAMIN exceeded ${STREAM_MAX_BYTES} bytes; stopping`);
                        return finish();
                    }
                } else {
                    outPos += Math.min(moved, chunkSize);
                    total = outPos;
                    if (!outBytes || outPos >= outBytes.length) return finish();
                }
                return null; // more to stream
            },
            false,
            tag,
            frameId,
        );
        if (callbackId === 0) return;
        if (firstCallbackId === 0) firstCallbackId = callbackId;

        const invocation = callbackManager.getPendingCallback(callbackId);
        if (invocation) {
            invocation.enumerationState = {
                continueEnumeration: invokeNext,
                finishEnumeration: () => {}, // the terminal completeThunk already freed
            };
            if (callbackId !== firstCallbackId) {
                const first = callbackManager.getPendingCallback(firstCallbackId);
                if (first?.thunkContext) invocation.thunkContext = first.thunkContext;
            }
        }
    };

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const thunkReturnAddr = view.getUint32(ctx.esp, true);
    frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: thunkReturnAddr }, stackCleanup, tag);
    if (frameId === 0) {
        process.memory.free(scratch);
        Logger.error(LogCategory.USER32, `${tag}: could not park the thunk for a Rich Edit stream`);
        return { value: 0, stackCleanup };
    }

    invokeNext();
    if (firstCallbackId === 0) {
        process.memory.free(scratch);
        Logger.error(LogCategory.USER32, `${tag}: Rich Edit stream callback could not be invoked`);
        return { value: 0, stackCleanup };
    }

    return {
        value: 0,
        suspendedForCallback: true,
        callbackId: firstCallbackId,
        stackCleanup,
        skipStackCheck: true,
    };
}

/**
 * zlib `uncompress` — the exact kernel, in a module free of worker singletons
 * so it is unit-testable in isolation (tools/tests/zlib-uncompress.test.ts).
 * RE spec and detection notes live in ./descriptor.ts.
 *
 *   int uncompress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen)
 *
 * zlib 1.1.x body (verified against game.exe 0x487000):
 *   stream = { next_in=source, avail_in=sourceLen, next_out=dest, avail_out=*destLen }
 *   err = inflateInit(&stream);            if (err) return err;
 *   err = inflate(&stream, Z_FINISH);
 *   if (err != Z_STREAM_END) { inflateEnd(&stream); return err == Z_OK ? Z_BUF_ERROR : err; }
 *   *destLen = stream.total_out;
 *   return inflateEnd(&stream);
 *
 * So the observable contract is: Z_OK plus `*destLen = produced` on a complete
 * stream; Z_BUF_ERROR when the input ran out or the destination filled;
 * Z_DATA_ERROR on a malformed stream or a bad Adler-32; Z_NEED_DICT when the
 * header asks for a preset dictionary. Neither error path touches *destLen.
 */

import { inflateZlibSync, type InflateOutcome } from '@bottleship/formats/zip/inflate';
import type { ShadowRange, ShadowView } from '../../types';

export const Z_OK = 0;
export const Z_NEED_DICT = 2;
export const Z_MEM_ERROR = -4 >>> 0;
export const Z_DATA_ERROR = -3 >>> 0;
export const Z_BUF_ERROR = -5 >>> 0;

/**
 * Guest span the kernel may write, in pieces small enough for the shadow
 * validator's per-range ceiling (16 MiB). The kernel writes with the SAME
 * chunking so no single writeBytes ever straddles two declared ranges — the
 * scratch view resolves a write inside exactly one range or fails the call.
 */
export const DEST_CHUNK = 0x800000;

/**
 * Largest dest capacity / source length the hook will take responsibility for.
 * Bounds the per-call host allocation and keeps the chunked dest span inside
 * the validator's 64-range ceiling; anything larger runs the guest's own code.
 */
export const MAX_SPAN = 0x4000000;

export interface UncompressArgs {
    dest: number;
    destLenPtr: number;
    source: number;
    sourceLen: number;
    destCap: number;
}

export function decodeArgs(view: ShadowView, args: number[]): UncompressArgs {
    const destLenPtr = args[1] >>> 0;
    return {
        dest: args[0] >>> 0,
        destLenPtr,
        source: args[2] >>> 0,
        sourceLen: args[3] >>> 0,
        destCap: destLenPtr !== 0 ? view.readU32(destLenPtr) : 0,
    };
}

/** Chunked dest span + the destLen out-param — the full comparison surface. */
export function uncompressRanges(view: ShadowView, args: number[]): ShadowRange[] {
    const a = decodeArgs(view, args);
    const out: ShadowRange[] = [{ addr: a.destLenPtr, len: 4 }];
    for (let off = 0; off < a.destCap; off += DEST_CHUNK) {
        out.push({ addr: a.dest + off, len: Math.min(DEST_CHUNK, a.destCap - off) });
    }
    return out;
}

export function uncompressGuard(view: ShadowView, args: number[]): boolean {
    const a = decodeArgs(view, args);
    if (a.dest === 0 || a.destLenPtr === 0 || a.source === 0) return false;
    if (a.sourceLen === 0 || a.sourceLen > MAX_SPAN) return false;
    if (a.destCap === 0 || a.destCap > MAX_SPAN) return false;
    return true;
}

/** Result of one kernel run, kept for the diagnostic log line. */
export interface UncompressTrace extends UncompressArgs {
    outcome: InflateOutcome;
    ret: number;
    /** First two bytes of the source — the zlib header (CMF, FLG). */
    header: number;
}

/**
 * Run our inflate over the guest's buffers. `onTrace` sees every call; the
 * hook uses it for the diagnostic log without this module importing Logger.
 */
export function uncompressKernel(
    view: ShadowView,
    args: number[],
    onTrace?: (t: UncompressTrace) => void,
): number {
    const a = decodeArgs(view, args);
    if (a.destCap > MAX_SPAN || a.sourceLen > MAX_SPAN) {
        // Only reachable on a guard-declined call whose original run also
        // failed. Refusing to allocate reports what zlib reports when it
        // cannot allocate, instead of taking the host down with it.
        const outcome: InflateOutcome = {
            status: 'data-error', written: 0, consumed: 0,
            message: `span beyond the hook's ${MAX_SPAN} byte ceiling`,
        };
        onTrace?.({ ...a, outcome, ret: Z_MEM_ERROR, header: -1 });
        return Z_MEM_ERROR;
    }
    const src = view.readBytes(a.source, a.sourceLen);
    const out = new Uint8Array(a.destCap);
    const outcome = inflateZlibSync(src, out);

    // Write only what was produced: the scratch overlay starts as a copy of
    // live memory, so untouched destination bytes compare equal for free —
    // and the guest leaves them untouched too.
    for (let off = 0; off < outcome.written; off += DEST_CHUNK) {
        const len = Math.min(DEST_CHUNK, outcome.written - off);
        view.writeBytes(a.dest + off, out.subarray(off, off + len));
    }

    let ret: number;
    switch (outcome.status) {
        case 'ok':
            view.writeU32(a.destLenPtr, outcome.written);
            ret = Z_OK;
            break;
        case 'need-dict':
            ret = Z_NEED_DICT;
            break;
        case 'data-error':
            ret = Z_DATA_ERROR;
            break;
        default: // 'truncated' | 'output-full' — zlib folds both into Z_BUF_ERROR
            ret = Z_BUF_ERROR;
            break;
    }

    onTrace?.({
        ...a,
        outcome,
        ret,
        header: a.sourceLen >= 2 ? ((src[0] << 8) | src[1]) : -1,
    });
    return ret >>> 0;
}

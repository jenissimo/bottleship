/**
 * HSTRING — the Windows Runtime's immutable, reference-counted UTF-16 string.
 *
 * Guest layout, shared by both kinds (Wine combase/string.c; HSTRING_HEADER is 20 bytes
 * on x86, so a fast-pass reference lives entirely inside the caller's header):
 *   +0 flags (1 = fast-pass reference)   +4 length in WCHARs
 *   +8, +12 padding                        +16 LPCWSTR to the characters
 * An allocated string continues with a refcount at +20 and its characters at +24.
 * NULL is the empty string: every function accepts it and none allocates for it.
 */

import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";

export const S_OK = 0x00000000;
export const E_POINTER = 0x80004003;
export const E_INVALIDARG = 0x80070057;
export const E_OUTOFMEMORY = 0x8007000e;

export const HSTRING_REFERENCE_FLAG = 1;
export const HSTRING_HEADER_SIZE = 20;
const OFF_FLAGS = 0;
const OFF_LENGTH = 4;
const OFF_STR = 16;
const OFF_REFCOUNT = 20;
const OFF_BUFFER = 24;
/** Characters beyond this cannot be sized in a 32-bit allocation. */
const MAX_LENGTH = 0x3ffffff0;

export interface HStringHeap {
    alloc(bytes: number): number;
    free(ptr: number): void;
}

export class HStrings {
    private emptyString = 0;

    constructor(private readonly heap: HStringHeap) {}

    reset(): void {
        this.emptyString = 0;
    }

    /** WindowsCreateString(LPCWSTR, UINT32, HSTRING*) */
    create(src: number, length: number, out: number): number {
        if (!out || !isValidAddress(out, 4, "rw")) return E_INVALIDARG;
        if (length === 0) {
            Mem.writeUint32(out, 0);
            return S_OK;
        }
        if (!src) return E_POINTER;
        if (length > MAX_LENGTH || !isValidAddress(src, length * 2, "r")) return E_INVALIDARG;
        const h = this.allocString(length);
        if (!h) return E_OUTOFMEMORY;
        Mem.memcpy(h + OFF_BUFFER, src, length * 2);
        Mem.writeUint32(out, h);
        return S_OK;
    }

    /** WindowsCreateStringReference(LPCWSTR, UINT32, HSTRING_HEADER*, HSTRING*) */
    createReference(src: number, length: number, header: number, out: number): number {
        if (!out || !header) return E_INVALIDARG;
        if (!isValidAddress(out, 4, "rw") || !isValidAddress(header, HSTRING_HEADER_SIZE, "rw")) {
            return E_INVALIDARG;
        }
        if (src) {
            if (length > MAX_LENGTH || !isValidAddress(src, length * 2 + 2, "r")) return E_INVALIDARG;
            if ((Mem.readUint16(src + length * 2) ?? 1) !== 0) return E_INVALIDARG;
        }
        if (length === 0) {
            Mem.writeUint32(out, 0);
            return S_OK;
        }
        if (!src) return E_POINTER;
        Mem.writeUint32(header + OFF_FLAGS, HSTRING_REFERENCE_FLAG);
        Mem.writeUint32(header + OFF_LENGTH, length);
        Mem.writeUint32(header + 8, 0);
        Mem.writeUint32(header + 12, 0);
        Mem.writeUint32(header + OFF_STR, src);
        Mem.writeUint32(out, header);
        return S_OK;
    }

    /** WindowsDeleteString(HSTRING) — a reference owns nothing and is left alone. */
    delete(h: number): number {
        if (!h) return S_OK;
        const flags = Mem.readUint32(h + OFF_FLAGS) ?? HSTRING_REFERENCE_FLAG;
        if (flags & HSTRING_REFERENCE_FLAG) return S_OK;
        const refs = ((Mem.readUint32(h + OFF_REFCOUNT) ?? 1) - 1) >>> 0;
        if (refs === 0) {
            this.heap.free(h);
        } else {
            Mem.writeUint32(h + OFF_REFCOUNT, refs);
        }
        return S_OK;
    }

    /** WindowsDuplicateString(HSTRING, HSTRING*) — a reference is promoted to a copy. */
    duplicate(h: number, out: number): number {
        if (!out || !isValidAddress(out, 4, "rw")) return E_INVALIDARG;
        if (!h) {
            Mem.writeUint32(out, 0);
            return S_OK;
        }
        const flags = Mem.readUint32(h + OFF_FLAGS) ?? 0;
        if (flags & HSTRING_REFERENCE_FLAG) {
            return this.create(Mem.readUint32(h + OFF_STR) ?? 0, Mem.readUint32(h + OFF_LENGTH) ?? 0, out);
        }
        Mem.writeUint32(h + OFF_REFCOUNT, ((Mem.readUint32(h + OFF_REFCOUNT) ?? 0) + 1) >>> 0);
        Mem.writeUint32(out, h);
        return S_OK;
    }

    length(h: number): number {
        return h ? (Mem.readUint32(h + OFF_LENGTH) ?? 0) : 0;
    }

    /** WindowsGetStringRawBuffer(HSTRING, UINT32*) — NULL yields a real, empty L"". */
    rawBuffer(h: number, pLength: number): number {
        const len = this.length(h);
        if (pLength && isValidAddress(pLength, 4, "rw")) Mem.writeUint32(pLength, len);
        if (!h) return this.empty();
        return Mem.readUint32(h + OFF_STR) ?? 0;
    }

    isEmpty(h: number): boolean {
        return this.length(h) === 0;
    }

    private allocString(length: number): number {
        const h = this.heap.alloc(OFF_BUFFER + (length + 1) * 2);
        if (!h) return 0;
        Mem.writeUint32(h + OFF_FLAGS, 0);
        Mem.writeUint32(h + OFF_LENGTH, length);
        Mem.writeUint32(h + 8, 0);
        Mem.writeUint32(h + 12, 0);
        Mem.writeUint32(h + OFF_STR, h + OFF_BUFFER);
        Mem.writeUint32(h + OFF_REFCOUNT, 1);
        Mem.writeUint16(h + OFF_BUFFER + length * 2, 0);
        return h;
    }

    private empty(): number {
        if (!this.emptyString) {
            this.emptyString = this.heap.alloc(4);
            if (this.emptyString) Mem.writeUint32(this.emptyString, 0);
        }
        return this.emptyString;
    }
}

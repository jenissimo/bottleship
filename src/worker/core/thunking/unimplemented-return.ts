// What a DECLARED-but-unimplemented export answers with.
//
// Declaring a name in `src/worker/api/*.api.ts` is an ABI promise — it lets the PE
// loader emit a stub with the right RET N — not a promise that the function works.
// When that stub runs with no handler behind it, the answer must be one the caller can
// RECOGNIZE as failure, because everything it would read afterwards (its out-params) is
// its own uninitialized stack.
//
// The historical answer was ERROR_NOT_SUPPORTED (50), which is a failure under no
// convention at all: as an HRESULT its high bit is clear so SUCCEEDED() is true, as a
// BOOL it is TRUE, as a handle it is a non-NULL handle. Every caller was told "yes".

// Out-params are deliberately left untouched: a failing Win32 call does not write them
// either, and we cannot tell which of a stub's dword arguments is a pointer (the flat
// exports declare every parameter as an undirected u32), so "helpfully" zeroing one
// would write through an integer that happens to look like an address.

import type { UnimplementedReturn } from "../../api/types";

/** ERROR_CALL_NOT_IMPLEMENTED — what Windows/Wine report for a stub that is not there. */
export const ERROR_CALL_NOT_IMPLEMENTED = 120;

const E_NOTIMPL = 0x80004001;
const INVALID_HANDLE_VALUE = 0xFFFFFFFF;
const MMSYSERR_NOTSUPPORTED = 8;
const MCIERR_UNSUPPORTED_FUNCTION = 274; // MCIERR_BASE(256) + 18

const VALUES: Record<UnimplementedReturn, number> = {
    zero: 0,
    invalidHandle: INVALID_HANDLE_VALUE,
    minusOne: 0xFFFFFFFF,
    hresult: E_NOTIMPL,
    mmresult: MMSYSERR_NOTSUPPORTED,
    mcierror: MCIERR_UNSUPPORTED_FUNCTION,
    win32Status: ERROR_CALL_NOT_IMPLEMENTED,
    unresolvable: 0,
};

/**
 * Fallback when a descriptor names no class. Zero is the only value that fails under
 * every pointer/handle/BOOL/count convention simultaneously; the conventions where it
 * means SUCCESS (HRESULT, MMRESULT, MCIERROR, LSTATUS) are exactly the ones a descriptor
 * has to declare.
 */
export const DEFAULT_UNIMPLEMENTED_RETURN = VALUES.zero;

/** A COM vtable slot returns an HRESULT unless its descriptor says otherwise. */
export const COM_METHOD_UNIMPLEMENTED_RETURN = VALUES.hresult;

export function unimplementedReturnValue(cls: UnimplementedReturn): number {
    return VALUES[cls] >>> 0;
}

export function isUnimplementedReturnClass(value: string): value is UnimplementedReturn {
    return Object.prototype.hasOwnProperty.call(VALUES, value);
}

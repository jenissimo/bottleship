// Trap-free guest x86 for the kernel32 exports whose whole contract is a TEB field:
// GetLastError/SetLastError (TEB+0x34), TlsGetValue/TlsSetValue (the TLS array at
// TEB+0x2C) and FlsGetValue/FlsSetValue (RTL_FLS_DATA at TEB+0xFB4). The JS handlers,
// the WASM hypercalls and these stubs all read and write those same fields through the
// calling thread's FS base, so there is one store per thread and nothing to synchronise.
// Caller: pe-loader (first kernel32 import), via ThunkMemoryManager.stubAllocator.
// Executed against the JS paths in tools/tests/teb-stubs.test.ts.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';
import { FLS_DATA_SLOTS_OFFSET, FLS_INDEX_LIMIT, TEB_OFFSETS, TLS_INDEX_LIMIT } from '../../core/teb-manager';

export type TebStubName =
    'getLastErrorStub' | 'setLastErrorStub' | 'tlsGetValueStub' | 'tlsSetValueStub' | 'flsGetValueStub' | 'flsSetValueStub';

export type TebInlineStubs = Record<TebStubName, number> & { regionBase: number; regionEnd: number };

/** Export (lower-case) -> stub. */
export const TEB_STUB_EXPORTS: Readonly<Record<string, TebStubName>> = {
    getlasterror: 'getLastErrorStub',
    setlasterror: 'setLastErrorStub',
    tlsgetvalue: 'tlsGetValueStub',
    tlssetvalue: 'tlsSetValueStub',
    flsgetvalue: 'flsGetValueStub',
    flssetvalue: 'flsSetValueStub',
};

/** functionIds the stubs OUT with when they cannot answer in guest code: a thread with no
 *  TLS array, or a first FlsSetValue (the FLS block is allocated by JS). Dispatch keys on
 *  the id in EAX, so the trap is the export's own handler. */
export interface TebStubTraps {
    tlsGetValue: number;
    tlsSetValue: number;
    flsSetValue: number;
}

const ERROR_INVALID_PARAMETER = 87;
/** Six stubs, ~320 bytes with their failure/trap tails. */
const REGION_SIZE = 384;

/**
 * Emit the stubs. Windows semantics, which the JS handlers implement identically:
 *  - TlsGetValue: index < TLS_INDEX_LIMIT -> LastError = 0, return the slot (the bitmap is
 *    not consulted); otherwise LastError = ERROR_INVALID_PARAMETER, return 0.
 *  - TlsSetValue: index < TLS_INDEX_LIMIT -> store, TRUE (LastError untouched); otherwise
 *    ERROR_INVALID_PARAMETER, FALSE.
 *  - FlsGetValue: index 0 or >= FLS_MAXIMUM_AVAILABLE, or no FLS block yet ->
 *    ERROR_INVALID_PARAMETER, 0; otherwise LastError = 0, return the slot.
 *  - FlsSetValue: bad index -> ERROR_INVALID_PARAMETER, FALSE; otherwise store, TRUE.
 * All are stdcall. Only EAX/ECX/EDX and EFLAGS are touched (caller-saved). No shared state:
 * every access is through the calling thread's FS, so a preemption anywhere inside is safe.
 */
export function writeTebStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    traps: TebStubTraps,
): TebInlineStubs {
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    const w = (...bytes: number[]) => { for (const b of bytes) mem[off++] = b & 0xFF; };
    const u32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    /** jcc rel32 (0F 8x) whose target is patched by `bind`. */
    const jcc = (cc: number): number => { w(0x0F, cc); const at = off; u32(0); return at; };
    const bind = (at: number) => dv.setInt32(at, off - (at + 4), true);
    const retN = (n: number) => w(0xC2, n & 0xFF, (n >> 8) & 0xFF);

    const movEaxFs = (field: number) => { w(0x64, 0xA1); u32(field); };              // mov eax, fs:[field]
    const setLastErrorImm = (code: number) => { w(0x64, 0xC7, 0x05); u32(TEB_OFFSETS.lastError); u32(code); };
    const loadIndex = () => w(0x8B, 0x4C, 0x24, 0x04);                               // mov ecx, [esp+4]
    const loadValue = () => w(0x8B, 0x54, 0x24, 0x08);                               // mov edx, [esp+8]
    const testEax = () => w(0x85, 0xC0);                                             // test eax, eax
    const fail = (popBytes: number) => {                                             // LastError = 87; return 0
        setLastErrorImm(ERROR_INVALID_PARAMETER);
        w(0x31, 0xC0);
        retN(popBytes);
    };
    const trap = (functionId: number, popBytes: number) => {                         // the export's own OUT trap
        w(0xB8); u32(functionId);
        w(0xBA, 0x77, 0xB0, 0x00, 0x00);
        w(0xEF);
        retN(popBytes);
    };
    /** cmp ecx, TLS_INDEX_LIMIT ; jae bad */
    const tlsRangeCheck = () => { w(0x81, 0xF9); u32(TLS_INDEX_LIMIT); return jcc(0x83); };
    /** lea eax, [ecx-1] ; cmp eax, FLS_INDEX_LIMIT-1 ; jae bad — rejects 0 and >= limit at once. */
    const flsRangeCheck = () => { w(0x8D, 0x41, 0xFF, 0x3D); u32(FLS_INDEX_LIMIT - 1); return jcc(0x83); };

    // DWORD GetLastError(void): mov eax, fs:[34h] ; ret
    const getLastErrorStub = off;
    movEaxFs(TEB_OFFSETS.lastError);
    w(0xC3);

    // void SetLastError(DWORD): mov eax, [esp+4] ; mov fs:[34h], eax ; ret 4
    const setLastErrorStub = off;
    w(0x8B, 0x44, 0x24, 0x04);
    w(0x64, 0xA3); u32(TEB_OFFSETS.lastError);
    retN(4);

    // LPVOID TlsGetValue(DWORD dwTlsIndex)
    const tlsGetValueStub = off;
    {
        loadIndex();
        const bad = tlsRangeCheck();
        movEaxFs(TEB_OFFSETS.tlsPointer);
        testEax();
        const noArray = jcc(0x84);
        setLastErrorImm(0);
        w(0x8B, 0x04, 0x88);                                                         // mov eax, [eax+ecx*4]
        retN(4);
        bind(bad); fail(4);
        bind(noArray); trap(traps.tlsGetValue, 4);
    }

    // BOOL TlsSetValue(DWORD dwTlsIndex, LPVOID lpTlsValue)
    const tlsSetValueStub = off;
    {
        loadIndex();
        const bad = tlsRangeCheck();
        movEaxFs(TEB_OFFSETS.tlsPointer);
        testEax();
        const noArray = jcc(0x84);
        loadValue();
        w(0x89, 0x14, 0x88);                                                         // mov [eax+ecx*4], edx
        w(0xB8); u32(1);
        retN(8);
        bind(bad); fail(8);
        bind(noArray); trap(traps.tlsSetValue, 8);
    }

    // PVOID FlsGetValue(DWORD dwFlsIndex)
    const flsGetValueStub = off;
    {
        loadIndex();
        const bad = flsRangeCheck();
        movEaxFs(TEB_OFFSETS.flsData);
        testEax();
        const noBlock = jcc(0x84);
        setLastErrorImm(0);
        w(0x8B, 0x44, 0x88, FLS_DATA_SLOTS_OFFSET);                                  // mov eax, [eax+ecx*4+8]
        retN(4);
        bind(bad); bind(noBlock); fail(4);
    }

    // BOOL FlsSetValue(DWORD dwFlsIndex, PVOID lpFlsData)
    const flsSetValueStub = off;
    {
        loadIndex();
        const bad = flsRangeCheck();
        movEaxFs(TEB_OFFSETS.flsData);
        testEax();
        const noBlock = jcc(0x84);
        loadValue();
        w(0x89, 0x54, 0x88, FLS_DATA_SLOTS_OFFSET);                                  // mov [eax+ecx*4+8], edx
        w(0xB8); u32(1);
        retN(8);
        bind(bad); fail(8);
        bind(noBlock); trap(traps.flsSetValue, 8);
    }

    if (off > base + REGION_SIZE) {
        throw new Error(`[teb-stubs] emitted ${off - base}B into a ${REGION_SIZE}B region`);
    }

    Logger.log(LogCategory.SYSTEM,
        `TEB stubs emitted (${off - base}B) at 0x${base.toString(16)}: GetLastError=0x${getLastErrorStub.toString(16)} ` +
        `SetLastError=0x${setLastErrorStub.toString(16)} TlsGetValue=0x${tlsGetValueStub.toString(16)} ` +
        `TlsSetValue=0x${tlsSetValueStub.toString(16)} FlsGetValue=0x${flsGetValueStub.toString(16)} ` +
        `FlsSetValue=0x${flsSetValueStub.toString(16)}`);

    return {
        getLastErrorStub, setLastErrorStub, tlsGetValueStub, tlsSetValueStub, flsGetValueStub, flsSetValueStub,
        regionBase: base, regionEnd: base + REGION_SIZE,
    };
}

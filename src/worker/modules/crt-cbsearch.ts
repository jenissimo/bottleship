/**
 * Native x86 binary search for CRT bsearch().
 * Written to THUNK_CODE and called directly from guest code — no JS thunk overhead.
 * The comparison callback runs entirely in x86 guest space (cdecl).
 *
 * cdecl: void *bsearch(const void *key, const void *base, size_t num, size_t size,
 *                      int (*cmp)(const void *key, const void *elem))
 *
 * Mirrors the THUNK_CODE / shared-cached-address pattern of crt-qsort.ts
 * (ensureNativeQsort). The comparator is invoked via `call [ebp+offset]` so the
 * guest cdecl callback runs natively rather than re-entering from JS.
 *
 * Stack args (cdecl, after our `push ebp; mov ebp,esp`):
 *   [ebp+8]  = key
 *   [ebp+12] = base
 *   [ebp+16] = num
 *   [ebp+20] = size
 *   [ebp+24] = cmp
 *
 * Register usage inside the loop:
 *   esi = lo, edi = hi, ebx = mid  (all callee-saved → preserved across cmp call)
 */

import { Process } from "../core/process";
import { Logger, LogCategory } from "../core/logger";

/**
 * Shared bsearch code address — allocated once per process generation and reused by
 * every CRT flavour. Keyed on `process.resetGeneration` for the same reason as
 * ensureNativeQsort: Process.reset() rewinds the THUNK_CODE bump allocator, so a
 * cached pre-reset address is dangling and would bind the guest's IAT to whatever
 * emitter gets that memory next.
 */
let sharedBsearchCodeAddr = 0;
let sharedBsearchGeneration = -1;

/**
 * Ensure native x86 bsearch code is written to THUNK_CODE.
 * Returns the code address (idempotent within one process generation).
 */
export function ensureNativeCBsearch(process: Process): number {
    if (sharedBsearchCodeAddr !== 0 && sharedBsearchGeneration === process.resetGeneration) {
        return sharedBsearchCodeAddr;
    }

    const BSEARCH_CODE_SIZE = 128;
    const addr = process.memory.alloc(BSEARCH_CODE_SIZE, "THUNK_CODE", "rx");
    if (!addr) return 0;

    const mem = process.getCurrentMemory();
    if (!mem) return 0;

    let off = addr;
    const w = (b: number) => { mem[off++] = b; };
    const w2 = (b0: number, b1: number) => { mem[off++] = b0; mem[off++] = b1; };
    const w3 = (b0: number, b1: number, b2: number) => { mem[off++] = b0; mem[off++] = b1; mem[off++] = b2; };
    const w4 = (b0: number, b1: number, b2: number, b3: number) => { mem[off++] = b0; mem[off++] = b1; mem[off++] = b2; mem[off++] = b3; };

    // --- Prologue ---
    w(0x55);                            // push ebp
    w2(0x89, 0xE5);                     // mov ebp, esp
    w(0x53);                            // push ebx
    w(0x56);                            // push esi
    w(0x57);                            // push edi

    // esi = lo = 0
    w2(0x31, 0xF6);                     // xor esi, esi
    // edi = hi = num
    w3(0x8B, 0x7D, 0x10);               // mov edi, [ebp+16]   ; hi = num

    // --- loop: while (lo < hi) ---
    const loopOff = off;
    w2(0x39, 0xFE);                     // cmp esi, edi        ; (lo - hi) ; esi vs edi
    const jaeNotFoundPatch = off + 1;
    w2(0x73, 0x00);                     // jae notfound        ; if lo >= hi (unsigned) → not found

    // mid = (lo + hi) / 2   (unsigned)
    w2(0x89, 0xF0);                     // mov eax, esi        ; eax = lo
    w2(0x01, 0xF8);                     // add eax, edi        ; eax = lo + hi
    w2(0xD1, 0xE8);                     // shr eax, 1          ; eax = (lo+hi)>>1 = mid
    w2(0x89, 0xC3);                     // mov ebx, eax        ; ebx = mid

    // elem = base + mid * size
    w4(0x0F, 0xAF, 0x45, 0x14);         // imul eax, [ebp+20]  ; eax = mid * size
    w3(0x03, 0x45, 0x0C);               // add eax, [ebp+12]   ; eax = base + mid*size = elem

    // cmp(key, elem)   — cdecl: push elem; push key; call cmp; add esp,8
    w(0x50);                            // push eax            ; arg2 = elem  (also stashes elem on stack)
    w3(0xFF, 0x75, 0x08);               // push dword [ebp+8]  ; arg1 = key
    w3(0xFF, 0x55, 0x18);               // call [ebp+24]       ; cmp()
    w3(0x83, 0xC4, 0x04);               // add esp, 4          ; pop key only; elem still on stack at [esp]

    // test result sign / zero
    w2(0x85, 0xC0);                     // test eax, eax
    const jsHiPatch = off + 1;
    w2(0x78, 0x00);                     // js  setHi           ; r < 0  → hi = mid
    const jzFoundPatch = off + 1;
    w2(0x74, 0x00);                     // jz  found           ; r == 0 → return elem

    // --- r > 0 : lo = mid + 1 ---
    w3(0x8D, 0x73, 0x01);               // lea esi, [ebx+1]    ; lo = mid + 1
    w3(0x83, 0xC4, 0x04);               // add esp, 4          ; discard stashed elem
    const jmpLoopAfterLoPatch = off + 1;
    w2(0xEB, 0x00);                     // jmp loop

    // --- r < 0 : hi = mid ---
    const setHiOff = off;
    w2(0x89, 0xDF);                     // mov edi, ebx        ; hi = mid
    w3(0x83, 0xC4, 0x04);               // add esp, 4          ; discard stashed elem
    const jmpLoopAfterHiPatch = off + 1;
    w2(0xEB, 0x00);                     // jmp loop

    // --- found: return elem (still on stack at [esp]) ---
    const foundOff = off;
    w(0x58);                            // pop eax             ; eax = elem
    const jmpEpiloguePatch = off + 1;
    w2(0xEB, 0x00);                     // jmp epilogue

    // --- notfound: return 0 ---
    const notfoundOff = off;
    w2(0x31, 0xC0);                     // xor eax, eax        ; return NULL

    // --- epilogue ---
    const epilogueOff = off;
    w(0x5F);                            // pop edi
    w(0x5E);                            // pop esi
    w(0x5B);                            // pop ebx
    w(0xC9);                            // leave
    w(0xC3);                            // ret

    // --- Patch jump targets (all rel8) ---
    mem[jaeNotFoundPatch]      = (notfoundOff   - (jaeNotFoundPatch      + 1)) & 0xFF;
    mem[jsHiPatch]             = (setHiOff       - (jsHiPatch            + 1)) & 0xFF;
    mem[jzFoundPatch]          = (foundOff       - (jzFoundPatch         + 1)) & 0xFF;
    mem[jmpLoopAfterLoPatch]   = (loopOff        - (jmpLoopAfterLoPatch  + 1)) & 0xFF;
    mem[jmpLoopAfterHiPatch]   = (loopOff        - (jmpLoopAfterHiPatch  + 1)) & 0xFF;
    mem[jmpEpiloguePatch]      = (epilogueOff    - (jmpEpiloguePatch     + 1)) & 0xFF;

    const totalBytes = off - addr;
    Logger.log(LogCategory.SYSTEM,
        `Native bsearch (binary search) written at 0x${addr.toString(16)} (${totalBytes} bytes)`);

    sharedBsearchCodeAddr = addr;
    sharedBsearchGeneration = process.resetGeneration;
    return addr;
}

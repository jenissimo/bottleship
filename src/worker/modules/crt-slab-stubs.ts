// Inline x86 stub emitters for CRT fast paths: cdecl slab allocator pair
// (malloc/free on the kernel32 heap slab), Borland/Watcom buffered getc, and
// tolower/toupper case-fold LUT stubs. Codegen pinned by
// tools/tests/thunk-stub-emitters.test.ts.
// Callers: pe-loader (CRT-module import) and cw3220-stdio, via
// ThunkMemoryManager.stubAllocator.

import { Logger, LogCategory } from '../core/logger';
import type { StubAllocator } from '../core/thunking/thunk-memory-manager';

/**
 * Emit inline x86 stubs for the CRT cdecl allocator pair (malloc / operator
 * new and free / operator delete) that ride the SAME WASM slab arena as the
 * kernel32 HeapAlloc/HeapFree inline stubs (writeHeapSlabStubs). This unifies
 * the dynamically-linked-msvcrt CRT heap onto the process-heap slab, so a
 * `new`/`malloc` flood (Morrowind/NFSU/UE1) never reaches JS thunk dispatch.
 *
 * These mirror the HeapAlloc/HeapFree stubs byte-for-byte EXCEPT for the
 * cdecl calling convention deltas:
 *   - size/ptr argument at [ESP+4] (not [ESP+12] — no hHeap/dwFlags).
 *   - no HEAP_ZERO_MEMORY test (malloc does not zero).
 *   - RET (0xC3), not RET 12 — cdecl caller cleans the stack.
 * The slow path JMPs to the original msvcrt OUT-trap stub, so all the
 * uninitialized-slab / size-0 / >4KB / slab-exhausted / non-slab-free cases
 * fall through to the existing JS msvcrt.malloc / msvcrt.free fallback (which
 * must itself be slab-aware — see msvcrt.ts free/realloc/_msize).
 *
 * @param allocator       Narrow THUNK_CODE allocator (ThunkMemoryManager.stubAllocator)
 * @param getMemory       Callback returning current guest memory (refetched after alloc)
 * @param slabCtlAddr     GUEST addr of the slab control block (regions.slabControlAddr) —
 *                        shared with the kernel32 stubs.
 * @param lutAddr         Guest addr of 256-byte bin-index LUT (already initialized)
 * @param mallocTrapAddr  Slow-path target for malloc/new (msvcrt OUT-trap stub)
 * @param freeTrapAddr    Slow-path target for free/delete (msvcrt OUT-trap stub)
 * @returns Absolute guest addresses of the two stubs (to patch IAT).
 */
export function writeCrtSlabStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    slabCtlAddr: number,
    lutAddr: number,
    mallocTrapAddr: number,
    freeTrapAddr: number,
): { mallocStub: number; freeStub: number; regionBase: number; regionEnd: number } {
    // 512-byte block, registered as a scheduler non-preemptible range (same
    // free-list-RMW atomicity requirement as writeHeapSlabStubs).
    const CRT_STUB_REGION_SIZE = 512;
    const base = allocator.alloc(CRT_STUB_REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;

    const w8  = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    // GUEST addresses of the slab control fields (rebased to slabCtlAddr — same
    // relative layout as writeHeapSlabStubs; shared control block).
    const SLAB_BASE_ABS  = slabCtlAddr + 0x00; // BASE
    const SLAB_END_ABS   = slabCtlAddr + 0x04; // END
    const BUMP_ABS       = slabCtlAddr + 0x08; // BUMP
    const ALLOC_CNT_ABS  = slabCtlAddr + 0x10; // ALLOC_COUNT
    const FREE_CNT_ABS    = slabCtlAddr + 0x14; // FREE_COUNT
    const FREELIST_ABS   = slabCtlAddr + 0x20; // FREELIST[0]

    const SLAB_MAGIC     = 0x534C4100; // 'SLA\0'

    // ---- void* malloc(size_t)  cdecl — size @ [ESP+4], RET ----
    const mallocStub = off;
    const slowAllocPatches: number[] = [];
    let bumpAddr = 0;
    const bumpPatches: number[] = [];

    // MOV EAX, [ESP+4]    ; 8B 44 24 04
    w8(0x8B); w8(0x44); w8(0x24); w8(0x04);
    // TEST EAX, EAX       ; 85 C0
    w8(0x85); w8(0xC0);
    // JZ .slow            ; 0F 84 rel32  (malloc(0) → JS, keeps existing semantics)
    w8(0x0F); w8(0x84); slowAllocPatches.push(off); w32(0);
    // CMP EAX, 4096       ; 3D 00 10 00 00
    w8(0x3D); w32(4096);
    // JA .slow            ; 0F 87 rel32
    w8(0x0F); w8(0x87); slowAllocPatches.push(off); w32(0);
    // CMP dword [SLAB_BASE_ABS], 0  ; 83 3D disp32 00
    w8(0x83); w8(0x3D); w32(SLAB_BASE_ABS); w8(0x00);
    // JZ .slow            ; 0F 84 rel32
    w8(0x0F); w8(0x84); slowAllocPatches.push(off); w32(0);

    // bin = LUT[(size-1) >> 4]
    // DEC EAX             ; 48
    w8(0x48);
    // SHR EAX, 4          ; C1 E8 04
    w8(0xC1); w8(0xE8); w8(0x04);
    // MOVZX ECX, byte [EAX + lutAddr]  ; 0F B6 88 disp32
    w8(0x0F); w8(0xB6); w8(0x88); w32(lutAddr);

    // Large bins (>= 6) use the hypercall's FIFO free list (no inline tail); route large
    // allocs to the OUT-trap. See hypercall.rs SLAB_LARGE_BIN_MIN.
    // CMP ECX, 6          ; 83 F9 06
    w8(0x83); w8(0xF9); w8(0x06);
    // JAE .slow           ; 0F 83 rel32
    w8(0x0F); w8(0x83); slowAllocPatches.push(off); w32(0);

    // Try freelist pop
    // MOV EAX, [ECX*4 + FREELIST_ABS]  ; 8B 04 8D disp32
    w8(0x8B); w8(0x04); w8(0x8D); w32(FREELIST_ABS);
    // TEST EAX, EAX       ; 85 C0
    w8(0x85); w8(0xC0);
    // JZ .bump            ; 0F 84 rel32
    w8(0x0F); w8(0x84); bumpPatches.push(off); w32(0);

    // freelist hit:
    // MOV EDX, [EAX-8]    ; 8B 50 F8   (link lives in the header zone, user data untouched)
    w8(0x8B); w8(0x50); w8(0xF8);
    // MOV [ECX*4 + FREELIST_ABS], EDX  ; 89 14 8D disp32
    w8(0x89); w8(0x14); w8(0x8D); w32(FREELIST_ABS);
    // Busy/free bit: restore BUSY marker on the popped block (free flipped it to 'F').
    // MOV byte [EAX-3], 0x41  ; C6 40 FD 41   (see writeHeapSlabStubs)
    w8(0xC6); w8(0x40); w8(0xFD); w8(0x41);
    // INC dword [ALLOC_CNT_ABS]  ; FF 05 disp32
    w8(0xFF); w8(0x05); w32(ALLOC_CNT_ABS);
    // RET                 ; C3
    w8(0xC3);

    // .bump:
    bumpAddr = off;
    // MOV EDX, 16         ; BA 10 00 00 00
    w8(0xBA); w32(16);
    // SHL EDX, CL         ; D3 E2
    w8(0xD3); w8(0xE2);
    // MOV EAX, [BUMP_ABS] ; A1 disp32
    w8(0xA1); w32(BUMP_ABS);
    // ADD EAX, 16         ; 83 C0 10
    w8(0x83); w8(0xC0); w8(0x10);
    // ADD EDX, EAX        ; 01 C2
    w8(0x01); w8(0xC2);
    // CMP EDX, [SLAB_END_ABS]  ; 3B 15 disp32
    w8(0x3B); w8(0x15); w32(SLAB_END_ABS);
    // JA .slow            ; 0F 87 rel32
    w8(0x0F); w8(0x87); slowAllocPatches.push(off); w32(0);
    // MOV [BUMP_ABS], EDX ; 89 15 disp32
    w8(0x89); w8(0x15); w32(BUMP_ABS);
    // MOV EDX, SLAB_MAGIC ; BA imm32
    w8(0xBA); w32(SLAB_MAGIC);
    // OR EDX, ECX         ; 09 CA
    w8(0x09); w8(0xCA);
    // MOV [EAX - 4], EDX  ; 89 50 FC
    w8(0x89); w8(0x50); w8(0xFC);
    // INC dword [ALLOC_CNT_ABS]  ; FF 05 disp32
    w8(0xFF); w8(0x05); w32(ALLOC_CNT_ABS);
    // RET                 ; C3
    w8(0xC3);

    // .slow: JMP rel32 to msvcrt.malloc OUT-trap stub
    const slowAllocAddr = off;
    w8(0xE9);
    const slowAllocJmpRel = off;
    w32(mallocTrapAddr - (slowAllocJmpRel + 4));

    for (const patchOff of slowAllocPatches) {
        dv.setInt32(patchOff, slowAllocAddr - (patchOff + 4), true);
    }
    for (const patchOff of bumpPatches) {
        dv.setInt32(patchOff, bumpAddr - (patchOff + 4), true);
    }

    // ---- void free(void*)  cdecl — ptr @ [ESP+4], RET ----
    const freeStub = off;
    const slowFreePatches: number[] = [];
    let checkAddr = 0;
    const checkPatches: number[] = [];

    // MOV EAX, [ESP+4]    ; 8B 44 24 04
    w8(0x8B); w8(0x44); w8(0x24); w8(0x04);
    // TEST EAX, EAX       ; 85 C0
    w8(0x85); w8(0xC0);
    // JNZ .check          ; 0F 85 rel32
    w8(0x0F); w8(0x85); checkPatches.push(off); w32(0);
    // free(NULL) — no-op ; RET ; C3
    w8(0xC3);

    // .check:
    checkAddr = off;
    // MOV ECX, [SLAB_BASE_ABS]  ; 8B 0D disp32
    w8(0x8B); w8(0x0D); w32(SLAB_BASE_ABS);
    // TEST ECX, ECX       ; 85 C9
    w8(0x85); w8(0xC9);
    // JZ .slow            ; 0F 84 rel32
    w8(0x0F); w8(0x84); slowFreePatches.push(off); w32(0);
    // ADD ECX, 16         ; 83 C1 10
    w8(0x83); w8(0xC1); w8(0x10);
    // CMP EAX, ECX        ; 39 C8
    w8(0x39); w8(0xC8);
    // JB .slow            ; 0F 82 rel32
    w8(0x0F); w8(0x82); slowFreePatches.push(off); w32(0);
    // CMP EAX, [SLAB_END_ABS]  ; 3B 05 disp32
    w8(0x3B); w8(0x05); w32(SLAB_END_ABS);
    // JAE .slow           ; 0F 83 rel32
    w8(0x0F); w8(0x83); slowFreePatches.push(off); w32(0);

    // MOV ECX, [EAX - 4]  ; 8B 48 FC
    w8(0x8B); w8(0x48); w8(0xFC);
    // MOV EDX, ECX        ; 89 CA
    w8(0x89); w8(0xCA);
    // AND EDX, 0xFFFFFF00 ; 81 E2 00 FF FF FF
    w8(0x81); w8(0xE2); w32(0xFFFFFF00);
    // CMP EDX, SLAB_MAGIC ; 81 FA imm32
    w8(0x81); w8(0xFA); w32(SLAB_MAGIC);
    // JNE .slow           ; 0F 85 rel32
    w8(0x0F); w8(0x85); slowFreePatches.push(off); w32(0);
    // AND ECX, 0x0F       ; 83 E1 0F
    w8(0x83); w8(0xE1); w8(0x0F);
    // Large bins (>= 6) FIFO-free via the hypercall (tail-append); invalid bins (> 8)
    // also go slow. CMP ECX, 6 ; JAE covers both. See hypercall.rs SLAB_LARGE_BIN_MIN.
    // CMP ECX, 6          ; 83 F9 06
    w8(0x83); w8(0xF9); w8(0x06);
    // JAE .slow           ; 0F 83 rel32
    w8(0x0F); w8(0x83); slowFreePatches.push(off); w32(0);

    // Busy/free bit (see writeHeapSlabStubs): flip BUSY 'A'(0x41)→FREE 'F'(0x46) so any
    // re-free fails the CMP SLAB_MAGIC above → .slow → JS free no-ops the slab pointer.
    // Rejects all double-frees (operator delete is the overwhelming Morrowind path).
    // MOV byte [EAX-3], 0x46  ; C6 40 FD 46
    w8(0xC6); w8(0x40); w8(0xFD); w8(0x46);
    // Push to freelist[bin]
    // MOV EDX, [ECX*4 + FREELIST_ABS]  ; 8B 14 8D disp32   (EDX = current head)
    w8(0x8B); w8(0x14); w8(0x8D); w32(FREELIST_ABS);
    // MOV [EAX-8], EDX    ; 89 50 F8   (see handle_heap_free: never clobber user data)
    w8(0x89); w8(0x50); w8(0xF8);
    // MOV [ECX*4 + FREELIST_ABS], EAX  ; 89 04 8D disp32
    w8(0x89); w8(0x04); w8(0x8D); w32(FREELIST_ABS);
    // INC dword [FREE_CNT_ABS]  ; FF 05 disp32
    w8(0xFF); w8(0x05); w32(FREE_CNT_ABS);
    // RET                 ; C3  (free returns void)
    w8(0xC3);

    // .slow: JMP rel32 to msvcrt.free OUT-trap stub
    const slowFreeAddr = off;
    w8(0xE9);
    const slowFreeJmpRel = off;
    w32(freeTrapAddr - (slowFreeJmpRel + 4));

    for (const patchOff of slowFreePatches) {
        dv.setInt32(patchOff, slowFreeAddr - (patchOff + 4), true);
    }
    for (const patchOff of checkPatches) {
        dv.setInt32(patchOff, checkAddr - (patchOff + 4), true);
    }

    Logger.log(LogCategory.SYSTEM,
        `CRT slab stubs emitted: malloc=0x${mallocStub.toString(16)} ` +
        `(${slowAllocAddr - mallocStub}B body + 5B slow JMP), ` +
        `free=0x${freeStub.toString(16)} ` +
        `(${slowFreeAddr - freeStub}B body + 5B slow JMP), ` +
        `slabCtl=0x${slabCtlAddr.toString(16)}, LUT=0x${lutAddr.toString(16)}`);

    return { mallocStub, freeStub, regionBase: base, regionEnd: base + CRT_STUB_REGION_SIZE };
}

/**
 * Emit an inline x86 stub for a buffered-getc CRT function (Borland/Watcom
 * `fgetc`/`__fgetc`). The Tin3/Discworld-Noir LZSS decompressor calls fgetc(FILE*)
 * as a REAL function — through its IAT import thunk — once per input byte, and does
 * NOT inline the getc macro. So the msvcrt JS buffered-getc path (which fills a chunk
 * into the FILE buffer and updates level/curp expecting the GUEST's inlined macro to
 * drain it) still takes one OUT-trap PER BYTE (~13.3M traps over Discworld's boot;
 * profiled at 92% of the worker in JS thunk dispatch).
 *
 * This stub relocates the getc fast path into guest code (mirrors writeHeapSlabStubs):
 *   level = FILE->level(+levelOff)
 *   if level > 0:  byte = *FILE->curp(+curpOff)++ ; level-- ; return byte   (NO trap)
 *   else / NULL:   JMP to the original __fgetc OUT-trap stub → JS refills the chunk
 *                  (msvcrt.fgetc buffered block writes level/curp), returns byte 0.
 * One trap per CHUNK instead of per byte → ~262144 traps collapse to 1.
 *
 * Self-consistent with msvcrt's buffered path: it reads/writes the SAME FILE fields
 * the JS refill writes (BORLAND_FILE_LEVEL_OFF / _CURP_OFF), so offsets must be passed
 * from msvcrt.getBorlandFileLayout(). ungetc must push back INTO the guest buffer
 * (msvcrt.ungetc handles this for real-struct streams) — the stub bypasses JS so a
 * JS-only ungetChar field would be missed.
 *
 * @param allocator          Narrow THUNK_CODE allocator (ThunkMemoryManager.stubAllocator)
 * @param getMemory          Callback returning current guest memory (refetched after alloc).
 * @param fgetcTrapStubAddr  Slow-path target — the original __fgetc OUT-trap stub.
 * @param levelOff           FILE->level byte offset (Borland: 0).
 * @param curpOff            FILE->curp  byte offset (Borland: 20).
 * @returns Absolute guest address of the stub + its region bounds (to patch IAT / mark non-preemptible).
 */
export function writeGetcStub(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    fgetcTrapStubAddr: number,
    levelOff: number,
    curpOff: number,
): { getcStub: number; regionBase: number; regionEnd: number } {
    if (levelOff < 0 || levelOff > 127 || curpOff < 0 || curpOff > 127) {
        // The stub uses disp8 [EDX+off] forms; keep the documented Borland layout small.
        throw new Error(`[getc-stub] FILE field offsets must fit in disp8: level=${levelOff} curp=${curpOff}`);
    }

    // 64 bytes is plenty for the ~32-byte stub + 5-byte slow JMP. The level--/curp++
    // is a short non-atomic RMW on the per-FILE struct; mark the region non-preemptible
    // (like the heap stubs) so a 1ms quantum switch can't interleave two threads sharing
    // a FILE* mid-update (guest getc is not thread-safe, but this keeps us faithful & safe).
    const GETC_STUB_REGION_SIZE = 64;
    const base = allocator.alloc(GETC_STUB_REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    const getcStub = off;
    const slowPatches: number[] = [];

    // MOV EDX, [ESP+4]          ; 8B 54 24 04   (cdecl: FILE* arg)
    w8(0x8B); w8(0x54); w8(0x24); w8(0x04);
    // TEST EDX, EDX             ; 85 D2
    w8(0x85); w8(0xD2);
    // JZ .slow                  ; 0F 84 rel32   (NULL FILE* → trap → JS EOF/refill)
    w8(0x0F); w8(0x84); slowPatches.push(off); w32(0);
    // MOV EAX, [EDX+levelOff]   ; 8B 42 ib
    w8(0x8B); w8(0x42); w8(levelOff);
    // TEST EAX, EAX             ; 85 C0
    w8(0x85); w8(0xC0);
    // JLE .slow                 ; 0F 8E rel32   (level<=0 → refill via trap; signed)
    w8(0x0F); w8(0x8E); slowPatches.push(off); w32(0);
    // DEC EAX                   ; 48           (level - 1)
    w8(0x48);
    // MOV [EDX+levelOff], EAX   ; 89 42 ib     (level--)
    w8(0x89); w8(0x42); w8(levelOff);
    // MOV ECX, [EDX+curpOff]    ; 8B 4A ib     (curp)
    w8(0x8B); w8(0x4A); w8(curpOff);
    // MOVZX EAX, byte [ECX]     ; 0F B6 01     (return *curp as unsigned char)
    w8(0x0F); w8(0xB6); w8(0x01);
    // INC ECX                   ; 41
    w8(0x41);
    // MOV [EDX+curpOff], ECX    ; 89 4A ib     (curp++)
    w8(0x89); w8(0x4A); w8(curpOff);
    // RET                       ; C3           (cdecl)
    w8(0xC3);

    // .slow: JMP rel32 to the original __fgetc OUT-trap stub.
    const slowAddr = off;
    w8(0xE9);
    const slowJmpRel = off;
    w32(fgetcTrapStubAddr - (slowJmpRel + 4));

    for (const patchOff of slowPatches) {
        dv.setInt32(patchOff, slowAddr - (patchOff + 4), true);
    }

    Logger.log(LogCategory.SYSTEM,
        `Inline getc stub emitted: 0x${getcStub.toString(16)} ` +
        `(${slowAddr - getcStub}B body + 5B slow JMP → trap 0x${fgetcTrapStubAddr.toString(16)}, ` +
        `level@+${levelOff} curp@+${curpOff})`);

    return { getcStub, regionBase: base, regionEnd: base + GETC_STUB_REGION_SIZE };
}

/**
 * Trap-free inline x86 stubs for msvcrt tolower/toupper. `int tolower(int c)` is a leaf
 * that MSVCRT resolves to a single table lookup; games call it per-character in tight
 * path-normalization loops (e.g. Max Payne's rlmfc r_file::changedirectory), so an OUT-trap
 * per call is pure JS-dispatch overhead. Each stub reads the low byte of the cdecl arg and
 * indexes a 256-byte guest-RAM LUT (msvcrt owns/populates it per active codepage — see
 * msvcrt.buildCaseTables). No RMW / no shared mutable state → no non-preemptible marking.
 *
 *   movzx eax, byte [esp+4]      ; 0F B6 44 24 04   c (0-255), high bytes zeroed
 *   mov   al,  [eax + tableAddr] ; 8A 80 <disp32>   al = table[c]; EAX high stays 0
 *   ret                          ; C3               cdecl, caller cleans (ret 0)
 */
export function writeCaseFoldStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    lowerTableAddr: number,
    upperTableAddr: number,
): { tolowerStub: number; toupperStub: number; regionBase: number; regionEnd: number } {
    const REGION_SIZE = 32; // 2 × 10-byte stubs + slack
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    const emit = (tableAddr: number): number => {
        const stub = off;
        mem[off++] = 0x0F; mem[off++] = 0xB6; mem[off++] = 0x44; mem[off++] = 0x24; mem[off++] = 0x04; // movzx eax,[esp+4]
        mem[off++] = 0x8A; mem[off++] = 0x80; dv.setUint32(off, tableAddr >>> 0, true); off += 4;      // mov al,[eax+disp32]
        mem[off++] = 0xC3;                                                                              // ret
        return stub;
    };
    const tolowerStub = emit(lowerTableAddr);
    const toupperStub = emit(upperTableAddr);

    Logger.log(LogCategory.SYSTEM,
        `Inline case-fold stubs emitted: tolower=0x${tolowerStub.toString(16)} ` +
        `toupper=0x${toupperStub.toString(16)} (LUTs lower=0x${lowerTableAddr.toString(16)} ` +
        `upper=0x${upperTableAddr.toString(16)})`);

    return { tolowerStub, toupperStub, regionBase: base, regionEnd: base + REGION_SIZE };
}

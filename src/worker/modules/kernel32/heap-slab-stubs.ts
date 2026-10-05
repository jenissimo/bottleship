// Inline x86 stub emitter for the kernel32 heap-slab fast path (HeapAlloc/HeapFree).
// Codegen pinned by tools/tests/thunk-stub-emitters.test.ts.
// Caller: pe-loader (first kernel32 import), passing ThunkMemoryManager.stubAllocator.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

/**
 * Emit inline x86 stubs for kernel32!HeapAlloc and kernel32!HeapFree that
 * perform bump-allocation / free-list pop directly in guest code, avoiding
 * the OUT-trap → WASM hypercall round-trip.
 *
 * Happy path: reads the guest-RAM slab control fields (base/end/bump/freelist) via
 * absolute addressing, pops from free list or bump-allocates, writes header,
 * RET N. HEAP_ZERO_MEMORY routes to the original OUT-trap stub so the WASM
 * slab handler can allocate from the same slab and run zero_block. Real slow
 * paths (uninitialized slab, dwBytes=0, >4KB,
 * non-slab free, exhausted bump, bad header) falls through via JMP rel32 to
 * the original OUT-trap stub — existing JS/WASM fallback layers handle it.
 *
 * Reference logic: `handle_heap_alloc` / `handle_heap_free` in
 * vendor/v86/src/rust/cpu/hypercall.rs:1441–1538.
 *
 * @param allocator             Narrow THUNK_CODE allocator (ThunkMemoryManager.stubAllocator)
 * @param getMemory             Callback returning current guest memory (refetched after alloc to avoid detached-buffer hazards)
 * @param slabCtlAddr           GUEST addr of the slab control block (regions.slabControlAddr).
 *                              MUST be guest-addressable — the HYPERCALL_PAGE static is below
 *                              guest RAM and unreachable from guest code.
 * @param lutAddr               Guest addr of 256-byte bin-index LUT (already initialized)
 * @param heapAllocTrapStubAddr Slow-path target for HeapAlloc (original OUT-trap stub)
 * @param heapFreeTrapStubAddr  Slow-path target for HeapFree (original OUT-trap stub)
 * @returns Absolute guest addresses of the two stubs (to patch IAT).
 */
export function writeHeapSlabStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    slabCtlAddr: number,
    lutAddr: number,
    heapAllocTrapStubAddr: number,
    heapFreeTrapStubAddr: number,
): { heapAllocStub: number; heapFreeStub: number; regionBase: number; regionEnd: number } {
    // Reserve 512 bytes in THUNK_CODE for both stubs + padding. The whole block is
    // registered as a scheduler non-preemptible range: the free-list pop/push/bump
    // are multi-instruction RMWs on shared slab state and MUST run atomically w.r.t.
    // guest thread switches (else two threads pop one block — D2 "two owners").
    const HEAP_STUB_REGION_SIZE = 512;
    const base = allocator.alloc(HEAP_STUB_REGION_SIZE, 'THUNK_CODE', 'rx');
    // Refetch mem after alloc — buffer may have grown, detaching prior views.
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;

    const w8  = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    // Absolute GUEST addresses of the slab control fields (rebased to slabCtlAddr;
    // same relative layout as the HYPERCALL_PAGE slab fields minus OFF_HC_SLAB_BASE).
    const SLAB_BASE_ABS  = slabCtlAddr + 0x00; // BASE
    const SLAB_END_ABS   = slabCtlAddr + 0x04; // END
    const BUMP_ABS       = slabCtlAddr + 0x08; // BUMP
    const ALLOC_CNT_ABS  = slabCtlAddr + 0x10; // ALLOC_COUNT
    const FREE_CNT_ABS   = slabCtlAddr + 0x14; // FREE_COUNT
    const FREELIST_ABS   = slabCtlAddr + 0x20; // FREELIST[0]

    const SLAB_MAGIC     = 0x534C4100; // 'SLA\0'
    const HEAP_ZERO_FLAG = 0x8;

    // ---- HeapAlloc(hHeap, dwFlags, dwBytes) stdcall — RET 12 ----
    const heapAllocStub = off;

    // Pending rel32 patches: [patchOffset, kind] where kind resolves later.
    //   patches to .slow (heapAlloc slow), .bump, .freelist_hit are tracked.
    const slowAllocPatches: number[] = [];
    let bumpAddr = 0;
    const bumpPatches: number[] = [];

    // MOV EAX, [ESP+12]   ; 8B 44 24 0C
    w8(0x8B); w8(0x44); w8(0x24); w8(0x0C);
    // TEST EAX, EAX       ; 85 C0
    w8(0x85); w8(0xC0);
    // JZ .slow            ; 0F 84 rel32
    w8(0x0F); w8(0x84); slowAllocPatches.push(off); w32(0);
    // CMP EAX, 4096       ; 3D 00 10 00 00
    w8(0x3D); w32(4096);
    // JA .slow            ; 0F 87 rel32
    w8(0x0F); w8(0x87); slowAllocPatches.push(off); w32(0);
    // TEST dword [ESP+8], HEAP_ZERO_FLAG  ; F7 44 24 08 imm32
    w8(0xF7); w8(0x44); w8(0x24); w8(0x08); w32(HEAP_ZERO_FLAG);
    // JNZ .trap           ; 0F 85 rel32
    w8(0x0F); w8(0x85); slowAllocPatches.push(off); w32(0);
    // CMP dword [SLAB_BASE_ABS], 0  ; 83 3D disp32 00
    w8(0x83); w8(0x3D); w32(SLAB_BASE_ABS); w8(0x00);
    // JZ .slow            ; 0F 84 rel32
    w8(0x0F); w8(0x84); slowAllocPatches.push(off); w32(0);

    // bin = LUT[(dwBytes-1) >> 4]
    // DEC EAX             ; 48
    w8(0x48);
    // SHR EAX, 4          ; C1 E8 04
    w8(0xC1); w8(0xE8); w8(0x04);
    // MOVZX ECX, byte [EAX + lutAddr]  ; 0F B6 88 disp32
    w8(0x0F); w8(0xB6); w8(0x88); w32(lutAddr);

    // Large bins (>= 6 = 1024/2048/4096) use a FIFO free list maintained by the WASM
    // hypercall (a freed large block is not re-handed immediately — matches NT5's
    // non-lookaside back-end; see hypercall.rs SLAB_LARGE_BIN_MIN). The inline pop is
    // strict LIFO and has no tail pointer, so route large allocs to the OUT-trap.
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
    // Busy/free bit: restore BUSY marker on the popped block (free() flipped it to
    // 'F'). Header byte [EAX-3] 'F'(0x46)→'A'(0x41) so the block is BUSY again and a
    // legitimate later free is accepted. MOV byte [EAX-3], 0x41 ; C6 40 FD 41
    w8(0xC6); w8(0x40); w8(0xFD); w8(0x41);
    // INC dword [ALLOC_CNT_ABS]  ; FF 05 disp32
    w8(0xFF); w8(0x05); w32(ALLOC_CNT_ABS);
    // RET 12              ; C2 0C 00
    w8(0xC2); w8(0x0C); w8(0x00);

    // .bump:
    bumpAddr = off;
    // MOV EDX, 16         ; BA 10 00 00 00
    w8(0xBA); w32(16);
    // SHL EDX, CL         ; D3 E2
    w8(0xD3); w8(0xE2);
    // MOV EAX, [BUMP_ABS] ; A1 disp32 (moffs32 form, 5 bytes)
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
    // RET 12              ; C2 0C 00
    w8(0xC2); w8(0x0C); w8(0x00);

    // .trap: JMP rel32 to kernel32.HeapAlloc OUT-trap stub.
    // HEAP_ZERO_MEMORY is expected to be consumed by Rust handle_heap_alloc,
    // which zeroes the slab block in WASM. If that path is unavailable, the
    // OUT trap falls through to the normal JS HeapAlloc implementation.
    const slowAllocAddr = off;
    w8(0xE9);
    const slowAllocJmpRel = off;
    w32(heapAllocTrapStubAddr - (slowAllocJmpRel + 4));

    // Patch pending rel32s for HeapAlloc.
    for (const patchOff of slowAllocPatches) {
        dv.setInt32(patchOff, slowAllocAddr - (patchOff + 4), true);
    }
    for (const patchOff of bumpPatches) {
        dv.setInt32(patchOff, bumpAddr - (patchOff + 4), true);
    }

    // ---- HeapFree(hHeap, dwFlags, lpMem) stdcall — RET 12 ----
    const heapFreeStub = off;
    const slowFreePatches: number[] = [];
    let checkAddr = 0;
    const checkPatches: number[] = [];

    // MOV EAX, [ESP+12]   ; 8B 44 24 0C
    w8(0x8B); w8(0x44); w8(0x24); w8(0x0C);
    // TEST EAX, EAX       ; 85 C0
    w8(0x85); w8(0xC0);
    // JNZ .check          ; 0F 85 rel32
    w8(0x0F); w8(0x85); checkPatches.push(off); w32(0);
    // MOV EAX, 1          ; B8 01 00 00 00  (HeapFree(NULL)=TRUE)
    w8(0xB8); w32(1);
    // RET 12              ; C2 0C 00
    w8(0xC2); w8(0x0C); w8(0x00);

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
    // Route large bins (>= 6) AND invalid bins (> 8) to .slow. Large bins are FIFO-freed
    // by the hypercall (tail-append; see hypercall.rs SLAB_LARGE_BIN_MIN); the inline
    // push is LIFO with no tail. CMP ECX, 6 ; JAE catches 6,7,8 and anything above.
    // CMP ECX, 6          ; 83 F9 06
    w8(0x83); w8(0xF9); w8(0x06);
    // JAE .slow           ; 0F 83 rel32
    w8(0x0F); w8(0x83); slowFreePatches.push(off); w32(0);

    // Busy/free bit (faithful Win32 heap mechanism — the RtlHeap arena busy/free
    // flag, HEAP_ENTRY_BUSY). The magic check above confirmed this block is BUSY ('A' at
    // [EAX-3], else header != SLAB_MAGIC and we'd be at .slow). Flip 'A'(0x41)→'F'(0x46)
    // so the header becomes 0x534C46xx: ANY re-free now fails the CMP SLAB_MAGIC above
    // → .slow → JS HeapFree no-ops the slab pointer (never re-pushes). This rejects ALL
    // double-frees (consecutive AND non-consecutive `free X; free Y; free X`), not just
    // the self-cycle the old consecutive guard caught. Restored to BUSY on alloc pop.
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
    // MOV EAX, 1          ; B8 01 00 00 00
    w8(0xB8); w32(1);
    // RET 12              ; C2 0C 00
    w8(0xC2); w8(0x0C); w8(0x00);

    // .slow:
    const slowFreeAddr = off;
    // JMP rel32 to kernel32.HeapFree OUT-trap stub
    w8(0xE9);
    const slowFreeJmpRel = off;
    w32(heapFreeTrapStubAddr - (slowFreeJmpRel + 4));

    for (const patchOff of slowFreePatches) {
        dv.setInt32(patchOff, slowFreeAddr - (patchOff + 4), true);
    }
    for (const patchOff of checkPatches) {
        dv.setInt32(patchOff, checkAddr - (patchOff + 4), true);
    }

    Logger.log(LogCategory.SYSTEM,
        `Heap slab stubs emitted: HeapAlloc=0x${heapAllocStub.toString(16)} ` +
        `(${slowAllocAddr - heapAllocStub}B body + 5B slow JMP), ` +
        `HeapFree=0x${heapFreeStub.toString(16)} ` +
        `(${slowFreeAddr - heapFreeStub}B body + 5B slow JMP), ` +
        `slabCtl=0x${slabCtlAddr.toString(16)}, LUT=0x${lutAddr.toString(16)}`);

    return { heapAllocStub, heapFreeStub, regionBase: base, regionEnd: base + HEAP_STUB_REGION_SIZE };
}

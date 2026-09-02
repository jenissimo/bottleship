// thunk-memory-manager.ts
// Manages dynamic memory allocation for thunk system regions
// Replaces hardcoded addresses (0x01F00000, 0x01F80000, 0x02000000) with dynamic allocation

import { Logger, LogCategory } from '../logger';
import { MemoryManager } from '../process';
import type { RegionKind, RegionPerms } from '../memory/address-space';
import { CALLBACK_STUB_SIZE, THUNK_STUB_SIZE, DEFAULT_STUBS_PER_CLEANUP, CLEANUP_AMOUNTS } from './thunk-constants';
import { thunkChecksumManager } from '../memory/thunk-checksum';
import { MEM_THUNK_CODE_BASE, MEM_THUNK_CODE_SIZE } from '../cpu/emulator-config';
import {
    SEH_SCRATCH_LAYOUT,
    SEH_SCRATCH_TOTAL_SIZE,
    EH3_FILTER_CTX_LAYOUT,
    computeSehScratchLayout,
} from './seh-layout';

/**
 * Hypercall funcId (sibling of the 0x7FFF0002 SEH hardware-dispatch result marker)
 * signalling that a C++ catch funclet completed NORMALLY (i.e. did NOT rethrow). The
 * thunk dispatcher responds by popping the current thread's active exception — matching
 * MSVC's __DestructExceptionObject, which runs only when CallCatchBlock returns a
 * non-NULL continuationAddress. A rethrowing funclet `_CxxThrowException`s out and never
 * reaches the gadget, so the exception correctly survives the rethrow chain.
 */
export const SEH_CATCH_COMPLETION_FUNCID = 0x7FFF0003;

export interface ThunkMemoryRegions {
    // Base address for callback return stubs pool
    callbackStubPoolBase: number;
    // Size of callback stub pool (bytes)
    callbackStubPoolSize: number;
    // Base address for spin loop (JMP $) used in async thunks
    spinLoopAddress: number;
    // Size of spin loop region (bytes)
    spinLoopSize: number;
    // Address of JMP EAX gadget (spinLoopAddress + 2), used by SEH catch funclet dispatch
    jmpEaxGadgetAddress: number;
    // Address of the SEH catch-completion gadget (spinLoopAddress + 0xE00). On NORMAL
    // catch-funclet completion, the funclet/trampoline jumps here with EAX = continuation;
    // it OUTs SEH_CATCH_COMPLETION_FUNCID (dispatcher pops the active exception) then JMP EAX.
    catchCompletionGadgetAddress: number;
    // Address of SEH hardware exception dispatch stub (spinLoopAddress + 4)
    sehDispatchStubAddress: number;
    // Address of static _except_handler3 complex-filter stub in THUNK_CODE
    sehFilterStubAddress: number;
    // Base address for thunk generator stubs
    thunkGeneratorBase: number;
    // Size of thunk generator reserved region (bytes)
    thunkGeneratorSize: number;
    // SEH scratch area base address in THUNK_DATA (for EXCEPTION_RECORD, CONTEXT, frame list)
    sehScratchAddr: number;
    // Total scratch size reserved in THUNK_DATA
    sehScratchSize: number;
    // Safe SEH dispatch stack in THUNK_DATA (grows down from sehStackTop)
    sehStackBase: number;
    sehStackTop: number;
    /** Tier-0 write-buffer ring (THUNK_DATA): filled by JMP trampolines, drained at flush triggers */
    writeBufControlAddr: number;      // WBUF_HEAD u32 at [+0], WBUF_OVERFLOW u32 at [+4]
    writeBufDataBase: number;         // ring buffer data (writeBufControlAddr + 16)
    writeBufCapacity: number;         // 256 * 1024 bytes
    writeBufTrampolineBase: number;   // base of trampolines in spin loop page at +0x400
    /** Per-(argCount,convention) trampoline addresses: idx = (argCount-1)*2 + (isStdcall ? 0 : 1) */
    writeBufTrampolineAddrs: number[];
    /** 256-byte LUT in THUNK_DATA mapping (dwBytes-1)>>4 → heap slab bin index (0..8).
     *  Used by inline HeapAlloc x86 stub for fast bin resolution. */
    heapBinLutAddr: number;
    /** GUEST-RAM slab control block (THUNK_DATA). Holds BASE/END/BUMP/GEN/counts +
     *  FREELIST[9] at the SAME relative offsets as the HYPERCALL_PAGE slab fields
     *  (rebased to 0): BASE+0x00, END+0x04, BUMP+0x08, GEN+0x0C, ALLOC+0x10, FREE+0x14,
     *  FALLBACK+0x18, FREELIST+0x20. The inline x86 HeapAlloc/HeapFree stubs read/write
     *  these via absolute guest operands — the HYPERCALL_PAGE static is below guest RAM
     *  and unreachable from guest code, so the shared control block MUST live here. */
    slabControlAddr: number;
}

/**
 * Narrow allocation surface handed to the external x86 stub/trampoline emitters
 * (kernel32/heap-slab-stubs, crt-slab-stubs, d3d9/capture-trampolines). Signature
 * matches {@link MemoryManager.alloc} exactly; obtain it via
 * {@link ThunkMemoryManager.stubAllocator}.
 */
export interface StubAllocator {
    alloc(size: number, kind?: RegionKind, perms?: RegionPerms, alignment?: number): number;
}

/**
 * Manages memory regions for thunk system components
 * Allocates safe regions that don't conflict with emulated application memory
 */
export class ThunkMemoryManager {
    private regions: ThunkMemoryRegions | null = null;
    private memoryManager: MemoryManager | null = null;

    /**
     * Initialize thunk memory regions
     * Must be called after MemoryManager is available
     *
     * @param memoryManager - Process memory manager for allocation tracking
     * @param getMemory - Function to get memory array for validation
     * @param options - Optional configuration
     */
    async initialize(
        memoryManager: MemoryManager,
        getMemory: () => Uint8Array,
        options?: { skipChecksums?: boolean }
    ): Promise<void> {
        this.memoryManager = memoryManager;
        const mem = getMemory();
        const memSize = mem.length;

        // Calculate required sizes
        // Callback stub pool: CLEANUP_AMOUNTS.length * stubsPerCleanup * stubSize
        const callbackStubPoolSize = CLEANUP_AMOUNTS.length * DEFAULT_STUBS_PER_CLEANUP * CALLBACK_STUB_SIZE;
        
        // Thunk generator: we'll allocate on-demand, but reserve initial chunk
        // Increased from 64KB to 1MB to avoid conflicts with heap
        const initialThunkGeneratorSize = 1024 * 1024;
        
        // Spin loop: just 2 bytes (JMP $), but allocate a page (4KB) for safety
        const spinLoopSize = 0x1000;

        // Allocate thunks at configured THUNK_CODE region (see emulator-config.ts)
        // PE modules load at MEM_ROM_BASE+ ImageBase
        const preferredBase = MEM_THUNK_CODE_BASE;
        
        // But we need to be safe - check if we can use specific regions
        // Fallback: use bump allocator from memory manager
        let callbackStubPoolBase: number;
        let spinLoopAddress: number;
        let thunkGeneratorBase: number;

        try {
            // Allocate regions CONTIGUOUSLY to avoid gaps
            // If we leave gaps, MemoryManager.alloc() will reuse them and corrupt thunk code!
            callbackStubPoolBase = preferredBase;
            spinLoopAddress = callbackStubPoolBase + callbackStubPoolSize;  // Immediately after callbacks
            thunkGeneratorBase = spinLoopAddress + spinLoopSize;  // Immediately after spin loop

            // Validate all regions fit in memory
            const maxAddr = Math.max(
                callbackStubPoolBase + callbackStubPoolSize,
                spinLoopAddress + spinLoopSize,
                thunkGeneratorBase + initialThunkGeneratorSize
            );

            if (maxAddr >= memSize) {
                // Preferred region too high, use bump allocator instead
                Logger.warn(LogCategory.SYSTEM, 
                    `Preferred thunk memory region too high (max: 0x${maxAddr.toString(16)}, mem: 0x${memSize.toString(16)}), using bump allocator`);
                
                // Use MemoryManager's bump allocator (starts at 0x03000000)
                // Allocate sequentially
                callbackStubPoolBase = memoryManager.alloc(callbackStubPoolSize, "CALLBACK_STUB");
                spinLoopAddress = memoryManager.alloc(spinLoopSize, "SPIN_LOOP");
                thunkGeneratorBase = memoryManager.alloc(initialThunkGeneratorSize, "THUNK_CODE", "rx");
            } else {
                // Try to reserve preferred addresses
                // Note: allocAt may fail if address is already reserved
                // In that case, fall back to bump allocator
                try {
                    memoryManager.allocAt(callbackStubPoolBase, callbackStubPoolSize, "CALLBACK_STUB");
                    memoryManager.allocAt(spinLoopAddress, spinLoopSize, "SPIN_LOOP");
                    memoryManager.allocAt(thunkGeneratorBase, initialThunkGeneratorSize, "THUNK_CODE", "rx");
                } catch (e) {
                    // Preferred addresses in use, fall back to bump allocator
                    Logger.warn(LogCategory.SYSTEM, 
                        `Preferred thunk memory addresses in use, falling back to bump allocator: ${e}`);
                    callbackStubPoolBase = memoryManager.alloc(callbackStubPoolSize, "CALLBACK_STUB");
                    spinLoopAddress = memoryManager.alloc(spinLoopSize, "SPIN_LOOP");
                    thunkGeneratorBase = memoryManager.alloc(initialThunkGeneratorSize, "THUNK_CODE", "rx");
                }
            }
        } catch (e) {
            // Fallback: use bump allocator
            Logger.warn(LogCategory.SYSTEM, `Thunk memory allocation error, using bump allocator: ${e}`);
            callbackStubPoolBase = memoryManager.alloc(callbackStubPoolSize, "CALLBACK_STUB");
            spinLoopAddress = memoryManager.alloc(spinLoopSize, "SPIN_LOOP");
            thunkGeneratorBase = memoryManager.alloc(initialThunkGeneratorSize, "THUNK_CODE", "rx");
        }

        // Allocate Tier-0 write-buffer ring in THUNK_DATA.
        // Control block (16B) + ring data (256KB) are adjacent.
        const WBUF_CTRL_ALIGN = 16;
        const WBUF_DATA_CAP = 512 * 1024;
        const writeBufControlAddr = memoryManager.alloc(WBUF_CTRL_ALIGN + WBUF_DATA_CAP, 'THUNK_DATA');
        const writeBufDataBase = writeBufControlAddr + WBUF_CTRL_ALIGN;
        const writeBufTrampolineBase = spinLoopAddress + 0x400; // spare space in spin-loop page

        // 256-byte bin LUT for inline HeapAlloc stub. Entry i = ceil(log2(i+1)), clamp 0..8.
        // dwBytes (1..4096) → i = (dwBytes-1)>>4, i ∈ [0..255].
        const heapBinLutAddr = memoryManager.alloc(256, 'THUNK_DATA');
        for (let i = 0; i < 256; i++) {
            let bin = 0;
            let cap = 1;
            while (cap < i + 1) { cap <<= 1; bin++; }
            mem[heapBinLutAddr + i] = bin;
        }

        // Guest-RAM slab control block (zero-initialised). Layout = HYPERCALL_PAGE slab
        // fields rebased to 0 (FREELIST ends at 0x20+9*4 = 0x44); 128B gives slack.
        const slabControlAddr = memoryManager.alloc(128, 'THUNK_DATA');
        mem.fill(0, slabControlAddr, slabControlAddr + 128);

        this.regions = {
            callbackStubPoolBase,
            callbackStubPoolSize,
            spinLoopAddress,
            spinLoopSize,
            jmpEaxGadgetAddress: spinLoopAddress + 2,
            catchCompletionGadgetAddress: spinLoopAddress + 0xE00, // spare space in spin-loop page (trampolines end well before here)
            sehDispatchStubAddress: spinLoopAddress + 4,
            sehFilterStubAddress: spinLoopAddress + 0x200,
            thunkGeneratorBase,
            thunkGeneratorSize: initialThunkGeneratorSize,
            sehScratchAddr: 0, // Set later by setSehScratchAddr() after THUNK_DATA allocation
            sehScratchSize: 0,
            sehStackBase: 0,
            sehStackTop: 0,
            writeBufControlAddr,
            writeBufDataBase,
            writeBufCapacity: WBUF_DATA_CAP,
            writeBufTrampolineBase,
            writeBufTrampolineAddrs: [], // filled below after stubs are written
            heapBinLutAddr,
            slabControlAddr,
        };

        // Initialize spin loop code (EB FE - JMP $, infinite loop)
        // This must be done BEFORE checksums are calculated
        if (spinLoopSize >= 4) {
            mem[spinLoopAddress] = 0xEB;  // JMP rel8
            mem[spinLoopAddress + 1] = 0xFE;  // -2 (jump to self)
            // JMP EAX gadget at +2: used by SEH dispatch for VC7+ catch funclets
            // When a funclet RETs to this gadget, JMP EAX redirects to the continuation address
            mem[spinLoopAddress + 2] = 0xFF;  // JMP EAX
            mem[spinLoopAddress + 3] = 0xE0;
        }

        // Write SEH hardware exception dispatch stub at spinLoop+4
        // This stub is called via IRET redirect when a #PF has SEH handlers
        // that can't be evaluated statically. It calls each handler natively,
        // letting x86 execute the filter functions.
        const sehStubAddr = spinLoopAddress + 4;
        this.writeSehDispatchStub(mem, sehStubAddr);
        this.writeEh3FilterStub(mem, this.regions.sehFilterStubAddress);

        // Catch-completion gadget at spinLoop+0xE00. On NORMAL catch-funclet completion the
        // funclet/trampoline jumps here with EAX = the catch continuation address. It saves
        // EAX, signals SEH_CATCH_COMPLETION_FUNCID (→ dispatcher pops the active exception),
        // restores EAX and jumps to the continuation. A rethrowing funclet _CxxThrowException's
        // out and never reaches here, so the exception survives the rethrow chain (matches
        // MSVC: object destroyed only on non-NULL continuationAddress).
        //   50              push eax
        //   B8 <funcId>     mov eax, SEH_CATCH_COMPLETION_FUNCID
        //   BA 77 B0 00 00  mov edx, 0xB077
        //   EF              out dx, eax
        //   58              pop eax
        //   FF E0           jmp eax
        {
            let o = this.regions.catchCompletionGadgetAddress;
            const fid = SEH_CATCH_COMPLETION_FUNCID >>> 0;
            mem[o++] = 0x50;
            mem[o++] = 0xB8; mem[o++] = fid & 0xff; mem[o++] = (fid >>> 8) & 0xff; mem[o++] = (fid >>> 16) & 0xff; mem[o++] = (fid >>> 24) & 0xff;
            mem[o++] = 0xBA; mem[o++] = 0x77; mem[o++] = 0xB0; mem[o++] = 0x00; mem[o++] = 0x00;
            mem[o++] = 0xEF;
            mem[o++] = 0x58;
            mem[o++] = 0xFF; mem[o++] = 0xE0;
        }

        // Write Tier-0 write-buffer trampolines in the spare area of the spin-loop page.
        // 16 standard + 4 PtrDeref + 1 D3D9 shader-constant (variable float vector).
        // All addresses are hardcoded as imm32 in the x86 so trampolines are written
        // after the THUNK_DATA alloc above.
        this.regions.writeBufTrampolineAddrs = this.writeWriteBufTrampolines(
            mem, writeBufTrampolineBase, writeBufControlAddr, writeBufDataBase, WBUF_DATA_CAP);

        // Compute checksums if requested (usually skipped during construction, computed later)
        if (!options?.skipChecksums) {
            await this.computeChecksumsInternal(mem);
        }

        // DIAGNOSTIC: Verify contiguous allocation (no gaps that could be reused)
        const callbackEnd = callbackStubPoolBase + callbackStubPoolSize;
        const spinEnd = spinLoopAddress + spinLoopSize;
        const thunkEnd = thunkGeneratorBase + initialThunkGeneratorSize;

        const gap1 = spinLoopAddress - callbackEnd;
        const gap2 = thunkGeneratorBase - spinEnd;

        if (gap1 !== 0 || gap2 !== 0) {
            Logger.warn(LogCategory.SYSTEM,
                `⚠️ Thunk regions have GAPS! ` +
                `Gap1=${gap1} (0x${gap1.toString(16)}) Gap2=${gap2} (0x${gap2.toString(16)}). ` +
                `These gaps can be allocated by MemoryManager and corrupt thunk code!`);
        }

        Logger.log(LogCategory.SYSTEM,
            `ThunkMemoryManager initialized: ` +
            `callbackStubs=0x${callbackStubPoolBase.toString(16)}..0x${callbackEnd.toString(16)}, ` +
            `spinLoop=0x${spinLoopAddress.toString(16)}..0x${spinEnd.toString(16)}, ` +
            `thunkBase=0x${thunkGeneratorBase.toString(16)}..0x${thunkEnd.toString(16)} ` +
            `(total=${((thunkEnd - callbackStubPoolBase) / 1024).toFixed(0)}KB, gaps: ${gap1}+${gap2})`);

        // DIAGNOSTIC: Warn if spinLoop is not in expected region
        const thunkCodeEnd = MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE;
        if (spinLoopAddress < MEM_THUNK_CODE_BASE || spinLoopAddress >= thunkCodeEnd) {
            Logger.warn(LogCategory.SYSTEM,
                `⚠️ spinLoopAddress 0x${spinLoopAddress.toString(16)} is OUTSIDE expected THUNK_CODE region ` +
                `(0x${MEM_THUNK_CODE_BASE.toString(16)}-0x${thunkCodeEnd.toString(16)})! ` +
                `This will cause async thunks to redirect to wrong address.`);
        }
    }

    /**
     * Get allocated memory regions
     * Throws if not initialized
     */
    getRegions(): ThunkMemoryRegions {
        if (!this.regions) {
            throw new Error('ThunkMemoryManager not initialized. Call initialize() first.');
        }
        return this.regions;
    }

    /**
     * Compute checksums for static thunk regions
     * Should be called AFTER all static code is written (callback stubs, spin loop)
     */
    async computeChecksums(getMemory: () => Uint8Array): Promise<void> {
        const mem = getMemory();
        await this.computeChecksumsInternal(mem);
    }

    /**
     * Internal: Compute checksums for static thunk regions
     */
    private async computeChecksumsInternal(mem: Uint8Array): Promise<void> {
        if (!this.regions) {
            throw new Error('ThunkMemoryManager not initialized');
        }

        // Protect STATIC regions only (callback stubs + spin loop)
        // Do NOT include thunkGeneratorBase - it's DYNAMIC (code written on-demand)
        const { callbackStubPoolBase, spinLoopAddress, spinLoopSize, thunkGeneratorBase, thunkGeneratorSize } = this.regions;

        const staticRegionBase = callbackStubPoolBase;
        const staticRegionSize = (spinLoopAddress + spinLoopSize) - callbackStubPoolBase;

        Logger.log(LogCategory.SYSTEM,
            `ThunkChecksum: Protecting STATIC regions ` +
            `(0x${staticRegionBase.toString(16)}..0x${(staticRegionBase + staticRegionSize).toString(16)}, ` +
            `size=0x${staticRegionSize.toString(16)}). ` +
            `Thunk generator (0x${thunkGeneratorBase.toString(16)}..0x${(thunkGeneratorBase + thunkGeneratorSize).toString(16)}) is DYNAMIC and NOT protected.`);

        await thunkChecksumManager.initializeThunkRegion(
            mem,
            staticRegionBase,
            staticRegionSize
        );
    }

    /**
     * Reset and clear allocations (for process reset)
     */
    reset(): void {
        // Memory is managed by MemoryManager, so we just clear our references
        this.regions = null;
        // Note: We don't free memory here - MemoryManager will handle it on process reset
    }

    /**
     * Set the SEH scratch area address (allocated in THUNK_DATA by process.ts).
     */
    setSehScratchAddr(addr: number, size: number = SEH_SCRATCH_TOTAL_SIZE): void {
        if (!this.regions) {
            throw new Error('ThunkMemoryManager not initialized');
        }
        this.regions.sehScratchAddr = addr;
        this.regions.sehScratchSize = size >>> 0;
        const { stackBase, stackTop } = computeSehScratchLayout(addr >>> 0, size >>> 0);
        this.regions.sehStackBase = stackBase;
        this.regions.sehStackTop = stackTop;
    }

    /**
     * Write the SEH hardware exception dispatch stub at the given address.
     * ~64 bytes of x86 machine code in the spin loop page.
     *
     * The stub expects EDI = sehScratchAddr (paramBase) set by JS before IRET.
     * Layout of scratch area:
     *   +0x000  EXCEPTION_RECORD (80 bytes)
     *   +0x050  CONTEXT (716 bytes)
     *   +0x31C  EXCEPTION_POINTERS (8 bytes)
     *   +0x324  dispatch_result (4 bytes): 0=ContinueExec, 1=unhandled
     *   +0x328  faulting_eip (4 bytes)
     *   +0x32C  safe_esp (4 bytes, always in THUNK_DATA)
     *   +0x330  frame_list (up to 64 entries + sentinel)
     */
    private writeSehDispatchStub(mem: Uint8Array, addr: number): void {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let off = addr;

        // seh_dispatch_stub:
        //   MOV ESP, [EDI + SAFE_ESP] ; safe ESP in THUNK_DATA
        mem[off++] = 0x8B; mem[off++] = 0xA7;      // MOV ESP, [EDI+disp32]
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.SAFE_ESP, true); off += 4;

        //   LEA ESI, [EDI + FRAME_LIST] ; frame list start
        mem[off++] = 0x8D; mem[off++] = 0xB7;      // LEA ESI, [EDI+disp32]
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.FRAME_LIST, true); off += 4;

        // .loop:
        const loopAddr = off;
        //   LODSD                      ; EAX = [ESI], ESI += 4
        mem[off++] = 0xAD;

        //   CMP EAX, -1               ; sentinel?
        mem[off++] = 0x3D;
        dv.setUint32(off, 0xFFFFFFFF, true); off += 4;

        //   JE .unhandled              ; (patched below)
        mem[off++] = 0x0F; mem[off++] = 0x84;
        const jeUnhandledPatchPos = off;
        off += 4; // placeholder for rel32

        //   MOV EBX, EAX              ; EBX = frame address
        mem[off++] = 0x89; mem[off++] = 0xC3;

        //   MOV [EDI + LAST_HANDLER_FRAME], EBX
        mem[off++] = 0x89; mem[off++] = 0x9F;
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.LAST_HANDLER_FRAME, true); off += 4;
        //   MOV ECX, [EBX + 4]        ; handler address
        mem[off++] = 0x8B; mem[off++] = 0x4B; mem[off++] = 0x04;
        //   MOV [EDI + LAST_HANDLER_ADDR], ECX
        mem[off++] = 0x89; mem[off++] = 0x8F;
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.LAST_HANDLER_ADDR, true); off += 4;

        // Preserve scratch/frame list base across handler calls.
        // Some legacy runtime handlers are naked/non-standard and may clobber
        // callee-saved registers despite cdecl ABI expectations.
        //   PUSH EDI
        mem[off++] = 0x57;
        //   PUSH ESI
        mem[off++] = 0x56;

        //   PUSH EBX                   ; DispatcherContext (legacy handlers may require non-NULL)
        mem[off++] = 0x53;

        //   LEA ECX, [EDI + CONTEXT]   ; Context*
        mem[off++] = 0x8D; mem[off++] = 0x8F;
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.CONTEXT, true); off += 4;
        //   PUSH ECX
        mem[off++] = 0x51;

        //   PUSH EBX                   ; EstablisherFrame
        mem[off++] = 0x53;

        //   PUSH EDI                   ; ExceptionRecord*
        mem[off++] = 0x57;

        //   CALL [EBX + 4]             ; call handler from SEH frame
        mem[off++] = 0xFF; mem[off++] = 0x53; mem[off++] = 0x04;

        //   ADD ESP, 16                ; cdecl cleanup
        mem[off++] = 0x83; mem[off++] = 0xC4; mem[off++] = 0x10;

        //   POP ESI
        mem[off++] = 0x5E;
        //   POP EDI
        mem[off++] = 0x5F;

        //   MOV [EDI + LAST_HANDLER_RESULT], EAX
        mem[off++] = 0x89; mem[off++] = 0x87;
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.LAST_HANDLER_RESULT, true); off += 4;

        //   TEST EAX, EAX              ; 0 = ContinueExecution?
        mem[off++] = 0x85; mem[off++] = 0xC0;

        //   JZ .continue_exec          ; (patched below)
        mem[off++] = 0x0F; mem[off++] = 0x84;
        const jzContinuePatchPos = off;
        off += 4; // placeholder for rel32

        // Legacy CRTs may return -1 for "dismiss/continue execution".
        //   CMP EAX, -1
        mem[off++] = 0x83; mem[off++] = 0xF8; mem[off++] = 0xFF;
        //   JE .continue_exec
        mem[off++] = 0x0F; mem[off++] = 0x84;
        const jeMinusOneContinuePatchPos = off;
        off += 4; // placeholder for rel32

        //   JMP .loop
        mem[off++] = 0xE9;
        dv.setInt32(off, loopAddr - (off + 4), true); off += 4;

        // .continue_exec:
        const continueExecAddr = off;
        //   MOV DWORD [EDI + DISPATCH_RESULT], 0 ; ContinueExecution
        mem[off++] = 0xC7; mem[off++] = 0x87;
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.DISPATCH_RESULT, true); off += 4;
        dv.setUint32(off, 0, true); off += 4;
        //   JMP .signal
        mem[off++] = 0xEB;
        const jmpSignalPatchPos = off;
        off += 1; // placeholder for rel8

        // .unhandled:
        const unhandledAddr = off;
        //   MOV DWORD [EDI + DISPATCH_RESULT], 1 ; unhandled
        mem[off++] = 0xC7; mem[off++] = 0x87;
        dv.setUint32(off, SEH_SCRATCH_LAYOUT.DISPATCH_RESULT, true); off += 4;
        dv.setUint32(off, 1, true); off += 4;

        // .signal:
        const signalAddr = off;
        //   MOV EAX, 0x7FFF0002        ; SEH_DISPATCH_RESULT marker
        mem[off++] = 0xB8;
        dv.setUint32(off, 0x7FFF0002, true); off += 4;
        //   MOV EDX, 0xB077            ; port
        mem[off++] = 0xBA;
        dv.setUint32(off, 0xB077, true); off += 4;
        //   OUT DX, EAX
        mem[off++] = 0xEF;
        //   RET                         ; RET pops JS-written target
        mem[off++] = 0xC3;

        // Patch jump offsets
        dv.setInt32(jeUnhandledPatchPos, unhandledAddr - (jeUnhandledPatchPos + 4), true);
        dv.setInt32(jzContinuePatchPos, continueExecAddr - (jzContinuePatchPos + 4), true);
        dv.setInt32(jeMinusOneContinuePatchPos, continueExecAddr - (jeMinusOneContinuePatchPos + 4), true);
        mem[jmpSignalPatchPos] = signalAddr - (jmpSignalPatchPos + 1);

        const stubSize = off - addr;
        Logger.log(LogCategory.SYSTEM,
            `SEH dispatch stub written at 0x${addr.toString(16)} (${stubSize} bytes)`);
    }

    /**
     * Write a static EH3 complex-filter stub in THUNK_CODE.
     *
     * Contract:
     *  - EDI = sehScratchAddr
     *  - Context lives at [EDI + EH3_FILTER_CTX]
     *  - For CONTINUE_SEARCH / CONTINUE_EXECUTION, stub JMPs to saved continuation EIP
     *    (so ESP stays exactly as if handler returned normally to seh_dispatch_stub).
     *  - For EXECUTE_HANDLER, stub patches trylevel, sets EBP/ESP and JMPs to handler.
     */
    private writeEh3FilterStub(mem: Uint8Array, addr: number): void {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const ctx = SEH_SCRATCH_LAYOUT.EH3_FILTER_CTX;
        let off = addr;

        // MOV EAX, [EDI + ctx.filterAddr]
        mem[off++] = 0x8B; mem[off++] = 0x87;
        dv.setUint32(off, ctx + EH3_FILTER_CTX_LAYOUT.FILTER_ADDR, true); off += 4;
        // CALL EAX
        mem[off++] = 0xFF; mem[off++] = 0xD0;

        // CMP EAX, 1
        mem[off++] = 0x83; mem[off++] = 0xF8; mem[off++] = 0x01;
        // JE .catch
        mem[off++] = 0x0F; mem[off++] = 0x84;
        const jeCatchPatchPos = off;
        off += 4;

        // CMP EAX, -1
        mem[off++] = 0x83; mem[off++] = 0xF8; mem[off++] = 0xFF;
        // JE .continue_exec
        mem[off++] = 0x0F; mem[off++] = 0x84;
        const jeContinueExecPatchPos = off;
        off += 4;

        // default: CONTINUE_SEARCH => EAX = 1
        mem[off++] = 0xB8;
        dv.setUint32(off, 1, true); off += 4;
        // JMP .return_to_dispatch
        mem[off++] = 0xE9;
        const jmpReturnFromSearchPatchPos = off;
        off += 4;

        const continueExecAddr = off;
        // CONTINUE_EXECUTION => EAX = 0
        mem[off++] = 0x33; mem[off++] = 0xC0;
        // JMP .return_to_dispatch
        mem[off++] = 0xE9;
        const jmpReturnFromContinueExecPatchPos = off;
        off += 4;

        const catchAddr = off;
        // MOV EBX, [EDI + ctx.frameAddr]
        mem[off++] = 0x8B; mem[off++] = 0x9F;
        dv.setUint32(off, ctx + EH3_FILTER_CTX_LAYOUT.FRAME_ADDR, true); off += 4;
        // MOV ECX, [EDI + ctx.prevTryLevel]
        mem[off++] = 0x8B; mem[off++] = 0x8F;
        dv.setUint32(off, ctx + EH3_FILTER_CTX_LAYOUT.PREV_TRY_LEVEL, true); off += 4;
        // MOV [EBX + 0x0C], ECX   ; trylevel = prevLevel
        mem[off++] = 0x89; mem[off++] = 0x4B; mem[off++] = 0x0C;
        // MOV EBP, [EDI + ctx.frameEbp]
        mem[off++] = 0x8B; mem[off++] = 0xAF;
        dv.setUint32(off, ctx + EH3_FILTER_CTX_LAYOUT.FRAME_EBP, true); off += 4;
        // MOV ESP, EBX            ; _JumpToContinuation contract
        mem[off++] = 0x89; mem[off++] = 0xDC;
        // MOV EAX, [EDI + ctx.handlerAddr]
        mem[off++] = 0x8B; mem[off++] = 0x87;
        dv.setUint32(off, ctx + EH3_FILTER_CTX_LAYOUT.HANDLER_ADDR, true); off += 4;
        // JMP EAX
        mem[off++] = 0xFF; mem[off++] = 0xE0;

        const returnToDispatchAddr = off;
        // MOV ECX, [EDI + ctx.continuationEip]
        mem[off++] = 0x8B; mem[off++] = 0x8F;
        dv.setUint32(off, ctx + EH3_FILTER_CTX_LAYOUT.CONTINUATION_EIP, true); off += 4;
        // JMP ECX
        mem[off++] = 0xFF; mem[off++] = 0xE1;

        dv.setInt32(jeCatchPatchPos, catchAddr - (jeCatchPatchPos + 4), true);
        dv.setInt32(jeContinueExecPatchPos, continueExecAddr - (jeContinueExecPatchPos + 4), true);
        dv.setInt32(jmpReturnFromSearchPatchPos, returnToDispatchAddr - (jmpReturnFromSearchPatchPos + 4), true);
        dv.setInt32(jmpReturnFromContinueExecPatchPos, returnToDispatchAddr - (jmpReturnFromContinueExecPatchPos + 4), true);

        const stubSize = off - addr;
        Logger.log(LogCategory.SYSTEM,
            `SEH eh3_filter_stub written at 0x${addr.toString(16)} (${stubSize} bytes)`);
    }

    /**
     * Write the Tier-0 write-buffer trampolines into the spare area of the spin-loop page.
     *
     * Generates 16 trampolines: (argCount 1–8) × (stdcall / cdecl).
     * Each trampoline:
     *   1. Reads WBUF_HEAD from THUNK_DATA control block.
     *   2. If head < capacity: writes [funcId, arg0…argN] to the ring, advances head, returns 0.
     *   3. If overflow: falls back to OUT 0xB077 (same as original stub), returns normally.
     *
     * Stack layout on entry (EAX = funcId set by the MOV EAX stub prefix, no CALL — JMP):
     *   [ESP+0]  = return address
     *   [ESP+4]  = arg0
     *   [ESP+8]  = arg1  …  [ESP+4+N*4] = argN-1
     *
     * Two PUSH (EDX, EBX) shift args up by 8 bytes inside the trampoline body.
     *
     * @returns Array of trampoline addresses indexed by (argCount-1)*2 + (isStdcall ? 0 : 1)
     */
    private writeWriteBufTrampolines(
        mem: Uint8Array,
        base: number,
        ctrlAddr: number,
        dataBase: number,
        capacity: number,
    ): number[] {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const addrs: number[] = new Array(21);  // 16 standard + 4 PtrDeref + 1 shader-constant
        let off = base;
        const lean = (globalThis as { __wbufLeanTrampolines?: boolean }).__wbufLeanTrampolines === true;

        // The trampoline's capacity check is `cmp head, LIMIT; jge overflow` BEFORE
        // writing the entry — it must leave room for the LARGEST entry (funcId + 8
        // args = 36 bytes), else a near-full ring writes past the data region.
        const capacityLimit = capacity - 36;

        const w8  = (v: number) => { mem[off++] = v & 0xFF; };
        const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

        for (let argCount = 1; argCount <= 8; argCount++) {
            for (let isStdcallInt = 0; isStdcallInt <= 1; isStdcallInt++) {
                const isStdcall = isStdcallInt === 0;
                const idx = (argCount - 1) * 2 + isStdcallInt;
                addrs[idx] = off;

                if (lean) {
                    // EAX/ECX/EDX and EFLAGS are caller-saved in the 32-bit Windows ABI.
                    // Keep every callee-saved register untouched and use no stack frame:
                    // EDX=head, ECX=&ring[head], EAX=funcId then argument scratch.
                    w8(0x8B); w8(0x15); w32(ctrlAddr); // mov edx, [ctrlAddr]
                    w8(0x81); w8(0xFA); w32(capacityLimit); // cmp edx, limit
                    w8(0x0F); w8(0x8D); // jge .overflow
                    const leanJgePatchOff = off; w32(0);
                    w8(0xB9); w32(dataBase); // mov ecx, dataBase
                    w8(0x01); w8(0xD1); // add ecx, edx
                    w8(0x89); w8(0x01); // mov [ecx], eax
                    for (let i = 0; i < argCount; i++) {
                        const stackOff = 4 + i * 4;
                        const bufOff = (i + 1) * 4;
                        w8(0x8B); w8(0x44); w8(0x24); w8(stackOff); // mov eax,[esp+off]
                        w8(0x89); w8(0x41); w8(bufOff); // mov [ecx+off],eax
                    }
                    w8(0x83); w8(0x05); w32(ctrlAddr); w8((argCount + 1) * 4);
                    w8(0xBA); w32(0xB077); // preserve the canonical thunk EDX result
                    w8(0x31); w8(0xC0); // xor eax,eax
                    const bytesToPop = argCount * 4;
                    if (isStdcall) { w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF); }
                    else           { w8(0xC3); }

                    const leanOverflowAddr = off;
                    w8(0xBA); w32(0xB077);
                    w8(0xEF); // EAX is still funcId: capacity check precedes all argument loads
                    if (isStdcall) { w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF); }
                    else           { w8(0xC3); }
                    dv.setInt32(leanJgePatchOff, leanOverflowAddr - (leanJgePatchOff + 4), true);
                    continue;
                }

                // pushfd (save EFLAGS — trampoline must not clobber flags, matching OUT-trap behavior)
                w8(0x9C);
                // push edx (save EDX, used as head register)
                w8(0x52);
                // push ebx (save EBX, used as ring write pointer)
                w8(0x53);
                // mov edx, [ctrlAddr]  — load WBUF_HEAD byte offset
                w8(0x8B); w8(0x15); w32(ctrlAddr);
                // cmp edx, capacity
                w8(0x81); w8(0xFA); w32(capacityLimit);
                // jge .overflow (near, rel32 patched below)
                w8(0x0F); w8(0x8D);
                const jgePatchOff = off; w32(0);

                // mov ebx, dataBase
                w8(0xBB); w32(dataBase);
                // add ebx, edx  — ebx = &ring[head]
                w8(0x03); w8(0xDA);
                // mov [ebx], eax  — write funcId
                w8(0x89); w8(0x03);

                // Per-arg: read from [esp + 16 + i*4] (3 pushes + ret addr = 16),
                // write to [ebx + (i+1)*4].
                for (let i = 0; i < argCount; i++) {
                    const stackOff = 16 + i * 4;     // 3 pushes (EFLAGS+EDX+EBX) + ret addr = 16
                    const bufOff   = (i + 1) * 4;     // disp8 ≤ 32
                    // mov eax, [esp + stackOff]
                    w8(0x8B); w8(0x44); w8(0x24); w8(stackOff);
                    // mov [ebx + bufOff], eax
                    w8(0x89); w8(0x43); w8(bufOff);
                }

                // add dword [ctrlAddr], stride  (stride = (argCount+1)*4, fits in imm8)
                w8(0x83); w8(0x05); w32(ctrlAddr); w8((argCount + 1) * 4);
                // pop ebx
                w8(0x5B);
                // pop edx
                w8(0x5A);
                // mov edx, 0xB077  (clobber EDX to match OUT-trap stub behavior)
                w8(0xBA); w32(0xB077);
                // xor eax, eax  (return 0)
                w8(0x31); w8(0xC0);
                // popfd (restore original EFLAGS — must come after XOR to avoid re-clobbering)
                w8(0x9D);
                // ret N (stdcall) or ret (cdecl)
                const bytesToPop = argCount * 4;
                if (isStdcall) { w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF); }
                else           { w8(0xC3); }

                // .overflow: restore regs, fall back to OUT trap (EAX still holds funcId)
                const overflowAddr = off;
                w8(0x5B); // pop ebx
                w8(0x5A); // pop edx
                w8(0x9D); // popfd (restore EFLAGS before falling back to OUT trap)
                w8(0xBA); w32(0xB077); // mov edx, 0xB077
                w8(0xEF); // out dx, eax
                if (isStdcall) { w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF); }
                else           { w8(0xC3); }

                // Patch jge rel32
                dv.setInt32(jgePatchOff, overflowAddr - (jgePatchOff + 4), true);
            }
        }

        // --- PtrDeref trampolines ---
        // These dereference a float* pointer inline, writing the actual float values
        // to the ring buffer.  Indices: 16=PtrDeref3F stdcall, 17=PtrDeref3F cdecl,
        //                               18=PtrDeref2F stdcall, 19=PtrDeref2F cdecl.
        // Drain side is identical to scalar variants (reads floatCount u32s from ring).
        for (let floatCount = 3; floatCount >= 2; floatCount--) {
            for (let isStdcallInt = 0; isStdcallInt <= 1; isStdcallInt++) {
                const isStdcall = isStdcallInt === 0;
                const idx = floatCount === 3 ? (16 + isStdcallInt) : (18 + isStdcallInt);
                addrs[idx] = off;

                const stride = (floatCount + 1) * 4;  // funcId + N floats

                // pushfd
                w8(0x9C);
                // push edx
                w8(0x52);
                // push ebx
                w8(0x53);
                // push ecx  (need extra reg for pointer deref)
                w8(0x51);
                // Stack: [ESP+0]=ECX [+4]=EBX [+8]=EDX [+12]=EFLAGS [+16]=retAddr [+20]=ptr

                // mov edx, [ctrlAddr]  — load WBUF_HEAD
                w8(0x8B); w8(0x15); w32(ctrlAddr);
                // cmp edx, capacity
                w8(0x81); w8(0xFA); w32(capacityLimit);
                // jge .overflow
                w8(0x0F); w8(0x8D);
                const jgePatchOff = off; w32(0);

                // mov ebx, dataBase
                w8(0xBB); w32(dataBase);
                // add ebx, edx  — ebx = &ring[head]
                w8(0x03); w8(0xDA);
                // mov [ebx], eax  — write funcId
                w8(0x89); w8(0x03);

                // mov ecx, [esp+20]  — ECX = float* ptr
                w8(0x8B); w8(0x4C); w8(0x24); w8(20);

                // Dereference floats from [ecx] into ring buffer
                for (let i = 0; i < floatCount; i++) {
                    // mov eax, [ecx + i*4]
                    if (i === 0) {
                        w8(0x8B); w8(0x01);  // mov eax, [ecx]
                    } else {
                        w8(0x8B); w8(0x41); w8(i * 4);  // mov eax, [ecx + disp8]
                    }
                    // mov [ebx + (i+1)*4], eax
                    w8(0x89); w8(0x43); w8((i + 1) * 4);
                }

                // add dword [ctrlAddr], stride
                w8(0x83); w8(0x05); w32(ctrlAddr); w8(stride);
                // pop ecx
                w8(0x59);
                // pop ebx
                w8(0x5B);
                // pop edx
                w8(0x5A);
                // xor eax, eax  (return 0)
                w8(0x31); w8(0xC0);
                // popfd
                w8(0x9D);
                // ret 4 (stdcall: pop 1 ptr arg) or ret (cdecl)
                if (isStdcall) { w8(0xC2); w8(0x04); w8(0x00); }
                else           { w8(0xC3); }

                // .overflow: restore regs, fall back to OUT trap
                const overflowAddr = off;
                w8(0x59); // pop ecx
                w8(0x5B); // pop ebx
                w8(0x5A); // pop edx
                w8(0x9D); // popfd
                w8(0xBA); w32(0xB077); // mov edx, 0xB077
                w8(0xEF); // out dx, eax
                if (isStdcall) { w8(0xC2); w8(0x04); w8(0x00); }
                else           { w8(0xC3); }

                // Patch jge rel32
                dv.setInt32(jgePatchOff, overflowAddr - (jgePatchOff + 4), true);
            }
        }

        // --- D3D9 shader-constant trampoline (index 20) ---
        // IDirect3DDevice9_Set*ShaderConstantF(this, StartRegister, pConstantData, Vector4fCount)
        // Captures float bits inline at call time (guest may reuse pConstantData before drain).
        // Ring entry: funcId, thisPtr, startReg, vec4Count, [vec4Count×4 float bits].
        // Drain stride is variable: (4 + vec4Count×4) × 4 bytes.
        {
            const idx = 20;
            const maxVec4 = 256;
            addrs[idx] = off;

            if (lean) {
                // Preserve only ESI/EDI (callee-saved) plus funcId. ECX/EDX/EFLAGS are
                // caller-saved, while EBX is not touched. Stack after the three pushes:
                // [0]=funcId [4]=old EDI [8]=old ESI [12]=ret [16]=this [20]=start
                // [24]=pData [28]=vec4Count.
                w8(0x56); // push esi
                w8(0x57); // push edi
                w8(0x50); // push eax
                w8(0x8B); w8(0x15); w32(ctrlAddr); // mov edx,[ctrlAddr]
                w8(0x8B); w8(0x4C); w8(0x24); w8(28); // mov ecx,[esp+28]
                w8(0x85); w8(0xC9); // test ecx,ecx
                w8(0x0F); w8(0x84); const leanJzOverflowOff = off; w32(0);
                w8(0x81); w8(0xF9); w32(maxVec4); // cmp ecx,maxVec4
                w8(0x0F); w8(0x87); const leanJaOverflowOff = off; w32(0);
                w8(0x89); w8(0xC8); // mov eax,ecx
                w8(0xC1); w8(0xE0); w8(4); // shl eax,4
                w8(0x83); w8(0xC0); w8(16); // add eax,16
                w8(0x01); w8(0xD0); // add eax,edx
                w8(0x3D); w32(capacity); // cmp eax,capacity
                w8(0x0F); w8(0x87); const leanJaCapOverflowOff = off; w32(0);

                w8(0xBF); w32(dataBase); // mov edi,dataBase
                w8(0x01); w8(0xD7); // add edi,edx
                w8(0x8B); w8(0x04); w8(0x24); // mov eax,[esp]
                w8(0x89); w8(0x07); // mov [edi],eax
                w8(0x8B); w8(0x44); w8(0x24); w8(16); // this
                w8(0x89); w8(0x47); w8(4);
                w8(0x8B); w8(0x44); w8(0x24); w8(20); // startReg
                w8(0x89); w8(0x47); w8(8);
                w8(0x8B); w8(0x4C); w8(0x24); w8(28); // vec4Count
                w8(0x89); w8(0x4F); w8(12);
                w8(0x8B); w8(0x74); w8(0x24); w8(24); // esi=pData
                w8(0x83); w8(0xC7); w8(16); // edi=float destination
                w8(0xC1); w8(0xE1); w8(2); // ecx=dword count

                const leanCopyLoopAddr = off;
                w8(0x85); w8(0xC9);
                w8(0x74); const leanJzCopyDoneOff = off; w8(0);
                w8(0x8B); w8(0x06);
                w8(0x89); w8(0x07);
                w8(0x83); w8(0xC6); w8(4);
                w8(0x83); w8(0xC7); w8(4);
                w8(0x49);
                w8(0xEB); const leanJmpCopyOff = off; w8(0);
                mem[leanJmpCopyOff] = leanCopyLoopAddr - (leanJmpCopyOff + 1);
                const leanCopyDoneAddr = off;
                mem[leanJzCopyDoneOff] = leanCopyDoneAddr - (leanJzCopyDoneOff + 1);

                w8(0x8B); w8(0x44); w8(0x24); w8(28);
                w8(0xC1); w8(0xE0); w8(4);
                w8(0x83); w8(0xC0); w8(16);
                w8(0x01); w8(0x05); w32(ctrlAddr);
                w8(0x83); w8(0xC4); w8(4); // discard saved funcId
                w8(0x5F); // pop edi
                w8(0x5E); // pop esi
                w8(0xBA); w32(0xB077);
                w8(0x31); w8(0xC0);
                w8(0xC2); w8(16); w8(0);

                const leanOverflowAddr = off;
                dv.setInt32(leanJzOverflowOff, leanOverflowAddr - (leanJzOverflowOff + 4), true);
                dv.setInt32(leanJaOverflowOff, leanOverflowAddr - (leanJaOverflowOff + 4), true);
                dv.setInt32(leanJaCapOverflowOff, leanOverflowAddr - (leanJaCapOverflowOff + 4), true);
                w8(0x58); // pop eax: restore funcId for OUT fallback
                w8(0x5F);
                w8(0x5E);
                w8(0xBA); w32(0xB077);
                w8(0xEF);
                w8(0xC2); w8(16); w8(0);
            } else {

            w8(0x9C); // pushfd
            w8(0x52); // push edx
            w8(0x53); // push ebx
            w8(0x51); // push ecx
            w8(0x56); // push esi
            w8(0x57); // push edi
            // [esp+24]=ret [+28]=this [+32]=start [+36]=pData [+40]=vec4Count

            w8(0x89); w8(0xC7); // mov edi, eax  (save funcId)
            w8(0x8B); w8(0x15); w32(ctrlAddr); // mov edx, [ctrlAddr]  head
            w8(0x8B); w8(0x4C); w8(0x24); w8(40); // mov ecx, [esp+40]  vec4Count
            w8(0x85); w8(0xC9); // test ecx, ecx
            w8(0x0F); w8(0x84); // jz .overflow
            const jzOverflowOff = off; w32(0);
            w8(0x81); w8(0xF9); w32(maxVec4); // cmp ecx, maxVec4
            w8(0x0F); w8(0x87); // ja .overflow
            const jaOverflowOff = off; w32(0);

            w8(0x89); w8(0xC8); // mov eax, ecx
            w8(0xC1); w8(0xE0); w8(4); // shl eax, 4  (vec4Count * 16)
            w8(0x83); w8(0xC0); w8(16); // add eax, 16
            w8(0x01); w8(0xD0); // add eax, edx  head + entryBytes
            w8(0x3D); w32(capacity); // cmp eax, capacity
            w8(0x0F); w8(0x87); // ja .overflow
            const jaCapOverflowOff = off; w32(0);

            w8(0xBB); w32(dataBase); // mov ebx, dataBase
            w8(0x03); w8(0xDA); // add ebx, edx  ring write ptr
            w8(0x89); w8(0x3B); // mov [ebx], edi  funcId
            w8(0x8B); w8(0x44); w8(0x24); w8(28); // mov eax, [esp+28]  thisPtr
            w8(0x89); w8(0x43); w8(4); // mov [ebx+4], eax
            w8(0x8B); w8(0x44); w8(0x24); w8(32); // mov eax, [esp+32]  startReg
            w8(0x89); w8(0x43); w8(8); // mov [ebx+8], eax
            w8(0x89); w8(0x4B); w8(12); // mov [ebx+12], ecx  vec4Count
            w8(0x8B); w8(0x74); w8(0x24); w8(36); // mov esi, [esp+36]  pData
            w8(0x8D); w8(0x7B); w8(16); // lea edi, [ebx+16]  ring float dest
            w8(0x8B); w8(0x4C); w8(0x24); w8(40); // mov ecx, [esp+40]
            w8(0xC1); w8(0xE1); w8(2); // shl ecx, 2  dword count

            const copyLoopAddr = off;
            w8(0x85); w8(0xC9); // test ecx, ecx
            w8(0x74); // jz copy_done
            const jzCopyDoneOff = off; w8(0);
            w8(0x8B); w8(0x06); // mov eax, [esi]
            w8(0x89); w8(0x07); // mov [edi], eax
            w8(0x83); w8(0xC6); w8(4); // add esi, 4
            w8(0x83); w8(0xC7); w8(4); // add edi, 4
            w8(0x49); // dec ecx
            w8(0xEB); // jmp copy_loop
            const jmpCopyOff = off; w8(0);
            mem[jmpCopyOff] = copyLoopAddr - (jmpCopyOff + 1);

            const copyDoneAddr = off;
            mem[jzCopyDoneOff] = copyDoneAddr - (jzCopyDoneOff + 1); // patch jz rel8

            w8(0x8B); w8(0x4B); w8(12); // mov ecx, [ebx+12]  vec4Count
            w8(0x89); w8(0xC8); // mov eax, ecx
            w8(0xC1); w8(0xE0); w8(4); // shl eax, 4
            w8(0x83); w8(0xC0); w8(16); // add eax, 16
            w8(0x01); w8(0x05); w32(ctrlAddr); // add [ctrlAddr], eax

            w8(0x5F); // pop edi
            w8(0x5E); // pop esi
            w8(0x59); // pop ecx
            w8(0x5B); // pop ebx
            w8(0x5A); // pop edx
            w8(0xBA); w32(0xB077); // mov edx, 0xB077
            w8(0x31); w8(0xC0); // xor eax, eax
            w8(0x9D); // popfd
            w8(0xC2); w8(16); w8(0); // ret 16

            const overflowAddr = off;
            dv.setInt32(jzOverflowOff, overflowAddr - (jzOverflowOff + 4), true);
            dv.setInt32(jaOverflowOff, overflowAddr - (jaOverflowOff + 4), true);
            dv.setInt32(jaCapOverflowOff, overflowAddr - (jaCapOverflowOff + 4), true);

            w8(0x89); w8(0xF8); // mov eax, edi  restore funcId for OUT fallback
            w8(0x5F); // pop edi
            w8(0x5E); // pop esi
            w8(0x59); // pop ecx
            w8(0x5B); // pop ebx
            w8(0x5A); // pop edx
            w8(0x9D); // popfd
            w8(0xBA); w32(0xB077); // mov edx, 0xB077
            w8(0xEF); // out dx, eax
            w8(0xC2); w8(16); w8(0); // ret 16
            }
        }

        Logger.log(LogCategory.SYSTEM,
            `Write-buffer trampolines: 0x${base.toString(16)}..0x${off.toString(16)} ` +
            `(${off - base} bytes, ctrl=0x${ctrlAddr.toString(16)}, data=0x${dataBase.toString(16)}, cap=${capacity >> 10}KB)`);
        return addrs;
    }

    /**
     * Narrow allocator surface for the external stub/trampoline emitters
     * (kernel32/heap-slab-stubs, crt-slab-stubs, d3d9/capture-trampolines). Throws until
     * initialize() has run — preserving the guard the emitters had as methods here.
     */
    get stubAllocator(): StubAllocator {
        if (!this.memoryManager) {
            throw new Error('ThunkMemoryManager not initialized');
        }
        return this.memoryManager;
    }

    /**
     * Allocate a shared u32 in guest RAM (THUNK_DATA, rw) holding the "active owner" pointer for
     * shadow trampolines (e.g. the bound COM device `this`). One per shadow group; the caller
     * (dispatcher) seeds it via the device-bind hook. Returns the guest address.
     */
    allocShadowOwnerGlobal(): number {
        if (!this.memoryManager) throw new Error('ThunkMemoryManager not initialized');
        const addr = this.memoryManager.alloc(4, 'THUNK_DATA', 'rw');
        return addr;
    }

    /**
     * Allocate additional memory for thunk generator (grow-on-demand)
     *
     * @param size - Additional size needed (bytes)
     * @returns New base address or existing if already allocated
     */
    allocateThunkGeneratorSpace(size: number): number {
        if (!this.memoryManager) {
            throw new Error('ThunkMemoryManager not initialized');
        }
        
        // For now, just allocate from MemoryManager
        // Future: could implement a custom allocator within thunkGeneratorBase region
        return this.memoryManager.alloc(size, "THUNK_CODE", "rx");
    }
}

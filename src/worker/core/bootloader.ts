// bootloader.ts

import { DllInitEntry } from './pe-loader';

/**
 * Marker ids for the deliberately-raised trap vectors. The low 16 bits of a 0xDEADxxxx id
 * are what the dispatcher switches on, and there 0x0003/0x0004 are already the bootloader's
 * own progress markers — so these carry a 0x01xx prefix rather than the bare vector number.
 */
export const TRAP_MARKER = {
    bp: 0xdead0103,   // vector 3, INT 3
    of: 0xdead0104,   // vector 4, INTO
} as const;

/** Vector each trap marker came from, for the dispatcher's NT-status mapping. */
export const TRAP_MARKER_VECTOR: Record<number, number> = {
    [TRAP_MARKER.bp & 0xffff]: 3,
    [TRAP_MARKER.of & 0xffff]: 4,
};

// Creates a 16-bit real mode bootloader that switches to 32-bit protected mode
// and jumps to the PE entry point.
// dllInits: DLLs whose DllMain(DLL_PROCESS_ATTACH) must be called before entry.
export function createBootloader(
    peEntryPoint: number,
    stackPointer: number,
    dllInits: DllInitEntry[] = []
): { code: Uint8Array; loadAddress: number; startAddress: number } {
    const loadAddress = 0x7c00;
    const gdtAddress = GDT_ADDRESS;
    // IDT immediately after GDT (32 bytes for 4 entries)
    const idtAddress = gdtAddress + 32; // 0x7E20
    const idtSize = 256 * 8; // 2048 bytes
    // Handlers after IDT
    const handlersAddress = idtAddress + idtSize; // 0x8618

    const code: number[] = [];

    // --- 1. 16-bit Real Mode Section ---

    // CLI - disable interrupts
    code.push(0xfa);

    // XOR AX, AX; MOV DS, AX; MOV ES, AX (Init segments)
    code.push(0x31, 0xc0, 0x8e, 0xd8, 0x8e, 0xc0);

    // LGDT [gdtPtr] (16-bit mode)
    code.push(0x0f, 0x01, 0x16);
    const lgdtOffsetPos = code.length;
    code.push(0x00, 0x00);

    // Enable A20 (fast A20 gate, port 0x92)
    code.push(0xe4, 0x92); // in al, 0x92
    code.push(0x0c, 0x02); // or al, 0x02
    code.push(0xe6, 0x92); // out 0x92, al

    // Enable PE: MOV EAX, CR0; OR AL, 1; MOV CR0, EAX
    code.push(0x0f, 0x20, 0xc0, 0x0c, 0x01, 0x0f, 0x22, 0xc0);

    // Far JMP to 32-bit code (Selector 0x08)
    code.push(0x66, 0xea);
    const jmp32OffsetPos = code.length;
    code.push(0x00, 0x00, 0x00, 0x00); // offset
    code.push(0x08, 0x00); // selector

    // --- 2. 32-bit Protected Mode Section ---
    const code32Start = code.length;

    // (A) Setup Segments FIRST
    // DS, ES, GS, SS = 0x10 (flat data); FS = 0x18 (TEB segment, base updated per-thread)
    code.push(0xb8, 0x10, 0x00, 0x00, 0x00); // MOV EAX, 0x10
    code.push(0x8e, 0xd8); // MOV DS, AX
    code.push(0x8e, 0xc0); // MOV ES, AX
    code.push(0x8e, 0xe8); // MOV GS, AX
    code.push(0x8e, 0xd0); // MOV SS, AX
    code.push(0xb8, 0x18, 0x00, 0x00, 0x00); // MOV EAX, 0x18
    code.push(0x8e, 0xe0); // MOV FS, AX

    // (B) Setup Stack BEFORE IDT
    code.push(0xbc);
    code.push(
        stackPointer & 0xff,
        (stackPointer >> 8) & 0xff,
        (stackPointer >> 16) & 0xff,
        (stackPointer >> 24) & 0xff
    );

    // (C) LIDT [idtr] in 32-bit mode
    code.push(0x0f, 0x01, 0x1d);
    const lidtDispPos = code.length;
    code.push(0x00, 0x00, 0x00, 0x00);

    // (D) DEBUG: OUT 0xB077, 0xDEAD0003 "PM + IDT OK"
    code.push(0xb8, 0x03, 0x00, 0xad, 0xde);
    code.push(0xba, 0x77, 0xb0, 0x00, 0x00);
    code.push(0xef);

    // (E) Initialize FPU (Simplified)
    // We skip explicit SSE CR4 setup to avoid #GP in v86.
    // We just ensure EM is clear, and MP/NE are set in CR0.
    code.push(0xfc); // CLD

    // MOV EAX, CR0
    code.push(0x0f, 0x20, 0xc0);
    // AND EAX, 0xFFFFFFFB (Clear EM - Bit 2)
    code.push(0x25, 0xfb, 0xff, 0xff, 0xff);
    // OR EAX, 0x22 (Set MP - Bit 1, Set NE - Bit 5)
    // NE is crucial for 32-bit FPU exception handling.
    code.push(0x83, 0xc8, 0x22);
    // MOV CR0, EAX
    code.push(0x0f, 0x22, 0xc0);

    // FNINIT - Initialize FPU
    code.push(0xdb, 0xe3);

    // (F) DllMain Init Trampoline
    // Call DllMain(hModule, DLL_PROCESS_ATTACH=1, lpReserved=0) for each real DLL.
    // DllMain is stdcall — callee cleans 12 bytes (3 params × 4).
    // When DllMain code calls kernel32/etc through IAT, it hits thunk stubs → JS handlers → returns normally.
    for (const dll of dllInits) {
        // PUSH 1 (lpReserved = non-NULL → static/implicit load)
        // Windows passes non-NULL for DLLs loaded via import table (before process start).
        // NULL is only for runtime LoadLibrary() calls.
        code.push(0x68, 0x01, 0x00, 0x00, 0x00);
        // PUSH 1 (fdwReason = DLL_PROCESS_ATTACH)
        code.push(0x68, 0x01, 0x00, 0x00, 0x00);
        // PUSH hModule (baseAddress)
        code.push(0x68,
            dll.baseAddress & 0xff,
            (dll.baseAddress >> 8) & 0xff,
            (dll.baseAddress >> 16) & 0xff,
            (dll.baseAddress >> 24) & 0xff
        );
        // MOV EAX, entryPoint
        code.push(0xb8,
            dll.entryPoint & 0xff,
            (dll.entryPoint >> 8) & 0xff,
            (dll.entryPoint >> 16) & 0xff,
            (dll.entryPoint >> 24) & 0xff
        );
        // CALL EAX
        code.push(0xff, 0xd0);

        // (F1) DEBUG: OUT 0xB077, 0xDEAD000A "DllMain result"
        code.push(0x89, 0xc1);                   // MOV ECX, EAX (Save result in ECX)
        code.push(0xb8, 0x0a, 0x00, 0xad, 0xde); // MOV EAX, 0xDEAD000A
        code.push(0xba, 0x77, 0xb0, 0x00, 0x00); // MOV EDX, 0xB077
        code.push(0xef);                         // OUT DX, EAX
    }

    // (G) Jump to EXE Entry Point
    code.push(0xb8);
    code.push(
        peEntryPoint & 0xff,
        (peEntryPoint >> 8) & 0xff,
        (peEntryPoint >> 16) & 0xff,
        (peEntryPoint >> 24) & 0xff
    );
    code.push(0xff, 0xe0); // JMP EAX

    // --- Data Structures ---
    const dataOffset = code.length;

    // GDT Pointer (6 bytes)
    const gdtLimit = 32 - 1; // 4 entries * 8 bytes
    code.push(gdtLimit & 0xff, (gdtLimit >> 8) & 0xff);
    code.push(
        gdtAddress & 0xff,
        (gdtAddress >> 8) & 0xff,
        (gdtAddress >> 16) & 0xff,
        (gdtAddress >> 24) & 0xff
    );

    // IDT Pointer (6 bytes)
    const idtrOffset = code.length;
    const idtLimit = idtSize - 1;
    code.push(idtLimit & 0xff, (idtLimit >> 8) & 0xff);
    code.push(
        idtAddress & 0xff,
        (idtAddress >> 8) & 0xff,
        (idtAddress >> 16) & 0xff,
        (idtAddress >> 24) & 0xff
    );

    // --- Patching Offsets ---

    // Patch LGDT (16-bit offset)
    const gdtrLinear = loadAddress + dataOffset;
    code[lgdtOffsetPos] = gdtrLinear & 0xff;
    code[lgdtOffsetPos + 1] = (gdtrLinear >> 8) & 0xff;

    // Patch LIDT (32-bit disp)
    const idtrLinear = loadAddress + idtrOffset;
    code[lidtDispPos] = idtrLinear & 0xff;
    code[lidtDispPos + 1] = (idtrLinear >> 8) & 0xff;
    code[lidtDispPos + 2] = (idtrLinear >> 16) & 0xff;
    code[lidtDispPos + 3] = (idtrLinear >> 24) & 0xff;

    // Patch Far JMP target
    const jmpTarget = loadAddress + code32Start;
    code[jmp32OffsetPos] = jmpTarget & 0xff;
    code[jmp32OffsetPos + 1] = (jmpTarget >> 8) & 0xff;
    code[jmp32OffsetPos + 2] = (jmpTarget >> 16) & 0xff;
    code[jmp32OffsetPos + 3] = (jmpTarget >> 24) & 0xff;

    // --- Final Assembly ---

    // Calculate handler positions
    const handlerSize = 25;
    const hGenericOff = handlersAddress - loadAddress;
    const hUdOff = hGenericOff + handlerSize;
    const hGpOff = hUdOff + handlerSize;
    const hPfOff = hGpOff + handlerSize;
    const hInt2eOff = hPfOff + handlerSize;
    const hInt80Off = hInt2eOff + handlerSize;
    const hDeOff = hInt80Off + handlerSize; // #DE (Division Error) - recoverable
    // Trap vectors a guest raises DELIBERATELY: INT 3 is how anti-debug code probes for a
    // debugger, INTO how compiled overflow checks report. Both must reach the guest's SEH
    // as EXCEPTION_BREAKPOINT / EXCEPTION_INT_OVERFLOW; the generic halt handler would
    // stop the machine on code that runs fine on Windows. Appended AFTER the existing
    // handlers so PF_HALT_TARGET's slot arithmetic below stays valid.
    const hBpOff = hDeOff + handlerSize;    // #BP (INT 3) - recoverable
    const hOfOff = hBpOff + handlerSize;    // #OF (INTO)  - recoverable

    const totalSize = 512 + 32 + idtSize + 1024;
    const finalBuffer = new Uint8Array(totalSize);

    // Copy bootloader code
    finalBuffer.set(code, 0);

    // Boot Signature
    finalBuffer[510] = 0x55;
    finalBuffer[511] = 0xaa;

    // Write GDT at offset 512
    const gdtData = createGDTBytes();
    finalBuffer.set(gdtData, 512);

    // Write handlers
    finalBuffer.set(
        createHaltHandlerBytes(0xdead00ee, true),
        hGenericOff
    );
    finalBuffer.set(createRecoverableFaultHandler(0xdead0006, true), hUdOff); // #UD - recoverable via IRET
    finalBuffer.set(createRecoverableFaultHandler(0xdead000d, false), hGpOff); // #GP - recoverable via IRET
    finalBuffer.set(createRecoverablePfHandler(), hPfOff); // #PF - recoverable via IRET
    finalBuffer.set(
        createHaltHandlerBytes(0xdead02ee, false),
        hInt2eOff
    );
    finalBuffer.set(
        createHaltHandlerBytes(0xdead0080, false),
        hInt80Off
    );
    finalBuffer.set(
        createRecoverableHandlerBytes(0xdead0000),
        hDeOff
    ); // #DE - recoverable via IRET
    // A trap pushes no error code, so both share the #UD frame shape (dummy pushed).
    finalBuffer.set(createRecoverableFaultHandler(TRAP_MARKER.bp, true), hBpOff);
    finalBuffer.set(createRecoverableFaultHandler(TRAP_MARKER.of, true), hOfOff);

    // Create and write IDT
    const idtBytes = createIDTBytes({
        generic: loadAddress + hGenericOff,
        ud: loadAddress + hUdOff,
        gp: loadAddress + hGpOff,
        pf: loadAddress + hPfOff,
        int2e: loadAddress + hInt2eOff,
        int80: loadAddress + hInt80Off,
        de: loadAddress + hDeOff,
        bp: loadAddress + hBpOff,
        of: loadAddress + hOfOff,
    });
    finalBuffer.set(idtBytes, 512 + 32);

    return {
        code: finalBuffer,
        loadAddress,
        startAddress: loadAddress,
    };
}

function createHaltHandlerBytes(
    thunkId: number,
    dumpEip: boolean = false
): Uint8Array {
    // Basic handler:
    // MOV EAX, thunkId
    // MOV EDX, 0xB077
    // OUT DX, EAX
    // ...
    const bytes: number[] = [
        0xb8,
        thunkId & 0xff,
        (thunkId >> 8) & 0xff,
        (thunkId >> 16) & 0xff,
        (thunkId >> 24) & 0xff,
        0xba,
        0x77,
        0xb0,
        0x00,
        0x00,
        0xef,
    ];

    if (dumpEip) {
        // For exceptions, stack: [ErrCode, EIP, CS, EFLAGS] or [EIP, CS, EFLAGS]
        // #GP (13) and #PF (14) push Error Code. #UD (6) does NOT.
        const hasErrorCode =
            thunkId === 0xdead000d || thunkId === 0xdead000e;
        const offset = hasErrorCode ? 4 : 0;

        if (offset === 0) {
            bytes.push(0x8b, 0x04, 0x24); // mov eax, [esp]
        } else {
            bytes.push(0x8b, 0x44, 0x24, offset); // mov eax, [esp+offset]
        }
        bytes.push(0xef); // out dx, eax
    }

    // CLI; HLT; JMP $-1
    bytes.push(0xfa, 0xf4, 0xeb, 0xfe);
    return new Uint8Array(bytes);
}

/**
 * Creates a recoverable exception handler that uses IRET instead of HLT.
 * The thunk dispatcher can modify the interrupt frame on the stack to skip
 * the faulting instruction before IRET resumes execution.
 *
 * Handler: MOV EAX, thunkId; MOV EDX, 0xB077; OUT DX, EAX; IRET (12 bytes)
 */
function createRecoverableHandlerBytes(thunkId: number): Uint8Array {
    return new Uint8Array([
        0xb8,                           // MOV EAX, imm32
        thunkId & 0xff,
        (thunkId >> 8) & 0xff,
        (thunkId >> 16) & 0xff,
        (thunkId >> 24) & 0xff,
        0xba, 0x77, 0xb0, 0x00, 0x00,  // MOV EDX, 0xB077
        0xef,                           // OUT DX, EAX
        0xcf,                           // IRET
    ]);
}

/**
 * Creates a recoverable #UD/#GP handler: save EAX/EDX, OUT to JS, restore,
 * pop the error code, IRET. Same frame shape as the #PF handler during the OUT:
 *   [ESP+0]=saved_EDX, [ESP+4]=saved_EAX, [ESP+8]=ErrCode, [ESP+12]=EIP
 * #UD pushes no error code, so its handler pushes a dummy 0 first
 * (pushDummyErrorCode) to keep the frame uniform for the JS side.
 * The JS handler decides the outcome by rewriting [ESP+12] (the IRET target):
 * SEH handler address, spin loop (thread terminated), or PF_HALT_TARGET (fatal).
 * Sizes: 21 bytes (#UD) / 19 bytes (#GP) — both fit the 25-byte handler slot.
 */
function createRecoverableFaultHandler(
    thunkId: number,
    pushDummyErrorCode: boolean
): Uint8Array {
    const bytes: number[] = [];
    if (pushDummyErrorCode) bytes.push(0x6a, 0x00); // PUSH 0 (fake error code)
    bytes.push(
        0x50,                           // PUSH EAX     (save — clobbered by MOV below)
        0x52,                           // PUSH EDX     (save — clobbered by MOV below)
        0xb8,                           // MOV EAX, thunkId
        thunkId & 0xff,
        (thunkId >> 8) & 0xff,
        (thunkId >> 16) & 0xff,
        (thunkId >> 24) & 0xff,
        0xba, 0x77, 0xb0, 0x00, 0x00,  // MOV EDX, 0xB077
        0xef,                           // OUT DX, EAX  (JS handler runs synchronously)
        0x5a,                           // POP EDX      (restore)
        0x58,                           // POP EAX      (restore)
        0x83, 0xc4, 0x04,              // ADD ESP, 4   (pop error code — IRET won't pop it)
        0xcf,                           // IRET
    );
    return new Uint8Array(bytes);
}

/**
 * Creates a recoverable #PF handler that signals JS via OUT, then uses IRET to retry.
 *
 * Must save/restore EAX and EDX — the MOV+OUT clobber them, and IRET
 * retries the faulting instruction which may depend on their original values.
 *
 * Stack on entry (intra-privilege, ring 0→0):
 *   [ESP+0]=ErrorCode, [ESP+4]=EIP, [ESP+8]=CS, [ESP+12]=EFLAGS
 *
 * After PUSH EAX, PUSH EDX (during OUT handler):
 *   [ESP+0]=saved_EDX, [ESP+4]=saved_EAX, [ESP+8]=ErrorCode, [ESP+12]=EIP
 *
 * For unrecoverable faults, the JS handler redirects IRET by overwriting [ESP+12]
 * to point at the CLI;HLT;JMP$ dead code after the IRET (handler_base + 19).
 *
 * Total: 23 bytes (fits in 25-byte handler slot).
 */
function createRecoverablePfHandler(): Uint8Array {
    return new Uint8Array([
        0x50,                           // PUSH EAX     (save — clobbered by MOV below)
        0x52,                           // PUSH EDX     (save — clobbered by MOV below)
        0xb8, 0x0e, 0x00, 0xad, 0xde,  // MOV EAX, 0xDEAD000E
        0xba, 0x77, 0xb0, 0x00, 0x00,  // MOV EDX, 0xB077
        0xef,                           // OUT DX, EAX  (JS handler runs synchronously)
        0x5a,                           // POP EDX      (restore)
        0x58,                           // POP EAX      (restore)
        0x83, 0xc4, 0x04,              // ADD ESP, 4   (pop error code — IRET won't pop it)
        0xcf,                           // IRET         (retry faulting instruction)
        // Dead code: halt target for unrecoverable faults (JS overwrites IRET return EIP)
        0xfa,                           // CLI
        0xf4,                           // HLT
        0xeb, 0xfe,                     // JMP $-1
    ]);
}

/**
 * Absolute address of the halt sequence (CLI;HLT;JMP$-1) inside the #PF handler.
 * Used by thunk dispatcher to redirect IRET on unrecoverable page faults.
 *
 * Layout: handlersAddress(0x8620) + 3*handlerSize(75) + haltOffset(19) = 0x867E
 */
export const PF_HALT_TARGET = (0x7E00 + 32 + 256 * 8) + 3 * 25 + 19;

function setIDTEntry(
    view: DataView,
    index: number,
    handlerLinear: number
) {
    const off = index * 8;
    view.setUint16(off + 0, handlerLinear & 0xffff, true); // offset low
    view.setUint16(off + 2, 0x08, true); // selector = code segment
    view.setUint8(off + 4, 0); // zero
    view.setUint8(off + 5, 0x8e); // present, ring0, 32-bit int gate
    view.setUint16(
        off + 6,
        (handlerLinear >>> 16) & 0xffff,
        true
    ); // offset high
}

function createIDTBytes(addrs: {
    generic: number;
    ud: number;
    gp: number;
    pf: number;
    int2e: number;
    int80: number;
    de: number;
    bp: number;
    of: number;
}): Uint8Array {
    const idt = new Uint8Array(256 * 8);
    const view = new DataView(idt.buffer);

    for (let i = 0; i < 256; i++) {
        setIDTEntry(view, i, addrs.generic);
    }

    setIDTEntry(view, 0, addrs.de);     // #DE - Division Error (recoverable)
    setIDTEntry(view, 3, addrs.bp);     // #BP - INT 3 (recoverable)
    setIDTEntry(view, 4, addrs.of);     // #OF - INTO (recoverable)
    setIDTEntry(view, 6, addrs.ud);
    setIDTEntry(view, 13, addrs.gp);
    setIDTEntry(view, 14, addrs.pf);
    setIDTEntry(view, 0x2e, addrs.int2e);
    setIDTEntry(view, 0x80, addrs.int80);

    return idt;
}

function createGDTBytes(): Uint8Array {
    const gdt = new Uint8Array(32);
    const view = new DataView(gdt.buffer);

    // Entry 0: Null
    // Entry 1 (0x08): Code 32-bit, Base=0, Limit=4GB
    view.setUint32(8, 0x0000ffff, true);
    view.setUint32(12, 0x00cf9a00, true);

    // Entry 2 (0x10): Data 32-bit, Base=0, Limit=4GB
    view.setUint32(16, 0x0000ffff, true);
    view.setUint32(20, 0x00cf9200, true);

    // Entry 3 (0x18): FS segment - Data 32-bit, Limit=4GB. Base starts at 0 and is
    // reprogrammed per-thread by setFsBase() (scheduler/fs-base.ts), which patches THIS
    // descriptor as well as cpu.segment_offsets[4]. The descriptor is what the CPU
    // re-reads whenever guest code reloads the FS selector (`pop fs`, an ordinary Borland/
    // Delphi RTL epilogue idiom) — a base of 0 there silently sends every later fs:[…]
    // to linear 0. Limit stays 4GB rather than the one TEB page: narrowing it would be
    // closer to real Windows but would #GP code that uses large fs: offsets.
    view.setUint32(24, 0x0000ffff, true);
    view.setUint32(28, 0x00cf9200, true);

    return gdt;
}

/** Guest linear address of the GDT the bootloader lgdt's. */
export const GDT_ADDRESS = 0x7e00;
/** Entry 3 (selector 0x18) — the FS descriptor. Base fields live at +2/+3, +4 and +7. */
export const GDT_FS_DESCRIPTOR_ADDRESS = GDT_ADDRESS + 3 * 8; // 0x7e18

export function createGDT(): {
    gdt: Uint8Array;
    gdtAddress: number;
    gdtSize: number;
} {
    return { gdt: createGDTBytes(), gdtAddress: GDT_ADDRESS, gdtSize: 32 };
}

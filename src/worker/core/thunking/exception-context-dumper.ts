/**
 * Exception-context crash dumper. COLD PATH — runs only when the dispatcher
 * detects a fault/corruption and wants a forensic snapshot (CPU regs, faulting
 * EIP/ESP, stack walk, region classification, recent WinAPI ring). Pure
 * diagnostics; no effect on normal execution.
 *
 * `d` is the live ThunkDispatcher (loose `any` back-ref) — the dump reads its
 * live memory views / last-thunk bookkeeping / WinAPI ring through it.
 */
import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { findSehWindowHit } from '../seh-dispatch';
import { getStackGuardViolations, getStackGuardViolationCount } from '../memory/stack-write-guard';

// Fault-region bounds (mirror thunk-dispatcher.ts) — used only to label addresses in the dump.
const BOOTLOADER_START = 0x7c00;
const BOOTLOADER_END = 0x9000;
const STACK_REGION_START = 0x80000;
const STACK_REGION_END = 0x100000;

/**
 * Escape forensics for a bootloader/stack escape: where control CAME from cannot be
 * recovered post-halt (the #GP frame destroys the popped slot and previous_ip is already
 * the handler's), so instead we (a) name the RET-shape suspect slot, (b) cross-reference
 * the faulting EIP and the suspect slot against recent SEH dispatch windows, and
 * (c) surface parked-stack write-guard violations — the plant-time tripwire. Any MATCH
 * line here names the culprit directly.
 */
function buildEscapeAnalysis(marker: number, esp: number, faultingEip: number): string[] {
    const lines: string[] = [];
    try {
        // #GP/#PF push an error code; the fault frame is [err, EIP, CS, EFLAGS].
        const hasErrorCode = marker === 0x0d || marker === 0x0e;
        const preFaultEsp = (esp + (hasErrorCode ? 16 : 12)) >>> 0;
        const suspectSlot = (preFaultEsp - 4) >>> 0;
        lines.push(
            `pre-fault ESP=0x${preFaultEsp.toString(16)}; if the escape was a RET, the popped ` +
            `slot was [0x${suspectSlot.toString(16)}] (contents now destroyed by the fault frame)`);

        const eipHit = findSehWindowHit(faultingEip);
        if (eipHit) lines.push(`MATCH faulting EIP: ${eipHit}`);
        const slotHit = findSehWindowHit(suspectSlot);
        if (slotHit) lines.push(`MATCH suspect slot: ${slotHit}`);
        if (!eipHit && !slotHit) lines.push(`no recent SEH dispatch window covers the faulting EIP or the suspect slot`);

        const guardCount = getStackGuardViolationCount();
        if (guardCount > 0) {
            lines.push(`parked-stack write violations recorded: ${guardCount} — see the violations section (a write to ` +
                `0x${suspectSlot.toString(16)} there is the culprit)`);
            for (const v of getStackGuardViolations()) {
                if (v.includes(`0x${suspectSlot.toString(16)}+`)) lines.push(`MATCH suspect slot writer: ${v}`);
            }
        } else {
            lines.push(`no parked-stack write violations recorded (instrumented machinery write-sites are clean ` +
                `for this run — suspect a non-instrumented writer or a guest-side wild write)`);
        }
    } catch { /* forensics must never throw */ }
    return lines;
}

/** Route fatal execution escapes through the single crash funnel (host copyable report). */
function reportFatalExecutionEscape(
    d: any,
    regs: number[],
    esp: number,
    eip: number,
    reason: string,
    escapeAnalysis?: string[],
): void {
    const regsObj = {
        ecx: regs[1] >>> 0, ebx: regs[3] >>> 0, esp: esp >>> 0,
        ebp: regs[5] >>> 0, esi: regs[6] >>> 0, edi: regs[7] >>> 0,
    };
    const stackDump: number[] = [];
    if (d.cachedMem8 && d.isDataViewValid?.() && esp >= 0 && esp + 128 <= d.cachedMem8.length) {
        const dv = d.cachedDataView!;
        for (let i = 0; i < 32; i++) stackDump.push(dv.getUint32(esp + i * 4, true) >>> 0);
    }
    let recentCalls: string[] = [];
    try { recentCalls = d.getLastWinApiCalls?.(24) ?? []; } catch { /* */ }
    let threadId: number | null = null;
    try {
        threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? d.currentThreadId ?? null;
    } catch { /* */ }

    System.getInstance().reportGuestCrash({
        reason,
        eip: eip >>> 0,
        threadId: typeof threadId === "number" ? threadId : null,
        fault: {
            lastThunk: d.lastThunkName || d.lastThunkNameAfterReturn || "",
            regs: regsObj,
            recentCalls,
            gameEsp: esp >>> 0,
            stackDump,
            escapeAnalysis,
        },
    });
}

/**
 * `espOverride`: recoverable #GP/#UD handlers PUSH EAX/EDX (and #UD a dummy error
 * code) before the OUT, so the live ESP no longer points at the fault frame the
 * offsets below assume. The caller passes the adjusted ESP (error-code slot for
 * error-code vectors, EIP slot otherwise); halt handlers omit it.
 */
export function dumpExceptionContext(d: any, marker: number, cpu: any, espOverride?: number): void {
        if (!cpu) return;

        const regs = cpu.reg32;
        const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
        const eflags = (cpu.flags?.[0] ?? 0) >>> 0;
        const esp = (espOverride ?? regs[4]) >>> 0;
        // Read faulting EIP early so we can avoid false "stack corruption" when fault is in guest code
        // Exceptions with error code (EIP at [ESP+4]): #DF(8), #TS(0xA), #NP(0xB), #SS(0xC), #GP(0xD), #PF(0xE), #AC(0x11)
        // All others including software INTs: no error code > faulting EIP at [ESP+0]
        const exceptionsWithErrorCode = new Set([0x08, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x11]);
        let faultingEipEarly: number | null = null;
        if (d.cachedMem8 && esp > 0 && esp + 8 <= d.cachedMem8.length && d.isDataViewValid()) {
            const eipOffset = exceptionsWithErrorCode.has(marker) ? 4 : 0;
            faultingEipEarly = d.cachedDataView!.getUint32(esp + eipOffset, true) >>> 0;
        }
        const markers: Record<number, string> = {
            0x0006: "#UD (Invalid Opcode)",
            0x000d: "#GP (General Protection)",
            0x000e: "#PF (Page Fault)",
        };
        const msg = markers[marker] || `Exception 0x${marker.toString(16)}`;
        Logger.error(LogCategory.SYSTEM, `?? EXCEPTION: ${msg} detected!`);
        if (faultingEipEarly != null) {
            let modInfo: string | null = null;
            try { modInfo = System.getInstance().process?.moduleRegistry.resolveAddress(faultingEipEarly) ?? null; } catch { /* */ }
            Logger.error(LogCategory.SYSTEM, `   Faulting EIP=0x${faultingEipEarly.toString(16)}${modInfo ? ` (${modInfo})` : ''} (handler EIP=0x${eip.toString(16)}) ESP=0x${esp.toString(16)} EFLAGS=0x${eflags.toString(16)}`);
        } else {
            Logger.error(LogCategory.SYSTEM, `   CPU State: EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)} EFLAGS=0x${eflags.toString(16)}`);
        }
        d.logCallbackForensics(`exception_0x${marker.toString(16)}`);

        // DETECT: Execution in STACK range (usually stack corruption / jumping to buffer)
        const isEipInStack = eip >= STACK_REGION_START && eip < STACK_REGION_END;
        const isFaultEipInStack = faultingEipEarly != null && faultingEipEarly >= STACK_REGION_START && faultingEipEarly < STACK_REGION_END;

        if (isEipInStack || isFaultEipInStack) {
            const stackEip = isEipInStack ? eip : faultingEipEarly!;
            Logger.error(LogCategory.SYSTEM, `?? FATAL: Execution in STACK range detected! EIP=0x${stackEip.toString(16)}`);
            Logger.error(LogCategory.SYSTEM, `   This is likely a buffer overflow or stack corruption resulting in a jump to data.`);
            Logger.error(LogCategory.SYSTEM, `   Last thunk: ${d.lastThunkName || 'unknown'}`);

            // Reconstruct call stack for forensic analysis
            if (d.cachedMem8 && d.isDataViewValid() && esp > 0 && esp < d.cachedMem8.length - 64) {
                const callStack = d.reconstructCallStack(esp, d.cachedMem8, d.cachedDataView!);
                if (callStack.length > 0) {
                    Logger.error(LogCategory.SYSTEM, `   Forensic Call Stack (${callStack.length} frames):`);
                    for (let i = 0; i < Math.min(callStack.length, 12); i++) {
                        const frame = callStack[i];
                        Logger.error(LogCategory.SYSTEM,
                            `     ${i}. [ESP+${frame.stackOffset}] > 0x${frame.retAddr.toString(16)} ` +
                            `${frame.moduleName ? `(${frame.moduleName}+0x${frame.moduleOffset.toString(16)})` : '(unknown)'} ${frame.isThunk ? '?? thunk' : ''}`);
                    }
                }
            }

            // Fail-fast: route through crash funnel so the host shows a copyable report.
            const stackEscapeAnalysis = buildEscapeAnalysis(marker, esp, stackEip);
            for (const l of stackEscapeAnalysis) Logger.error(LogCategory.SYSTEM, `   [ESCAPE] ${l}`);
            reportFatalExecutionEscape(
                d, regs, esp, stackEip,
                `Execution escaped to stack at 0x${stackEip.toString(16)} (buffer overflow or stack corruption)`,
                stackEscapeAnalysis,
            );
            return;
        }

        if (marker === 0x0d || marker === 0x0e) {
            Logger.error(LogCategory.SYSTEM, `   Faulting Address/EIP from stack: 0x${faultingEipEarly != null ? faultingEipEarly.toString(16) : '?'}`);

            // Dump code bytes at faulting EIP to see what instruction caused the fault
            if (faultingEipEarly != null && d.cachedMem8 && faultingEipEarly > 0 && faultingEipEarly + 64 <= d.cachedMem8.length) {
                const mem = d.cachedMem8;
                const codeBytes: string[] = [];
                // Dump 32 bytes BEFORE and 32 bytes AFTER faulting EIP for context
                const startAddr = Math.max(0, faultingEipEarly - 32);
                for (let i = 0; i < 64; i++) {
                    if (startAddr + i === faultingEipEarly) codeBytes.push('>>');
                    codeBytes.push(mem[startAddr + i].toString(16).padStart(2, '0'));
                }
                Logger.error(LogCategory.SYSTEM, `   Code at faulting EIP (0x${startAddr.toString(16)}..+64, >> marks EIP): ${codeBytes.join(' ')}`);
            }
        }

        // FAIL-FAST: Execution in bootloader region is ALWAYS a critical bug (stack corruption or thunk return bug)
        // DO NOT attempt recovery - this masks real bugs and creates unpredictable behavior
        if (faultingEipEarly != null && faultingEipEarly >= BOOTLOADER_START && faultingEipEarly < BOOTLOADER_END) {
            Logger.error(LogCategory.SYSTEM, `?? FATAL: Execution escaped to bootloader region!`);
            Logger.error(LogCategory.SYSTEM,
                `   Faulting EIP: 0x${faultingEipEarly.toString(16)} (bootloader offset +0x${(faultingEipEarly - BOOTLOADER_START).toString(16)})`);
            Logger.error(LogCategory.SYSTEM, `   This indicates stack corruption or thunk return bug.`);
            Logger.error(LogCategory.SYSTEM, `   Last thunk: ${d.lastThunkName || 'unknown'}`);
            Logger.error(LogCategory.SYSTEM, `   Last caller module base: 0x${(d.lastCallerModuleBase || 0).toString(16)}`);

            // Dump registers for debugging
            const regDump = [
                `EAX=0x${(regs[0] >>> 0).toString(16)}`,
                `EBX=0x${(regs[3] >>> 0).toString(16)}`,
                `ECX=0x${(regs[1] >>> 0).toString(16)}`,
                `EDX=0x${(regs[2] >>> 0).toString(16)}`,
                `ESI=0x${(regs[6] >>> 0).toString(16)}`,
                `EDI=0x${(regs[7] >>> 0).toString(16)}`,
                `EBP=0x${(regs[5] >>> 0).toString(16)}`,
                `ESP=0x${esp.toString(16)}`,
            ].join(" ");
            Logger.error(LogCategory.SYSTEM, `   Registers: ${regDump}`);

            // Dump call stack if possible
            if (d.cachedMem8 && d.isDataViewValid() && esp > 0 && esp < d.cachedMem8.length - 64) {
                const callStack = d.reconstructCallStack(esp, d.cachedMem8, d.cachedDataView!);
                if (callStack.length > 0) {
                    Logger.error(LogCategory.SYSTEM, `   Call Stack (${callStack.length} frames):`);
                    for (let i = 0; i < Math.min(callStack.length, 10); i++) {
                        const frame = callStack[i];
                        Logger.error(LogCategory.SYSTEM,
                            `     ${i}. [ESP+${frame.stackOffset}] > 0x${frame.retAddr.toString(16)} ` +
                            `${frame.moduleName ? `(${frame.moduleName}+0x${frame.moduleOffset.toString(16)})` : '(unknown)'} ${frame.isThunk ? '?? thunk' : ''}`);
                    }
                }
            }

            // [DIAG] Extended stack dump: wider range to cover function frames below pre-fault ESP
            if (d.cachedMem8 && d.isDataViewValid() && esp > 0x40 && esp < d.cachedMem8.length - 256) {
                const dv = d.cachedDataView!;
                const lines: string[] = [];
                // Dump from ESP-0x40 to ESP+0xC0 (256 bytes total) to capture:
                // - Function frames BELOW the interrupt frame (return addresses, saved EBPs)
                // - The interrupt frame itself
                // - Pre-fault stack above
                const startOff = -0x40;
                const endOff = 0xC0;
                for (let off = startOff; off < endOff; off += 4) {
                    const addr = esp + off;
                    if (addr >= 0 && addr + 4 <= d.cachedMem8.length) {
                        const val = dv.getUint32(addr, true) >>> 0;
                        let label = '';
                        if (off === 0) label = ' [error_code]';
                        else if (off === 4) label = ' [faulting_EIP]';
                        else if (off === 8) label = ' [CS]';
                        else if (off === 12) label = ' [EFLAGS]';
                        else if (off === 16) label = ' [pre-fault ESP]';
                        // Mark known EBP values from diagnostics
                        if (addr === 0x8e53c) label += ' ?EBP_inner';
                        if (addr === 0x8e540) label += ' ?retAddr_from_epilog';
                        if (addr === 0x8e59c) label += ' ?EBP_caller';
                        if (addr === 0x8e5a0) label += ' ?retAddr_caller';
                        // Try to resolve addresses to modules
                        try {
                            const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(val);
                            if (resolved) label += ` > ${resolved}`;
                        } catch {}
                        lines.push(`     [0x${addr.toString(16).padStart(6,'0')}] = 0x${val.toString(16).padStart(8,'0')}${label}`);
                    }
                }
                Logger.error(LogCategory.SYSTEM, `   Extended stack dump (ESP=0x${esp.toString(16)}, range 0x${(esp+startOff).toString(16)}-0x${(esp+endOff).toString(16)}):\n${lines.join('\n')}`);
            }

            // Dump recent WinAPI calls
            const recentCalls = d.getLastWinApiCalls(50);
            if (recentCalls.length) {
                Logger.error(LogCategory.SYSTEM, `   Recent WinAPI calls: ${recentCalls.join(" | ")}`);
            }

            // [DIAG] Per-register deref: for each GPR holding what looks like a pointer,
            // show which memory region it hits and the first 16 bytes there. This is the
            // quickest way to tell "did the guest call through a corrupted vtable" vs
            // "did it call through a garbage pointer read from bytecode" vs "did ESP
            // get popped into code". Added while chasing UT99 VM #GP — fault pattern
            // is `CALL [ESI+disp]` where ESI was loaded from `[ECX]` and turned out
            // to be zero, so the CALL target = LOW_MEM[disp] which happened to be
            // the bootloader entry.
            if (d.cachedMem8 && d.isDataViewValid()) {
                const dv = d.cachedDataView!;
                const mem = d.cachedMem8;
                const memLen = mem.length;
                const regNames = ['EAX', 'ECX', 'EDX', 'EBX', 'ESP', 'EBP', 'ESI', 'EDI'];
                const frameBytes = exceptionsWithErrorCode.has(marker) ? 16 : 12;
                const preFaultEsp = (esp + frameBytes) >>> 0;
                if (preFaultEsp + 0x40 <= memLen) {
                    const stackTop = dv.getUint32(preFaultEsp, true) >>> 0;
                    let stackTopInfo = '';
                    try {
                        const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(stackTop);
                        if (resolved) stackTopInfo = ` > ${resolved}`;
                    } catch { /* */ }

                    const stackWords: string[] = [];
                    for (let j = 0; j < 0x40; j += 4) {
                        const word = dv.getUint32(preFaultEsp + j, true) >>> 0;
                        let info = '';
                        try {
                            const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(word);
                            if (resolved) info = ` > ${resolved}`;
                        } catch { /* */ }
                        stackWords.push(`[+0x${j.toString(16)}]=0x${word.toString(16)}${info}`);
                    }
                    Logger.error(LogCategory.SYSTEM,
                        `   Pre-fault ESP=0x${preFaultEsp.toString(16)} stackTop=0x${stackTop.toString(16)}${stackTopInfo} words=${stackWords.join(' | ')}`);

                    if (stackTop >= 32 && stackTop + 16 < memLen) {
                        const callBytes: string[] = [];
                        const callStart = stackTop - 32;
                        for (let j = 0; j < 48; j++) {
                            if (callStart + j === stackTop) callBytes.push('|RET|');
                            callBytes.push(mem[callStart + j].toString(16).padStart(2, '0'));
                        }
                        Logger.error(LogCategory.SYSTEM,
                            `   Code before stackTop/return address (0x${callStart.toString(16)}..+48, |RET| at 0x${stackTop.toString(16)}): ${callBytes.join(' ')}`);

                        // Decode the common MSVC pattern that caused the UT99 crash:
                        //   mov reg, [this]
                        //   push ...
                        //   call dword ptr [reg+disp32]
                        // If the vtable base register is zero, the indirect call target
                        // comes from LOW_MEM and looks like a thunk-return bug unless we
                        // log the original virtual-call operands.
                        const gprNames = ['EAX', 'ECX', 'EDX', 'EBX', 'ESP', 'EBP', 'ESI', 'EDI'];
                        const callAddr = stackTop - 6;
                        if (callAddr >= 0 && callAddr + 6 <= memLen && mem[callAddr] === 0xff) {
                            const modrm = mem[callAddr + 1];
                            const mod = (modrm >> 6) & 3;
                            const op = (modrm >> 3) & 7;
                            const rm = modrm & 7;
                            if (op === 2 && mod === 2 && rm !== 4) {
                                const disp = dv.getInt32(callAddr + 2, true) | 0;
                                const base = regs[rm] >>> 0;
                                const slot = (base + disp) >>> 0;
                                const target = slot + 4 <= memLen ? dv.getUint32(slot, true) >>> 0 : 0;
                                let targetInfo = '';
                                try {
                                    const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(target);
                                    if (resolved) targetInfo = ` > ${resolved}`;
                                } catch { /* */ }
                                const ecx = regs[1] >>> 0;
                                const ecxVtbl = ecx + 4 <= memLen ? dv.getUint32(ecx, true) >>> 0 : 0;
                                const ecx48 = ecx + 0x4C <= memLen ? dv.getUint32(ecx + 0x48, true) >>> 0 : 0;
                                const dispText = disp >= 0 ? `+0x${disp.toString(16)}` : `-0x${(-disp).toString(16)}`;
                                Logger.error(LogCategory.SYSTEM,
                                    `   Decoded indirect call: call dword ptr [${gprNames[rm]}${dispText}] ` +
                                    `slot=0x${slot.toString(16)} target=0x${target.toString(16)}${targetInfo}; ` +
                                    `ECX(this?)=0x${ecx.toString(16)} [ECX]=0x${ecxVtbl.toString(16)} [ECX+0x48]=0x${ecx48.toString(16)}`);
                            }
                        }
                    }

                    const dumpPointedBlock = (label: string, ptr: number) => {
                        if (ptr < 0x01000000 || ptr + 0x40 > memLen || (ptr & 3) !== 0) return;
                        const words: string[] = [];
                        for (let j = 0; j < 0x40; j += 4) {
                            const word = dv.getUint32(ptr + j, true) >>> 0;
                            let info = '';
                            try {
                                const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(word);
                                if (resolved) info = ` > ${resolved}`;
                            } catch { /* */ }
                            words.push(`[+0x${j.toString(16)}]=0x${word.toString(16)}${info}`);
                        }
                        Logger.error(LogCategory.SYSTEM, `   Pointed block ${label}=0x${ptr.toString(16)}: ${words.join(' | ')}`);
                    };

                    const dumpedBlocks = new Set<number>();
                    for (let off = 0; off < 0x40; off += 4) {
                        const ptr = dv.getUint32(preFaultEsp + off, true) >>> 0;
                        if (dumpedBlocks.has(ptr)) continue;
                        if (ptr >= 0x01000000 && ptr + 0x40 <= memLen && (ptr & 3) === 0) {
                            dumpedBlocks.add(ptr);
                            dumpPointedBlock(`[preESP+0x${off.toString(16)}]`, ptr);
                            if (dumpedBlocks.size >= 6) break;
                        }
                    }

                    // Find whether the bad ECX value is embedded in script bytecode
                    // near candidate frame/code pointers. In UE1 bytecode, property
                    // operands are patched to real UProperty* pointers after link;
                    // seeing an unaligned/zero-page pointer immediately before Code
                    // tells us the VM consumed a corrupt or unresolved operand.
                    const badThis = regs[1] >>> 0;
                    if (badThis >= 0x01000000) {
                        const refs: string[] = [];
                        const seenRefs = new Set<string>();
                        const noteRef = (label: string, addr: number) => {
                            const key = `${label}:${addr}`;
                            if (seenRefs.has(key) || addr < 0 || addr + 16 > memLen) return;
                            seenRefs.add(key);
                            const bytes: string[] = [];
                            const start = Math.max(0, addr - 8);
                            for (let j = 0; j < 24 && start + j < memLen; j++) {
                                if (start + j === addr) bytes.push('|HIT|');
                                bytes.push(mem[start + j].toString(16).padStart(2, '0'));
                            }
                            refs.push(`${label} @0x${addr.toString(16)} bytes=${bytes.join(' ')}`);
                        };
                        for (let off = -0x40; off < 0x200; off += 4) {
                            const stackAddr = esp + off;
                            if (stackAddr < 0 || stackAddr + 4 > memLen) continue;
                            const ptr = dv.getUint32(stackAddr, true) >>> 0;
                            if (ptr >= 0x01000000 && ptr + 0x30 <= memLen && (ptr & 3) === 0) {
                                for (let field = 0; field <= 0x20; field += 4) {
                                    const maybeCode = dv.getUint32(ptr + field, true) >>> 0;
                                    if (maybeCode >= 4 && maybeCode + 16 <= memLen) {
                                        if ((dv.getUint32(maybeCode - 4, true) >>> 0) === badThis) {
                                            noteRef(`[stack+0x${off.toString(16)}]->0x${ptr.toString(16)}[+0x${field.toString(16)}]-4`, maybeCode - 4);
                                        }
                                        if ((dv.getUint32(maybeCode, true) >>> 0) === badThis) {
                                            noteRef(`[stack+0x${off.toString(16)}]->0x${ptr.toString(16)}[+0x${field.toString(16)}]`, maybeCode);
                                        }
                                    }
                                }
                            }
                            if (refs.length >= 6) break;
                        }
                        if (refs.length > 0) {
                            Logger.error(LogCategory.SYSTEM,
                                `   Bad ECX appears in candidate bytecode/frame references:\n     ${refs.join('\n     ')}`);
                        }
                    }
                }

                const richTrace = d.getLastWinApiCallsRich(16).map((e: any) =>
                    `${e.name}(ESP=0x${e.esp.toString(16)}, retBefore=0x${e.retAddrBefore.toString(16)}, stackHash=0x${e.stackHash.toString(16)})`
                );
                if (richTrace.length > 0) {
                    Logger.error(LogCategory.SYSTEM, `   Recent WinAPI rich: ${richTrace.join(' | ')}`);
                }

                const valueTrace = d.getLastWinApiTrace(16);
                if (valueTrace.length > 0) {
                    Logger.error(LogCategory.SYSTEM, `   Recent WinAPI values:\n${valueTrace.join('\n')}`);
                }

                const classifyRegion = (addr: number): string => {
                    if (addr < 0x100000) return 'LOW_MEM';
                    if (addr < 0x01000000) return 'reserved<HEAP';
                    if (addr < 0x21000000) return 'HEAP';
                    if (addr < 0x22000000) return 'THUNK_CODE';
                    if (addr < 0x23000000) return 'THUNK_DATA';
                    if (addr < 0x24000000) return 'RESERVED';
                    if (addr < 0x2c000000) return 'ROM';
                    if (addr < 0x40000000) return 'SURFACE';
                    return 'high';
                };
                const lines: string[] = [];
                for (let i = 0; i < 8; i++) {
                    const v = regs[i] >>> 0;
                    if (v === 0 || v >= memLen - 16) continue;
                    const bytes: string[] = [];
                    for (let j = 0; j < 16; j++) {
                        bytes.push(mem[v + j].toString(16).padStart(2, '0'));
                    }
                    // First DWORD at [reg] - most likely a vtable pointer if this is a UObject*
                    const firstDword = dv.getUint32(v, true) >>> 0;
                    let firstDwordInfo = '';
                    try {
                        const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(firstDword);
                        if (resolved) firstDwordInfo = ` > ${resolved}`;
                    } catch { /* */ }
                    const region = classifyRegion(v);
                    lines.push(`     ${regNames[i]}=0x${v.toString(16).padStart(8, '0')} (${region}) bytes=[${bytes.join(' ')}] [reg]=0x${firstDword.toString(16)}${firstDwordInfo}`);
                }
                if (lines.length > 0) {
                    Logger.error(LogCategory.SYSTEM, `   Register deref (pointer-like GPRs):\n${lines.join('\n')}`);
                }

                // If the guest CALL'd through `[ESI+disp]` and ESI was small (null-ish), the
                // effective target comes from LOW_MEM. Dump the first 256 bytes of LOW_MEM
                // so we can see what accidentally lives at low offsets (leftover IVT,
                // BIOS data area, etc).
                const esi = regs[6] >>> 0;
                if (esi < 0x1000) {
                    const lowBytes: string[] = [];
                    for (let j = 0; j < 256; j += 4) {
                        const w = dv.getUint32(j, true) >>> 0;
                        if (w !== 0) {
                            let info = '';
                            try {
                                const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(w);
                                if (resolved) info = ` > ${resolved}`;
                            } catch { /* */ }
                            lowBytes.push(`[0x${j.toString(16).padStart(3, '0')}]=0x${w.toString(16).padStart(8, '0')}${info}`);
                        }
                    }
                    if (lowBytes.length > 0) {
                        Logger.error(LogCategory.SYSTEM, `   LOW_MEM[0..256] non-zero dwords: ${lowBytes.join(' | ')}`);
                    } else {
                        Logger.error(LogCategory.SYSTEM, `   LOW_MEM[0..256] all zero`);
                    }
                }

                // [DIAG] Heap block forensics: for heap-like pointers, dump 32 bytes BEFORE
                // and 32 bytes AFTER the register value. This catches slab headers
                // (SLAB_MAGIC=0x534C41xx at -4), and shows neighbors to distinguish
                // "pointer into uninitialised zero page" from "pointer into freed slot".
                const dumpHeapContext = (name: string, addr: number) => {
                    if (addr < 0x01000000 || addr >= memLen - 64) return;
                    const startAddr = addr - 32;
                    if (startAddr < 0) return;
                    const bytes: string[] = [];
                    for (let j = 0; j < 64; j++) {
                        if (startAddr + j === addr) bytes.push('|HERE|');
                        bytes.push(mem[startAddr + j].toString(16).padStart(2, '0'));
                    }
                    // Check for SLAB_MAGIC at addr-4 (allocation header from inline heap slab).
                    // 0x534C41xx = BUSY ('SLA'), 0x534C46xx = FREE ('SLF', flipped by the free
                    // stub). A FREE hit on a deref target is a smoking gun for use-after-free.
                    const maybeMagic = dv.getUint32(addr - 4, true) >>> 0;
                    const magicHi = maybeMagic & 0xFFFFFF00;
                    const slabBusyHit = magicHi === 0x534C4100;
                    const slabFreeHit = magicHi === 0x534C4600;
                    const magicInfo = slabBusyHit
                        ? ` SLAB_MAGIC hit! (BUSY) bin=${maybeMagic & 0xFF}`
                        : slabFreeHit
                            ? ` SLAB_MAGIC hit! (FREE — possible use-after-free) bin=${maybeMagic & 0xFF}`
                            : (maybeMagic === 0 ? ' (header=0, never-touched page or non-slab alloc)' : '');
                    Logger.error(LogCategory.SYSTEM,
                        `   ${name} context (0x${startAddr.toString(16)}..+64, |HERE| at 0x${addr.toString(16)}): ${bytes.join(' ')} |${magicInfo}`);
                };
                const ecx = regs[1] >>> 0;
                const eax = regs[0] >>> 0;
                const edi = regs[7] >>> 0;
                if (ecx >= 0x01000000) dumpHeapContext('ECX', ecx);
                if (eax >= 0x01000000 && eax !== ecx) dumpHeapContext('EAX', eax);
                if (edi >= 0x01000000 && edi !== ecx && edi !== eax) dumpHeapContext('EDI', edi);

                // If the call pattern looks like an Unreal FFrame VM dispatch
                // (caller is core.dll and Last thunk sequence includes msvcrt:_wtoi),
                // try to locate the FFrame* in the extended stack and dump its
                // Object/Code/Node pointers. The `d.getLastWinApiCalls()` ring gives
                // us ESP at each recent call — the caller of our faulting function used
                // one of those frames.
                if ((d.lastCallerModuleBase || 0) === 0x13070000) {
                    // Walk stack upward from fault ESP looking for plausible Frame
                    // pointers. FFrame is a ~32-byte struct; we can't pin it precisely
                    // without layout knowledge, but any dword in the stack that looks
                    // like a heap pointer with a resolvable-module first-dword is
                    // interesting.
                    const candidateLines: string[] = [];
                    const seenCandidates = new Set<number>();
                    for (let off = 0; off < 0x200; off += 4) {
                        const addr = esp + off;
                        if (addr + 4 > memLen) break;
                        const val = dv.getUint32(addr, true) >>> 0;
                        if (val < 0x01000000 || val >= memLen - 0x30) continue;
                        if ((val & 3) !== 0 || seenCandidates.has(val)) continue;
                        seenCandidates.add(val);
                        // Peek at +0x0C (Code ptr) and +0x10 (Object ptr) like the faulting function does
                        const code = dv.getUint32(val + 0x0C, true) >>> 0;
                        const object = dv.getUint32(val + 0x10, true) >>> 0;
                        if (code < 0x01000000 || object < 0x01000000) continue;
                        if (code >= memLen || object >= memLen) continue;
                        // Read bytecode around Code ptr
                        const bcBytes: string[] = [];
                        const bcStart = Math.max(0, code - 4);
                        for (let j = 0; j < 20; j++) {
                            if (bcStart + j === code) bcBytes.push('|CODE|');
                            if (bcStart + j < memLen) bcBytes.push(mem[bcStart + j].toString(16).padStart(2, '0'));
                        }
                        // First dword of Object = its vtable
                        const objVtbl = dv.getUint32(object, true) >>> 0;
                        let objVtblInfo = '';
                        try {
                            const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(objVtbl);
                            if (resolved) objVtblInfo = ` > ${resolved}`;
                        } catch { /* */ }
                        const frameWords: string[] = [];
                        for (let j = 0; j < 0x28; j += 4) {
                            const word = dv.getUint32(val + j, true) >>> 0;
                            let info = '';
                            try {
                                const resolved = System.getInstance().process?.moduleRegistry.resolveAddress(word);
                                if (resolved) info = ` > ${resolved}`;
                            } catch { /* */ }
                            frameWords.push(`[+0x${j.toString(16)}]=0x${word.toString(16)}${info}`);
                        }
                        candidateLines.push(
                            `     [ESP+0x${off.toString(16)}]=0x${val.toString(16)} Frame? ` +
                            `Code=0x${code.toString(16)} Object=0x${object.toString(16)} ` +
                            `[Obj]=0x${objVtbl.toString(16)}${objVtblInfo} ` +
                            `bytecode=${bcBytes.join(' ')} words=${frameWords.join(' ')}`
                        );
                        if (candidateLines.length >= 4) break;
                    }
                    if (candidateLines.length > 0) {
                        Logger.error(LogCategory.SYSTEM,
                            `   Candidate FFrame* on stack (dwords where [+0xC] and [+0x10] look heap-like):\n${candidateLines.join('\n')}`);
                    }
                }
            }

            const escapeAnalysis = buildEscapeAnalysis(marker, esp, faultingEipEarly);
            for (const l of escapeAnalysis) Logger.error(LogCategory.SYSTEM, `   [ESCAPE] ${l}`);
            reportFatalExecutionEscape(
                d, regs, esp, faultingEipEarly,
                `Execution escaped to bootloader at 0x${faultingEipEarly.toString(16)} (stack corruption or thunk return bug)`,
                escapeAnalysis,
            );
            return;
        }
        const registerDump = [
            `EAX=0x${(regs[0] >>> 0).toString(16)}`,
            `EBX=0x${(regs[3] >>> 0).toString(16)}`,
            `ECX=0x${(regs[1] >>> 0).toString(16)}`,
            `EDX=0x${(regs[2] >>> 0).toString(16)}`,
            `ESI=0x${(regs[6] >>> 0).toString(16)}`,
            `EDI=0x${(regs[7] >>> 0).toString(16)}`,
            `EBP=0x${(regs[5] >>> 0).toString(16)}`,
            `ESP=0x${esp.toString(16)}`,
            `EIP=0x${eip.toString(16)}`,
            `EFLAGS=0x${eflags.toString(16)}`,
        ].join(" ");
        Logger.error(LogCategory.SYSTEM, `Registers at exception: ${registerDump}`);

        if (d.lastThunkNameAfterReturn !== "" && esp !== d.lastExpectedEspAfterReturn) {
            // Only report "stack corruption" when fault occurred in our thunk stub (immediate post-RET). When fault is in guest code, ESP mismatch is normal (guest pushed more).
            const faultInStub = faultingEipEarly != null && d.thunkGeneratorBase !== 0 &&
                faultingEipEarly >= d.thunkGeneratorBase && faultingEipEarly < d.thunkGeneratorEnd;
            if (!faultInStub && faultingEipEarly != null) {
                Logger.log(LogCategory.SYSTEM,
                    `ESP mismatch at exception (fault in guest code at ${faultingEipEarly != null ? '0x' + faultingEipEarly.toString(16) : 'unknown'}, not in thunk stub - may be normal). ` +
                    `Last thunk was ${d.lastThunkNameAfterReturn}. Expected ESP=0x${d.lastExpectedEspAfterReturn.toString(16)}, got ESP=0x${esp.toString(16)}.`);
            } else {
                Logger.error(LogCategory.SYSTEM,
                    `Stack corruption detected at exception! ` +
                    `Last thunk was ${d.lastThunkNameAfterReturn} (id=0x${d.lastThunkIdAfterReturn.toString(16)}). ` +
                    `Expected ESP=0x${d.lastExpectedEspAfterReturn.toString(16)}, got ESP=0x${esp.toString(16)}.`);
                // Dump actual stub bytes to see if this thunk's RET is wrong or corruption happened later in guest code
                const stub = d.thunkGenerator.getStubById(d.lastThunkIdAfterReturn);
                if (stub && d.cachedMem8 && stub.address >= 0 && stub.address + 16 <= d.cachedMem8.length) {
                    const b11 = d.cachedMem8[stub.address + 11];
                    const b12 = d.cachedMem8[stub.address + 12];
                    const b13 = d.cachedMem8[stub.address + 13];
                    const retBytes = b11 === 0xC2 ? `RET 0x${(b12 | (b13 << 8)).toString(16)} (${b12 + (b13 << 8)} bytes)` : b11 === 0xC3 ? 'RET (0 args / cdecl)' : `0x${b11.toString(16)} 0x${b12.toString(16)} 0x${b13.toString(16)}`;
                    const expectedRet = stub.stackCleanupBytes ?? (stub.argCount ?? 0) * 4;
                    const actualRet = b11 === 0xC2 ? (b12 | (b13 << 8)) : b11 === 0xC3 ? 0 : -1;
                    Logger.error(LogCategory.SYSTEM,
                        `Stub ${d.lastThunkNameAfterReturn} at 0x${stub.address.toString(16)}: ${retBytes} (stackCleanupBytes=${stub.stackCleanupBytes ?? '?'}, expected RET ${expectedRet}).`);
                    if (actualRet !== expectedRet && actualRet >= 0) {
                        Logger.error(LogCategory.SYSTEM, `> This thunk has WRONG RET N; fix stackCleanupBytes/argCount in API or reference.`);
                    } else {
                        Logger.error(LogCategory.SYSTEM, `> Stub RET is correct; corruption likely from an earlier thunk in the chain or from guest code overwriting the stack.`);
                    }
                }
            }
        }

        // ESP often corrupted (e.g. 0x6d656439 = "med9") when fault is due to wrong stack cleanup
        if (d.cachedMem8 && (esp >= d.cachedMem8.length || esp > 0x08000000)) {
            Logger.error(LogCategory.SYSTEM,
                `ESP=0x${esp.toString(16)} is invalid (out of range) - likely stack corruption from wrong thunk RET N / stack cleanup. Check recent WinAPI argCount.`);
        }

        // Dump stack contents for debugging
        let faultingEip: number | null = null;
        if (d.cachedMem8 && esp > 0 && esp < d.cachedMem8.length - 16) {
            // Ensure DataView is valid - use safe check through cachedMem8
            if (d.isDataViewValid()) {
                const view = d.cachedDataView!;
                const stackDump = [];
                for (let i = 0; i < 4; i++) {
                    const addr = esp + i * 4;
                    if (addr + 4 <= d.cachedMem8.length) {
                        const value = view.getUint32(addr, true);
                        stackDump.push(`[ESP+${i * 4}]=0x${value.toString(16)}`);
                        // Extract faulting EIP: at [ESP+4] for exceptions with error code, [ESP+0] for all others
                        const eipSlot = exceptionsWithErrorCode.has(marker) ? 1 : 0;
                        if (i === eipSlot) faultingEip = value >>> 0;
                    }
                }
                Logger.error(LogCategory.SYSTEM, `Stack at exception: ${stackDump.join(" ")}`);

                // Reconstruct call stack by scanning for return addresses
                Logger.log(LogCategory.SYSTEM, `?? Reconstructing call stack from ESP=0x${esp.toString(16)}...`);
                const callStack = d.reconstructCallStack(esp, d.cachedMem8, view);
                if (callStack.length > 0) {
                    Logger.log(LogCategory.SYSTEM, `?? Call Stack (${callStack.length} frames):`);
                    for (let i = 0; i < callStack.length; i++) {
                        const frame = callStack[i];
                        Logger.log(LogCategory.SYSTEM,
                            `  ${i.toString().padStart(2, ' ')}. [ESP+${frame.stackOffset.toString().padStart(3, ' ')}] > 0x${frame.retAddr.toString(16)} ` +
                            `${frame.moduleName ? `(${frame.moduleName}+0x${frame.moduleOffset.toString(16)})` : '(unknown)'} ${frame.isThunk ? '?? thunk' : ''}`);
                    }
                } else {
                    Logger.warn(LogCategory.SYSTEM, `?? No valid return addresses found on stack (stack heavily corrupted?)`);
                }
            }
        }
        if (faultingEip != null) {
            Logger.error(LogCategory.SYSTEM, `Faulting EIP (guest): 0x${faultingEip.toString(16)}`);
            if (faultingEip >= BOOTLOADER_START && faultingEip < BOOTLOADER_END) {
                Logger.error(LogCategory.SYSTEM,
                    `Faulting EIP is in bootloader range (0x${BOOTLOADER_START.toString(16)}..0x${BOOTLOADER_END.toString(16)}) - likely stack corruption or wrong return address (check thunk RET N / stack cleanup).`);
            }

            // Check if faulting EIP is in a known module
            const moduleRegistry = System.getInstance().process?.moduleRegistry;
            if (moduleRegistry) {
                const faultMod = moduleRegistry.getModuleContainingAddress(faultingEip);
                if (faultMod) {
                    Logger.error(LogCategory.SYSTEM,
                        `?? Fault in module: ${faultMod.name} at offset +0x${(faultingEip - faultMod.baseAddress).toString(16)}`);
                } else {
                    Logger.error(LogCategory.SYSTEM, `?? Fault address 0x${faultingEip.toString(16)} NOT in any loaded module (stack/heap/unknown)`);
                }
            }
        }

        Logger.error(LogCategory.SYSTEM, `EXCEPTION 0x${marker.toString(16)} triggered`);
        const recentCalls = d.getLastWinApiCalls(32);
        if (recentCalls.length) {
            Logger.log(LogCategory.SYSTEM, `Recent WinAPI calls: ${recentCalls.join(" | ")}`);
        } else {
            Logger.error(LogCategory.SYSTEM, "Recent WinAPI calls empty - enable debug mode so fast-path thunks are recorded for stack-corruption diagnosis.");
        }
}

/**
 * Kernel32 Exception functions
 *
 * Atomic implementation for exception handling
 */

import { ThunkImplementation, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { getCPU } from '../../core/thunking/thunk-utils';
import { dispatchCxxException, dispatchFinallyUnwind } from '../../core/seh-dispatch';
import { readAnsiFromGuest } from '../codepage-utils';

function tryReadUeAnsiFString(mem: Uint8Array, arrayPtr: number, maxChars = 512): string | null {
    if (!arrayPtr || arrayPtr + 12 > mem.length) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const dataPtr = view.getUint32(arrayPtr, true);
    const num = view.getInt32(arrayPtr + 4, true);
    if (!dataPtr || num <= 0 || num > maxChars) return null;
    const text = readAnsiFromGuest(mem, dataPtr, num);
    return text.length > 0 ? text : null;
}

function dumpGuestDwords(mem: Uint8Array, ptr: number, words: number = 8): string {
    if (!ptr || ptr < 0 || ptr + words * 4 > mem.length) {
        return `ptr=0x${(ptr >>> 0).toString(16)} <out-of-range>`;
    }
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const parts: string[] = [];
    for (let i = 0; i < words; i++) {
        const addr = ptr + i * 4;
        const value = view.getUint32(addr, true) >>> 0;
        parts.push(`[+0x${(i * 4).toString(16)}]=0x${value.toString(16)}`);
    }
    return `ptr=0x${ptr.toString(16)} ${parts.join(' ')}`;
}

/** Exception-filter dispositions, and the stdcall arg size both filters share. */
const EXCEPTION_CONTINUE_SEARCH = 0;
const EXCEPTION_EXECUTE_HANDLER = 1;
const UEF_STACK_CLEANUP = 4;

// EncodePointer/DecodePointer cookie — module-scope so fast path can access it.
// Must NOT be zero! See comment in exceptionExports below.
let pointerCookie = 0;
const getPointerCookie = (): number => {
    if (pointerCookie === 0) {
        pointerCookie = ((Math.random() * 0x7FFFFFFF) >>> 0) | 0x40000000;
    }
    return pointerCookie;
};

/** New process ⇒ fresh EncodePointer cookie (Process.reset reuses the Process object). */
export function resetPointerCookie(): void {
    pointerCookie = 0;
}

// Well-known NTSTATUS exception codes
const EXCEPTION_CODE_NAMES: Record<number, string> = {
    0xC0000005: 'ACCESS_VIOLATION',
    0xC0000006: 'IN_PAGE_ERROR',
    0xC0000017: 'NO_MEMORY',
    0xC000001D: 'ILLEGAL_INSTRUCTION',
    0xC0000025: 'NONCONTINUABLE_EXCEPTION',
    0xC0000026: 'INVALID_DISPOSITION',
    0xC000008C: 'ARRAY_BOUNDS_EXCEEDED',
    0xC000008D: 'FLOAT_DENORMAL_OPERAND',
    0xC000008E: 'FLOAT_DIVIDE_BY_ZERO',
    0xC0000090: 'FLOAT_INVALID_OPERATION',
    0xC0000091: 'FLOAT_OVERFLOW',
    0xC0000094: 'INTEGER_DIVIDE_BY_ZERO',
    0xC0000095: 'INTEGER_OVERFLOW',
    0xC0000096: 'PRIVILEGED_INSTRUCTION',
    0xC0000409: 'STACK_BUFFER_OVERRUN',
    0xC00000FD: 'STACK_OVERFLOW',
    0x80000003: 'BREAKPOINT',
    0x80000004: 'SINGLE_STEP',
    0xe06d7363: 'MSVC_CPP_EXCEPTION',
    0xc06d007e: 'MSVC_DELAYLOAD_MODULE_NOT_FOUND',
    0xc06d007f: 'MSVC_DELAYLOAD_PROC_NOT_FOUND',
};

export const exports: Record<string, ThunkImplementation> = (() => {
    const exports: Record<string, ThunkImplementation> = {};

    const terminateUnhandledException = (exitCode: number, reason: string): ThunkResult => {
        const system = System.getInstance();
        const safeExitCode = exitCode >>> 0;
        Logger.error(LogCategory.KERNEL32,
            `${reason} -> terminating process with exitCode=0x${safeExitCode.toString(16)}`);
        system.isExiting = true;
        system.scheduler.exitThread(safeExitCode);
        return { value: 0, terminated: true };
    };

    const dispatchRaiseExceptionViaSeh = (
        mem: Uint8Array,
        ctx: { esp: number },
        dwExceptionCode: number,
        dwExceptionFlags: number,
        nNumberOfArguments: number,
        lpArguments: number,
        label: string,
    ): ThunkResult => {
        const system = System.getInstance();
        const cpu = getCPU(system.process!.v86);
        const dispatcher = system.process?.dispatcher;
        if (!cpu || !dispatcher) {
            return terminateUnhandledException(
                dwExceptionCode,
                `RaiseException: no CPU/dispatcher (${label})`,
            );
        }

        const x86Result = dispatcher.setupCxxExceptionX86Dispatch(
            cpu,
            mem,
            ctx.esp,
            dwExceptionCode >>> 0,
            dwExceptionFlags >>> 0,
            nNumberOfArguments >>> 0,
            lpArguments >>> 0,
            16,
        );
        if (x86Result) {
            return x86Result;
        }

        return terminateUnhandledException(
            dwExceptionCode,
            `RaiseException: unhandled exception (${label})`,
        );
    };

    exports['SetUnhandledExceptionFilter'] = (ctx, mem, args) => {
        const lpTopLevelExceptionFilter = args[0];

        Logger.log(LogCategory.KERNEL32, `SetUnhandledExceptionFilter(0x${lpTopLevelExceptionFilter.toString(16)})`);

        // Track in dispatcher for fallback invocation on unhandled AV
        const dispatcher = System.getInstance().process?.dispatcher;
        const oldFilter = dispatcher
            ? dispatcher.setUnhandledExceptionFilter(lpTopLevelExceptionFilter)
            : 0;

        return oldFilter;
    };

    exports['UnhandledExceptionFilter'] = (ctx, mem, args) => {
        const ExceptionInfo = args[0];

        // Read EXCEPTION_POINTERS: { PEXCEPTION_RECORD, PCONTEXT }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let details = `UnhandledExceptionFilter(0x${ExceptionInfo.toString(16)})`;

        try {
            const pExceptionRecord = view.getUint32(ExceptionInfo, true);
            const pContext = view.getUint32(ExceptionInfo + 4, true);

            // EXCEPTION_RECORD layout:
            //   +0:  ExceptionCode (DWORD)
            //   +4:  ExceptionFlags (DWORD)
            //   +12: ExceptionAddress (PVOID)
            //   +16: NumberParameters (DWORD)
            //   +20: ExceptionInformation[0] (read/write flag for AV)
            //   +24: ExceptionInformation[1] (faulting address for AV)
            const exCode = view.getUint32(pExceptionRecord, true) >>> 0;
            const exFlags = view.getUint32(pExceptionRecord + 4, true) >>> 0;
            const exAddress = view.getUint32(pExceptionRecord + 12, true) >>> 0;
            const numParams = view.getUint32(pExceptionRecord + 16, true) >>> 0;

            const codeName = EXCEPTION_CODE_NAMES[exCode] ?? 'UNKNOWN';
            details = `UnhandledExceptionFilter: code=0x${exCode.toString(16)} (${codeName}), flags=0x${exFlags.toString(16)}, addr=0x${exAddress.toString(16)}`;

            // For ACCESS_VIOLATION, decode read/write + faulting address
            if (exCode === 0xC0000005 && numParams >= 2) {
                const rwFlag = view.getUint32(pExceptionRecord + 20, true);
                const faultAddr = view.getUint32(pExceptionRecord + 24, true) >>> 0;
                const rwStr = rwFlag === 0 ? 'READ' : rwFlag === 1 ? 'WRITE' : rwFlag === 8 ? 'DEP' : `flag=${rwFlag}`;
                details += `, AV: ${rwStr} at 0x${faultAddr.toString(16)}`;
            }

            // Read x86 CONTEXT for EIP, ESP, EAX
            if (pContext !== 0) {
                const ctxEip = view.getUint32(pContext + 0xB8, true) >>> 0;
                const ctxEsp = view.getUint32(pContext + 0xC4, true) >>> 0;
                const ctxEbp = view.getUint32(pContext + 0xB4, true) >>> 0;
                const ctxEax = view.getUint32(pContext + 0xB0, true) >>> 0;
                const ctxEbx = view.getUint32(pContext + 0xA4, true) >>> 0;
                const ctxEcx = view.getUint32(pContext + 0xAC, true) >>> 0;
                const ctxEdx = view.getUint32(pContext + 0xA8, true) >>> 0;
                const ctxEsi = view.getUint32(pContext + 0x68, true) >>> 0;
                const ctxEdi = view.getUint32(pContext + 0x9C, true) >>> 0;
                details += `, ctx: EIP=0x${ctxEip.toString(16)} ESP=0x${ctxEsp.toString(16)} EBP=0x${ctxEbp.toString(16)} EAX=0x${ctxEax.toString(16)}`;
                details += `\n  EBX=0x${ctxEbx.toString(16)} ECX=0x${ctxEcx.toString(16)} EDX=0x${ctxEdx.toString(16)} ESI=0x${ctxEsi.toString(16)} EDI=0x${ctxEdi.toString(16)}`;

                // EBP frame walk for call stack
                const frames: string[] = [];
                let ebp = ctxEbp;
                for (let depth = 0; depth < 16 && ebp > 0x10000 && ebp < mem.length - 8; depth++) {
                    const retAddr = view.getUint32(ebp + 4, true) >>> 0;
                    if (retAddr < 0x400000 || retAddr > 0x700000) break;
                    frames.push(`0x${retAddr.toString(16)}`);
                    ebp = view.getUint32(ebp, true) >>> 0;
                }
                if (frames.length > 0) {
                    details += `\n  EBP chain: ${frames.join(' → ')}`;
                }

                // Also dump stack around ESP
                const stackDump: string[] = [];
                for (let i = 0; i < 16; i++) {
                    const addr = ctxEsp + i * 4;
                    if (addr + 4 <= mem.length) {
                        const val = view.getUint32(addr, true) >>> 0;
                        if (val >= 0x400000 && val < 0x600000) {
                            stackDump.push(`[ESP+${(i*4).toString(16)}]=0x${val.toString(16)}*`);
                        }
                    }
                }
                if (stackDump.length > 0) {
                    details += `\n  Code addrs on stack: ${stackDump.join(' ')}`;
                }
            }
        } catch (e) {
            details += ` (failed to read exception info: ${e})`;
        }

        Logger.error(LogCategory.KERNEL32, details);

        // Dump recent thunk calls for the crashing thread
        try {
            const system = System.getInstance();
            const dispatcher = system.process?.dispatcher;
            const scheduler = system.scheduler;
            if (dispatcher) {
                const recent = dispatcher.getLastWinApiCalls(16);
                if (recent.length) {
                    const threadId = scheduler?.getCurrentThreadId() ?? '?';
                    Logger.error(LogCategory.KERNEL32,
                        `[CRASH DIAG] Thread ${threadId} recent thunks: ${recent.join(' | ')}`);
                }
            }
        } catch (_) {
            // Best-effort diagnostics
        }

        // Windows hands the exception to the filter the app registered with
        // SetUnhandledExceptionFilter and returns whatever that filter decides. Skipping
        // that call is not a missing diagnostic but a wrong answer: an app whose filter
        // would have said "continue execution" — the shape anti-debug probes take, where a
        // deliberate INT 3 is expected to come back through here — instead sees its own
        // exception go unhandled and dies.
        const dispatcher = System.getInstance().process?.dispatcher;
        const filter = dispatcher?.getUnhandledExceptionFilter() ?? 0;
        const callbackManager = dispatcher?.callbackManager;
        if (filter && callbackManager) {
            const frameId = callbackManager.saveSuspendedThunkContext(ctx, UEF_STACK_CLEANUP, 'UnhandledExceptionFilter');
            if (frameId) {
                const { callbackId } = callbackManager.invokeCallback(
                    filter,
                    [ExceptionInfo],
                    UEF_STACK_CLEANUP,
                    // A filter that declines still ends the process on Windows: UEF puts up
                    // the fatal-error dialog and reports EXCEPTION_EXECUTE_HANDLER so the
                    // CRT's __except runs its exit path.
                    (ret: number) => (ret === EXCEPTION_CONTINUE_SEARCH ? EXCEPTION_EXECUTE_HANDLER : ret),
                    false,
                    'UnhandledExceptionFilter',
                    frameId,
                );
                if (callbackId) {
                    return {
                        value: 0,
                        suspendedForCallback: true,
                        callbackId,
                        stackCleanup: UEF_STACK_CLEANUP,
                    };
                }
            }
            Logger.error(LogCategory.KERNEL32,
                `UnhandledExceptionFilter: could not invoke the app filter at 0x${filter.toString(16)}`);
        }

        return EXCEPTION_EXECUTE_HANDLER;
    };

    exports['RaiseException'] = (ctx, mem, args) => {
        const dwExceptionCode = args[0];
        const dwExceptionFlags = args[1];
        const nNumberOfArguments = args[2];
        const lpArguments = args[3];

        let extra = '';
        if (dwExceptionCode === 0xe06d7363 && lpArguments && nNumberOfArguments >= 3) {
            // MSVC C++ exception: args[0]=magic, args[1]=thrown object ptr, args[2]=_ThrowInfo ptr
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            try {
                const magic = view.getUint32(lpArguments, true);
                const thrownObjPtr = view.getUint32(lpArguments + 4, true);
                const throwInfoPtr = view.getUint32(lpArguments + 8, true);
                let thrownValuePtr = 0;
                extra = ` C++ throw: magic=0x${magic.toString(16)}, objPtr=0x${thrownObjPtr.toString(16)}, throwInfo=0x${throwInfoPtr.toString(16)}`;

                // Try to read type name from ThrowInfo → CatchableTypeArray → CatchableType → TypeDescriptor
                if (throwInfoPtr) {
                    const ctArrayRVA = view.getUint32(throwInfoPtr + 12, true);
                    if (ctArrayRVA) {
                        const ctArrayPtr = ctArrayRVA; // For non-RVA (Win9x), direct pointer
                        const nTypes = view.getUint32(ctArrayPtr, true);
                        if (nTypes > 0 && nTypes < 100) {
                            const ctRVA = view.getUint32(ctArrayPtr + 4, true);
                            if (ctRVA) {
                                const tdPtr = view.getUint32(ctRVA + 4, true);
                                if (tdPtr) {
                                    // TypeDescriptor: hash at +0, spare at +4, name at +8
                                    const name = readAnsiFromGuest(mem, tdPtr + 8, 128);
                                    extra += `, typeName="${name}"`;
                                    if (thrownObjPtr) {
                                        try {
                                            const val = view.getUint32(thrownObjPtr, true);
                                            thrownValuePtr = val >>> 0;
                                            extra += `, value=${val} (0x${val.toString(16)})`;
                                            // For std::basic_string, try to read the string content
                                            if (name.includes('basic_string')) {
                                                // MSVC std::string layout: [+0]=allocator?, [+4]=ptr or inline buf, [+16]=length, [+20]=capacity
                                                // Try common layouts to find the char* pointer
                                                for (const ptrOff of [4, 0]) {
                                                    const strPtr = view.getUint32(thrownObjPtr + ptrOff, true);
                                                    if (strPtr > 0x10000 && strPtr + 1 < mem.length) {
                                                        const str = readAnsiFromGuest(mem, strPtr, 512);
                                                        if (str.length > 0 && str.charCodeAt(0) >= 0x20) {
                                                            extra += `, stringContent="${str}"`;
                                                            break;
                                                        }
                                                    }
                                                }
                                            } else {
                                                for (const arrOff of [8, 0, 4, 12]) {
                                                    const arrPtr = view.getUint32(thrownObjPtr + arrOff, true);
                                                    const ueStr = tryReadUeAnsiFString(mem, arrPtr);
                                                    if (ueStr) {
                                                        extra += `, ueString="${ueStr}"`;
                                                        break;
                                                    }
                                                }
                                            }
                                        } catch (_) {}
                                    }
                                }
                            }
                        }
                    }
                }

                if (thrownObjPtr) {
                    extra += `, objDump={${dumpGuestDwords(mem, thrownObjPtr, 8)}}`;
                }
                if (thrownValuePtr) {
                    extra += `, valueDump={${dumpGuestDwords(mem, thrownValuePtr, 8)}}`;
                }
            } catch (e) {
                extra += ` (failed to decode: ${e})`;
            }
        }

        // Log caller return address for context, with module identification
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const callerEIP = ctx.esp ? view.getUint32(ctx.esp, true) : 0;
        let callerModule = '';
        try {
            const mod = System.getInstance().process?.moduleRegistry?.getModuleContainingAddress(callerEIP);
            if (mod) callerModule = ` [${mod.name}${mod.isRealDll ? ' (native)' : ''}]`;
        } catch { /* */ }
        Logger.error(LogCategory.KERNEL32,
            `RaiseException(code=0x${dwExceptionCode.toString(16)}, flags=0x${dwExceptionFlags.toString(16)}, ` +
            `nArgs=${nNumberOfArguments}, lpArgs=0x${(lpArguments >>> 0).toString(16)})` +
            extra + ` callerRet=0x${callerEIP.toString(16)}${callerModule}`);


        // Dispatch MSVC C++ exceptions through SEH chain
        if (dwExceptionCode === 0xe06d7363 && lpArguments && nNumberOfArguments >= 3) {
            const objPtr = view.getUint32(lpArguments + 4, true);
            const throwInfoPtr = view.getUint32(lpArguments + 8, true);

            const system = System.getInstance();
            const dispatcher = system.process?.dispatcher;
            if (dispatcher) {
                const recentTrace = dispatcher.getLastWinApiTrace(24);
                if (recentTrace.length) {
                    Logger.error(LogCategory.KERNEL32, `RaiseException crash trace — last ${recentTrace.length} thunks:\n  ${recentTrace.join('\n  ')}`);
                }
            }
            const cpu = getCPU(system.process!.v86);
            if (cpu) {
                // RaiseException is stdcall(code, flags, nArgs, lpArgs): thunk RET 16.
                const result = dispatchCxxException(mem, cpu, objPtr, throwInfoPtr, 16);
                if (result && !('deferToX86' in result)) return result;

                if (result) {
                    // JS walk met a non-C++ frame (__try/__except) whose filter must run
                    // natively. For a rethrow tracked only on the JS side, complete the
                    // record's parameters so guest __CxxFrameHandler can type-match
                    // without CRT per-thread state.
                    if (objPtr === 0 && throwInfoPtr === 0 && result.pExceptionObject !== 0) {
                        view.setUint32(lpArguments + 4, result.pExceptionObject, true);
                        view.setUint32(lpArguments + 8, result.pThrowInfo, true);
                    }
                    return dispatchRaiseExceptionViaSeh(
                        mem,
                        ctx,
                        dwExceptionCode,
                        dwExceptionFlags,
                        nNumberOfArguments,
                        lpArguments,
                        `C++ defer obj=0x${result.pExceptionObject.toString(16)}, throwInfo=0x${result.pThrowInfo.toString(16)}`,
                    );
                }

                // JS-side parser couldn't recognize the handler FuncInfo layout (e.g. modern MSVC).
                // Fall back to x86-based dispatch: call real handlers via static SEH stub.
                if (objPtr === 0 && throwInfoPtr === 0) {
                    Logger.warn(LogCategory.KERNEL32,
                        `RaiseException: re-throw with no active exception — dispatching via x86 SEH (terminate path)`);
                } else {
                    Logger.warn(LogCategory.KERNEL32,
                        `RaiseException: JS dispatch failed, falling back to x86 SEH stub dispatch`);
                }
                return dispatchRaiseExceptionViaSeh(
                    mem,
                    ctx,
                    dwExceptionCode,
                    dwExceptionFlags,
                    nNumberOfArguments,
                    lpArguments,
                    `C++ obj=0x${objPtr.toString(16)}, throwInfo=0x${throwInfoPtr.toString(16)}`,
                );
            }
        }

        // Structured / MSVC runtime exceptions (e.g. 0xC06D007F after SXS/actctx failure).
        // RaiseException must never return to the caller on Windows.
        const codeName = EXCEPTION_CODE_NAMES[dwExceptionCode >>> 0]
            ?? `0x${(dwExceptionCode >>> 0).toString(16)}`;
        Logger.warn(LogCategory.KERNEL32,
            `RaiseException: dispatching structured exception ${codeName} via x86 SEH`);
        return dispatchRaiseExceptionViaSeh(
            mem,
            ctx,
            dwExceptionCode,
            dwExceptionFlags,
            nNumberOfArguments,
            lpArguments,
            codeName,
        );
    };

    /**
     * RtlUnwind — perform global unwind of SEH chain.
     *
     * void RtlUnwind(
     *     PVOID TargetFrame,           // Frame to stop at (unlink up to here)
     *     PVOID TargetIp,              // Unused on x86
     *     PEXCEPTION_RECORD ExcRecord, // Exception being unwound (may be NULL)
     *     PVOID ReturnValue            // Value to place in EAX on return
     * );
     *
     * Walks the SEH chain from FS:[0], calling each handler with EH_UNWINDING flag
     * until reaching TargetFrame. Handlers use this to run __finally blocks.
     * After completion, unlinks the chain so FS:[0] = TargetFrame.
     */
    exports['RtlUnwind'] = (ctx, mem, args) => {
        const targetFrame = args[0] >>> 0;
        const _targetIp = args[1] >>> 0;
        const pExceptionRecord = args[2] >>> 0;
        const returnValue = args[3] >>> 0;

        const system = System.getInstance();

        // RtlUnwind means a handler has decided to catch — notify dispatcher so it can
        // pop the active SEH dispatch context and stop SWITCH_DEFERRED_SEH_RUNTIME.
        const dispatcher = system.process?.dispatcher;
        if (dispatcher && dispatcher.getSehDispatchDepth() > 0) {
            dispatcher.notifySehHandlerCaught(targetFrame);
        }

        const cpu = getCPU(system.process!.v86);
        if (!cpu) {
            Logger.error(LogCategory.KERNEL32, `RtlUnwind: no CPU`);
            return 0;
        }

        const tebAddr = cpu.segment_offsets?.[4] ?? 0;
        if (tebAddr === 0) {
            Logger.error(LogCategory.KERNEL32, `RtlUnwind: no TEB`);
            return 0;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const sehHead = view.getUint32(tebAddr, true) >>> 0;

        Logger.log(LogCategory.KERNEL32,
            `RtlUnwind(targetFrame=0x${targetFrame.toString(16)}, excRec=0x${pExceptionRecord.toString(16)}, ` +
            `retVal=0x${returnValue.toString(16)}) sehHead=0x${sehHead.toString(16)}`);

        // Set EH_UNWINDING flag on the exception record so handlers know this is an unwind pass
        if (pExceptionRecord !== 0 && pExceptionRecord + 8 <= mem.length) {
            const EH_UNWINDING = 0x02;
            const oldFlags = view.getUint32(pExceptionRecord + 4, true);
            view.setUint32(pExceptionRecord + 4, oldFlags | EH_UNWINDING, true);
        }

        // RtlUnwind is stdcall with 4 args → stub does RET 16
        const RTLUNWIND_CLEANUP = 16;

        // Try to run __finally blocks via trampoline on the dead stack.
        // dispatchFinallyUnwind walks __except_handler3 frames from FS:[0] to targetFrame,
        // collects scope table entries with filterAddr==0, and emits a trampoline that
        // calls each funclet (MOV EBP, frame+16; CALL handler), updates FS:[0], then
        // returns to our caller via MOV ESP, callerEsp; JMP retAddr.
        const trampolineResult = dispatchFinallyUnwind(
            mem, cpu, ctx.esp, tebAddr, targetFrame, returnValue, RTLUNWIND_CLEANUP,
        );
        if (trampolineResult) return trampolineResult;

        // No __finally blocks found — simple path: just unlink frames and return.
        // Windows RtlUnwind unlinks all frames from FS:[0] up to but NOT INCLUDING
        // targetFrame, leaving FS:[0] = targetFrame. The target is the catching frame and
        // STAYS in the chain: for C-style SEH (_except_handler3, one registration per
        // function shared across __try blocks via trylevel) the function keeps running
        // into its __except block and still relies on its own registration being live.
        //
        // We previously set FS:[0] = targetFrame->next (removing the target). That masked a
        // self-loop in some titles but is wrong per the Win32 contract: under OldUnreal's
        // `guard` macros, boot performs many *sequential* SEH catches, and dropping a live
        // catching frame each time orphaned it. After ~3 catches the chain was corrupt, so
        // the next throw's handler walked a reused stack slot (garbage scopetable) and #PF'd
        // inside core's _except_handler3 → SEH nested-fault halt → derail. (unreal-gold 227.)
        if (targetFrame !== 0) {
            view.setUint32(tebAddr, targetFrame, true);
            Logger.log(LogCategory.KERNEL32,
                `RtlUnwind: no __finally blocks, FS:[0] = 0x${targetFrame.toString(16)} (targetFrame stays — Win32 contract)`);
        }

        cpu.reg32[0] = returnValue | 0;
        return { value: returnValue, stackCleanup: RTLUNWIND_CLEANUP };
    };

    // void RtlCaptureContext(PCONTEXT ContextRecord)
    // Fills x86 CONTEXT struct (716 bytes) with current register state.
    exports['RtlCaptureContext'] = (ctx, mem, args) => {
        const pContext = args[0] >>> 0;
        if (!pContext || pContext + 0x2CC > mem.length) {
            return { value: 0, stackCleanup: 4 };
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        mem.fill(0, pContext, pContext + 0x2CC);

        // ContextFlags = CONTEXT_FULL (0x10007)
        view.setUint32(pContext + 0x00, 0x10007, true);
        // Integer registers from thunk context
        view.setUint32(pContext + 0x9C, (ctx as any).edi ?? 0, true);  // Edi
        view.setUint32(pContext + 0xA0, (ctx as any).esi ?? 0, true);  // Esi
        view.setUint32(pContext + 0xA4, (ctx as any).ebx ?? 0, true);  // Ebx
        view.setUint32(pContext + 0xA8, (ctx as any).edx ?? 0, true);  // Edx
        view.setUint32(pContext + 0xAC, (ctx as any).ecx ?? 0, true);  // Ecx
        view.setUint32(pContext + 0xB0, (ctx as any).eax ?? 0, true);  // Eax
        view.setUint32(pContext + 0xB4, (ctx as any).ebp ?? 0, true);  // Ebp
        view.setUint32(pContext + 0xB8, (ctx as any).eip ?? 0, true);  // Eip
        view.setUint32(pContext + 0xC4, (ctx as any).esp ?? 0, true);  // Esp

        return { value: 0, stackCleanup: 4 };
    };

    // EncodePointer/DecodePointer: XOR with process-specific cookie.
    // Must NOT be identity! MSVC CRT's __init_pointers stores
    // EncodePointer(NULL) as sentinel for "no handler". If EncodePointer(NULL)=0
    // (identity), CRT confuses "no handler" with "uninitialized" → _invoke_watson
    // terminates instead of returning from _invalid_parameter.
    exports['EncodePointer'] = (ctx, mem, args) => {
        return (args[0] ^ getPointerCookie()) >>> 0;
    };

    exports['DecodePointer'] = (ctx, mem, args) => {
        return (args[0] ^ getPointerCookie()) >>> 0;
    };

    return exports;
})();

/**
 * Register fast paths for EncodePointer/DecodePointer (5841 calls during Montezuma load).
 * Both are the same XOR operation (self-inverse).
 */
export function registerFastPathPointerFunctions(dispatcher: any): void {
    if (!dispatcher?.registerFastPath) return;

    const impl = (cpu: any, mem8: Uint8Array, _m32: Uint32Array, view: DataView): number | null => {
        const esp = cpu.reg32[4] >>> 0;
        if (esp + 8 > mem8.length) return null;
        const ptr = view.getUint32(esp + 4, true) >>> 0;
        return (ptr ^ getPointerCookie()) >>> 0;
    };

    dispatcher.registerFastPath('kernel32', 'EncodePointer', impl, { trivial: true });
    dispatcher.registerFastPath('kernel32', 'DecodePointer', impl, { trivial: true });
    Logger.log(LogCategory.KERNEL32, 'Registered fast path for EncodePointer/DecodePointer');
}

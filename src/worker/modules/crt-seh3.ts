/**
 * MSVC VC5/6-era SEH exports: _except_handler3, __CxxFrameHandler and
 * _CxxThrowException (plus the local-unwind / except-block-jump / complex-
 * filter-redirect helpers they share).
 *
 * Host supplies Process (CPU access + dispatcher's SEH notification/redirect
 * primitives) and terminateProcess for the unhandled-C++-exception path.
 * Catch dispatch / static filter evaluation live in core/seh-dispatch — this
 * module is the CRT export surface over it.
 */

import { Logger, LogCategory } from "../core/logger";
import { Marshaler } from "../core/memory/marshaler";
import { getCPU } from "../core/thunking/thunk-utils";
import { dispatchCxxException, evaluateSimpleFilter } from "../core/seh-dispatch";
import type { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface CrtSeh3Host {
    process: Process;
    terminateProcess(code: number, reason: string): ThunkResult;
}

export function registerCrtSeh3Exports(exports: Record<string, ThunkImplementation>, host: CrtSeh3Host): void {

    /**
     * _except_handler3 — MSVC VC5/6 structured exception handler.
     *
     * Called by the SEH dispatch stub (or OS) with cdecl convention, 4 args:
     *   args[0] = ExceptionRecord*
     *   args[1] = EstablisherFrame* (= SEH frame address)
     *   args[2] = Context*
     *   args[3] = DispatcherContext*
     *
     * Frame layout at EstablisherFrame:
     *   [frame+0]  = next SEH handler
     *   [frame+4]  = handler address (points to _except_handler3 thunk)
     *   [frame+8]  = scopeTable pointer
     *   [frame+12] = trylevel (current try nesting depth)
     *   [frame+16] = EBP of protected function
     *
     * ScopeTable entry (12 bytes each):
     *   [+0] previousTryLevel (int32, -1 = end)
     *   [+4] filterAddr (0 = __finally, else filter function)
     *   [+8] handlerAddr (except/finally block address)
     */
    function exceptHandler3(ctx: any, mem: Uint8Array, args: number[]): ThunkResult | number {
        const pExcRec = args[0] >>> 0;
        const frameAddr = args[1] >>> 0;
        const pContext = args[2] >>> 0;
        const _pDispCtx = args[3] >>> 0;

        const cpu = getCPU(host.process.v86);
        if (!cpu) {
            Logger.error(LogCategory.SYSTEM, `_except_handler3: cannot get CPU`);
            return 1; // ContinueSearch
        }

        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Read exception flags
        const excFlags = (pExcRec + 4 < mem.length) ? dv.getUint32(pExcRec + 4, true) : 0;
        const EH_UNWINDING = 0x02;
        const EH_EXIT_UNWIND = 0x04;

        if (excFlags & (EH_UNWINDING | EH_EXIT_UNWIND)) {
            // Unwind phase: run __finally blocks, then return ContinueSearch
            _eh3LocalUnwind(dv, mem, frameAddr, -1);
            return 1; // ContinueSearch
        }

        // Read scope table and trylevel from frame
        if (frameAddr + 16 > mem.length) {
            Logger.error(LogCategory.SYSTEM,
                `_except_handler3: frame 0x${frameAddr.toString(16)} out of bounds`);
            return 1;
        }

        const scopeTable = dv.getUint32(frameAddr + 8, true);
        let trylevel = dv.getInt32(frameAddr + 12, true);
        const frameEbp = frameAddr + 16;

        if (scopeTable < 0x1000 || scopeTable + 12 > mem.length) {
            Logger.warn(LogCategory.SYSTEM,
                `_except_handler3: invalid scopeTable=0x${scopeTable.toString(16)} frame=0x${frameAddr.toString(16)}`);
            return 1;
        }

        Logger.log(LogCategory.SYSTEM,
            `_except_handler3: frame=0x${frameAddr.toString(16)} scopeTable=0x${scopeTable.toString(16)} ` +
            `trylevel=${trylevel} EBP=0x${frameEbp.toString(16)}`);

        // Write EXCEPTION_POINTERS below the frame (in dead stack area) for filter access via [EBP-0x14]
        // Layout: EP struct at [frame-12] and [frame-8], pointer at [frame-4] = [EBP-0x14]
        // This avoids overwriting frame+0 (next) and frame+4 (handler) which the old
        // [frameEbp-0x10] / [frameEbp-0x0C] calculation would hit (frameEbp = frame+16).
        const epAddr = (frameAddr - 12) >>> 0;
        if (epAddr >= 4 && frameAddr <= mem.length) {
            dv.setUint32(epAddr, pExcRec, true);                      // EP.ExceptionRecord
            dv.setUint32(epAddr + 4, pContext, true);                  // EP.ContextRecord
            dv.setUint32((frameAddr - 4) >>> 0, epAddr, true);        // [EBP-0x14] = &EP
        }

        // Set EBP for filter access (filters use EBP to access enclosing function's locals)
        cpu.reg32[5] = frameEbp | 0;

        let safety = 0;
        while (trylevel >= 0 && safety < 256) {
            safety++;
            const entryBase = scopeTable + trylevel * 12;
            if (entryBase + 12 > mem.length) break;

            const previousTryLevel = dv.getInt32(entryBase, true);
            const filterAddr = dv.getUint32(entryBase + 4, true);
            const handlerAddr = dv.getUint32(entryBase + 8, true);

            // Skip __finally entries (filterAddr == 0)
            if (filterAddr === 0 || filterAddr + 6 > mem.length) {
                trylevel = previousTryLevel;
                continue;
            }

            // Try static evaluation
            const exceptionCode = (pExcRec !== 0 && pExcRec + 4 <= mem.length)
                ? dv.getUint32(pExcRec, true)
                : 0xC0000005;
            const filterResult = evaluateSimpleFilter(mem, filterAddr, mem.length, exceptionCode);

            if (filterResult === 1) {
                // EXCEPTION_EXECUTE_HANDLER — jump to except block
                Logger.warn(LogCategory.SYSTEM,
                    `_except_handler3: filter at 0x${filterAddr.toString(16)} returned EXECUTE_HANDLER, ` +
                    `jumping to except block at 0x${handlerAddr.toString(16)} (trylevel ${trylevel} → ${previousTryLevel})`);
                return _eh3JumpToExceptBlock(cpu, dv, frameAddr, previousTryLevel, handlerAddr);
            }

            if (filterResult === -1) {
                // EXCEPTION_CONTINUE_EXECUTION
                Logger.warn(LogCategory.SYSTEM,
                    `_except_handler3: filter returned CONTINUE_EXECUTION`);
                return 0; // ContinueExecution (ExceptionContinueExecution = 0)
            }

            if (filterResult === 0) {
                // ContinueSearch at this level, try outer scope
                trylevel = previousTryLevel;
                continue;
            }

            // filterResult === null: complex filter via static THUNK_CODE filter stub
            Logger.warn(LogCategory.SYSTEM,
                `_except_handler3: complex filter at 0x${filterAddr.toString(16)} -> static filter stub`);
            return _eh3PrepareComplexFilterRedirect(
                cpu,
                filterAddr,
                frameAddr,
                previousTryLevel,
                handlerAddr,
                trylevel,
            );
        }

        // No handler found at any trylevel
        return 1; // ContinueSearch
    }

    /**
     * Jump to an except block after a static filter returned EXECUTE_HANDLER.
     * Sets up the stack so the thunk's RET N pops handlerAddr.
     */
    function _eh3JumpToExceptBlock(
        cpu: any, dv: DataView, frameAddr: number,
        prevLevel: number, handlerAddr: number,
    ): ThunkResult {
        // Update trylevel to previous
        dv.setInt32(frameAddr + 12, prevLevel, true);

        // Set EBP to frame+16 (protected function's EBP)
        cpu.reg32[5] = (frameAddr + 16) | 0;

        // _except_handler3 is cdecl with 4 args — thunk cleanup is 0 (caller cleans)
        // Set ESP = frameAddr (Windows _JumpToContinuation contract: ESP = pRN = frame)
        // RET pops handlerAddr from [ESP-4]; but since cleanup=0, adjustedEsp = desiredEsp - 4
        const adjustedEsp = (frameAddr - 4) >>> 0;
        cpu.reg32[4] = adjustedEsp;
        dv.setUint32(adjustedEsp, handlerAddr, true);

        host.process.dispatcher.notifySehDispatchAborted('eh3_execute_handler_fast');
        return { value: 0, skipStackCheck: true };
    }

    function _eh3PrepareComplexFilterRedirect(
        cpu: any,
        filterAddr: number,
        frameAddr: number,
        prevLevel: number,
        handlerAddr: number,
        currentLevel: number,
    ): ThunkResult {
        const ok = host.process.dispatcher.prepareEh3ComplexFilterRedirect(
            cpu,
            frameAddr,
            prevLevel,
            currentLevel,
            filterAddr,
            handlerAddr,
        );
        if (!ok) {
            Logger.error(LogCategory.SYSTEM,
                `_except_handler3: failed to prepare complex filter redirect ` +
                `(filter=0x${filterAddr.toString(16)} frame=0x${frameAddr.toString(16)})`);
            return { value: 1, skipStackCheck: false };
        }
        return { value: 0, skipStackCheck: true };
    }

    /**
     * Simplified local unwind: walk scope table from current trylevel toward targetLevel,
     * running __finally blocks. For now, just logs and updates trylevel (most game code
     * uses __except, not __finally).
     */
    function _eh3LocalUnwind(dv: DataView, mem: Uint8Array, frameAddr: number, targetLevel: number): void {
        if (frameAddr + 16 > mem.length) return;

        const scopeTable = dv.getUint32(frameAddr + 8, true);
        let trylevel = dv.getInt32(frameAddr + 12, true);

        if (scopeTable < 0x1000 || scopeTable + 12 > mem.length) return;

        let safety = 0;
        while (trylevel >= 0 && trylevel !== targetLevel && safety < 256) {
            safety++;
            const entryBase = scopeTable + trylevel * 12;
            if (entryBase + 12 > mem.length) break;

            const previousTryLevel = dv.getInt32(entryBase, true);
            const filterAddr = dv.getUint32(entryBase + 4, true);
            const handlerAddr = dv.getUint32(entryBase + 8, true);

            if (filterAddr === 0 && handlerAddr !== 0) {
                // __finally block — log and skip for now
                Logger.warn(LogCategory.SYSTEM,
                    `_eh3LocalUnwind: skipping __finally at 0x${handlerAddr.toString(16)} ` +
                    `(frame=0x${frameAddr.toString(16)} trylevel=${trylevel})`);
            }

            dv.setInt32(frameAddr + 12, previousTryLevel, true);
            trylevel = previousTryLevel;
        }
    }

    /**
     * __CxxFrameHandler — MSVC C++ frame handler.
     *
     * For hardware exceptions (non-C++ like ACCESS_VIOLATION), this works identically
     * to _except_handler3: walk the scope table, evaluate filters, jump to except blocks.
     * For C++ exceptions (0xe06d7363), the existing dispatchCxxException handles it.
     *
     * The scope table layout is identical for VC6's __CxxFrameHandler — it's just
     * _except_handler3 with additional C++ catch support layered on top.
     */
    function cxxFrameHandler(_ctx: any, mem: Uint8Array, args: number[]): ThunkResult | number {
        const pExcRec = args[0] >>> 0;
        const frameAddr = args[1] >>> 0;

        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const excFlags = (pExcRec + 8 <= mem.length) ? dv.getUint32(pExcRec + 4, true) : 0;

        if (excFlags & (0x02 | 0x04)) {  // EH_UNWINDING | EH_EXIT_UNWIND
            _eh3LocalUnwind(dv, mem, frameAddr, -1);
        }

        // __CxxFrameHandler cannot handle hardware exceptions — only C++ exceptions
        // (0xe06d7363), which are dispatched via _CxxThrowException → dispatchCxxException.
        // C++ frames have FuncInfo at [frame+8], NOT a scope table — delegating to
        // exceptHandler3 would misinterpret it and corrupt the SEH chain.
        return 1; // ContinueSearch
    }

    /**
     * _CxxThrowException - MSVC C++ exception throw.
     * Walks the SEH chain from TEB[0], parses FuncInfo structures,
     * and redirects execution to the matching catch block.
     * Simplified: skips destructors (_local_unwind2).
     */
    function cxxThrowException(ctx: any, mem: Uint8Array, args: number[]): ThunkResult | number {
        const pExceptionObject = args[0] >>> 0;
        const pThrowInfo = args[1] >>> 0;

        // Try to read the exception message.
        // For pointer types like .PAG (const wchar_t*), the object is a 4-byte pointer
        // to the actual string. Try both dereferenced pointer and direct read.
        let exMsg = "(unknown)";
        if (pExceptionObject) {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            // First: dereference as pointer-to-string (covers .PAG = const wchar_t*)
            try {
                const strAddr = dv.getUint32(pExceptionObject, true);
                if (strAddr > 0x1000 && strAddr < mem.length) {
                    const derefWide = Marshaler.readWideString(mem, strAddr);
                    if (derefWide && derefWide.length > 0 && !/[�]/.test(derefWide.slice(0, 8))) {
                        exMsg = derefWide;
                    }
                }
            } catch { /* */ }
            // Fallback: try reading directly at pExceptionObject
            if (exMsg === "(unknown)") {
                try {
                    const direct = Marshaler.readWideString(mem, pExceptionObject);
                    if (direct) exMsg = direct;
                } catch { /* */ }
            }
            if (exMsg === "(unknown)") {
                try {
                    const ansi = Marshaler.readString(mem, pExceptionObject);
                    if (ansi) exMsg = ansi;
                } catch { /* */ }
            }
        }
        Logger.error(LogCategory.SYSTEM,
            `_CxxThrowException: "${exMsg}" pObj=0x${pExceptionObject.toString(16)} pThrow=0x${pThrowInfo.toString(16)}`);

        const cpu = getCPU(host.process.v86);
        if (!cpu) {
            Logger.error(LogCategory.SYSTEM, '_CxxThrowException: cannot get CPU');
            return 0;
        }

        // _CxxThrowException is cdecl(obj, throwInfo): thunk RET 8.
        const result = dispatchCxxException(mem, cpu, pExceptionObject, pThrowInfo, 8);
        if (result && !('deferToX86' in result)) return result;

        if (result) {
            // JS walk met a non-C++ frame (__try/__except) whose filter must run
            // natively. Synthesize the RaiseException parameter array the x86 record
            // is built from (consumed synchronously by setupCxxExceptionX86Dispatch,
            // so a spot just below the live stack is safe).
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const argsPtr = ((ctx.esp >>> 0) - 0x40) & ~3;
            dv.setUint32(argsPtr, 0x19930520, true);
            dv.setUint32(argsPtr + 4, result.pExceptionObject, true);
            dv.setUint32(argsPtr + 8, result.pThrowInfo, true);
            const x86Result = host.process.dispatcher.setupCxxExceptionX86Dispatch(
                cpu, mem, ctx.esp >>> 0, 0xe06d7363, 0x1, 3, argsPtr, 8);
            if (x86Result) return x86Result;
        }

        Logger.error(LogCategory.SYSTEM,
            `_CxxThrowException: NO catch handler found. "${exMsg}"`);
        return host.terminateProcess(0xe06d7363, `_CxxThrowException: unhandled C++ exception`);
    }

    exports["_except_handler3"]    = (ctx, mem, args) => exceptHandler3(ctx, mem, args);
    exports["__CxxFrameHandler"]   = (ctx, mem, args) => cxxFrameHandler(ctx, mem, args);
    exports["_CxxThrowException"]  = (ctx, mem, args) => cxxThrowException(ctx, mem, args);
}

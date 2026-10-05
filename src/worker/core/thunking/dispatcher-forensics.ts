/**
 * Cold-path dispatcher forensics. Runs ONLY on error/diagnostic paths:
 * callback-frame forensics, clean-exit call-stack traces, guest call-stack
 * reconstruction, invalid-return crash reports, and the SEH runtime-dump /
 * corruption-protocol printers. No dispatch tables, no thunk protocol state
 * changes — pure reads + logging + crash funnel.
 *
 * `d` is the live ThunkDispatcher (loose `any` back-ref) — functions read its
 * live memory views / SEH bookkeeping / WinAPI ring through it.
 */
import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { memoryEventBuffer } from '../memory/memory-event-buffer';
import { faultRecorder } from '../memory/fault-recorder';
import {
    SEH_SCRATCH_LAYOUT,
    SEH_FRAME_LIST_MAX,
} from './seh-layout';
import {
    emitSehRuntimeDump,
    makeSehDumpFileStem,
    type SehDumpManifest,
    type SehFrameSnapshot,
} from '../tools/seh-postmortem';

// Mirrors of thunk-dispatcher.ts module-local constants (moved with their sole users).
const SEH_DEFAULT_DUMP_BASE = 0x10924000;
const SEH_DEFAULT_DUMP_END = 0x1092B000;
const KERNEL_SPACE_START = 0x80000000;

export function logCallbackForensics(d: any, reason: string): void {
        try {
            const callbackCoord = System.getInstance().scheduler.callbackCoord;
            const stats = callbackCoord.getStats();
            Logger.error(LogCategory.SYSTEM,
                `[CALLBACK FORENSICS] ${reason} queue: size=${stats.queueSize} ` +
                `enq=${stats.totalEnqueued} dispatched=${stats.totalDispatched} drop=${stats.totalDropped}`);

            if (!d._callbackManager || typeof (d._callbackManager as any).getForensicState !== 'function') {
                return;
            }

            const state = (d._callbackManager as any).getForensicState();
            Logger.error(LogCategory.SYSTEM,
                `[CALLBACK FORENSICS] ${reason} state: pending=${state.pendingCount} thunkCtxDepth=${state.thunkContextDepth}`);
            if (Array.isArray(state.suspendedFrames) && state.suspendedFrames.length > 0) {
                const frames = state.suspendedFrames
                    .slice(0, 8)
                    .map((f: any) =>
                        `#${f.frameId} T${f.threadId} cb=0x${(f.callbackId >>> 0).toString(16)} ` +
                        `esp=0x${(f.espEntry >>> 0).toString(16)} ret=0x${(f.returnAddr >>> 0).toString(16)} ` +
                        `post=0x${(f.expectedPostEsp >>> 0).toString(16)} src=${f.source ?? 'unknown'}`
                    )
                    .join(' | ');
                Logger.error(LogCategory.SYSTEM, `[CALLBACK FORENSICS] ${reason} frames: ${frames}`);
            }

            const formatRecord = (label: string, record: any): void => {
                if (!record) return;
                const args = Array.isArray(record.args) ? record.args.map((v: number) => `0x${(v >>> 0).toString(16)}`).join(',') : '';
                const stackTop = Array.isArray(record.stackTop) ? record.stackTop.map((v: number) => `0x${(v >>> 0).toString(16)}`).join(',') : '';
                Logger.error(LogCategory.SYSTEM,
                    `[CALLBACK FORENSICS] ${label}: id=0x${(record.callbackId >>> 0).toString(16)} ` +
                    `src=${record.source ?? 'unknown'} cb=0x${(record.callbackAddress >>> 0).toString(16)} ` +
                    `stub=0x${(record.stubAddress >>> 0).toString(16)} esp=0x${(record.esp >>> 0).toString(16)} ` +
                    `cleanup=${record.callerCleanup ?? 0} args=[${args}]`);
                if (record.phase === 'invoke') {
                    Logger.error(LogCategory.SYSTEM,
                        `[CALLBACK FORENSICS] ${label}: espBefore=0x${((record.espBeforeInvoke ?? 0) >>> 0).toString(16)} ` +
                        `espAfter=0x${((record.espAfterSetup ?? 0) >>> 0).toString(16)} stackTop=[${stackTop}]`);
                } else {
                    Logger.error(LogCategory.SYSTEM,
                        `[CALLBACK FORENSICS] ${label}: ret=0x${((record.returnValue ?? 0) >>> 0).toString(16)} ` +
                        `callerRet=0x${((record.callerRet ?? 0) >>> 0).toString(16)} ` +
                        `driftStd=${record.driftStdcall ?? 'n/a'} driftCdecl=${record.driftCdecl ?? 'n/a'} ` +
                        `cc=${record.callingConvention ?? 'unknown'} stackTop=[${stackTop}]`);
                }
            };

            formatRecord('lastInvoke', state.lastInvoke);
            formatRecord('lastReturn', state.lastReturn);
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `[CALLBACK FORENSICS] ${reason} dump failed: ${error}`);
        }
}

/**
 * A guest that catches its own AV and calls exit(0) leaves an exit trace that reads
 * exactly like a clean quit. Replay the fault it descended from so the tail can never
 * be mistaken for a normal shutdown again.
 */
function dumpPrecedingFault(): void {
        const rec = faultRecorder.last();
        if (!rec) return;
        const ageMs = performance.now() - rec.ts;
        if (ageMs > 10_000) return;
        Logger.error(LogCategory.SYSTEM,
            `[EXIT-TRACE] PRECEDED BY FAULT ${ageMs.toFixed(0)}ms earlier: ` +
            `${(rec.errorCode & 2) ? 'write' : 'read'} to 0x${rec.faultAddr.toString(16)} ` +
            `at EIP=0x${rec.eip.toString(16)}${rec.eipTrusted === false ? ' (EIP UNRELIABLE — does not address CR2)' : ''} ` +
            `T${rec.threadId ?? '?'} lastThunk=${rec.lastThunk}` +
            `${rec.outcome ? ` → ${rec.outcome}` : ''}`);
        if (rec.cr2Candidates?.length) {
            Logger.error(LogCategory.SYSTEM, `[EXIT-TRACE]   CR2 = ${rec.cr2Candidates.join(' | ')}`);
        }
        if (rec.badCall) {
            Logger.error(LogCategory.SYSTEM,
                `[EXIT-TRACE]   bad indirect call ${rec.badCall.operand} at 0x${rec.badCall.callSite.toString(16)} ` +
                `→ target 0x${rec.badCall.slotValue.toString(16)} from slot 0x${rec.badCall.slotAddr.toString(16)}`);
        }
}

export function dumpExitCallStack(d: any, reason: string, esp?: number): void {
        try {
            const bt = d.getGuestCallStack(esp);
            Logger.error(LogCategory.SYSTEM,
                `[EXIT-TRACE] ${reason} lastThunk=${bt.lastThunk || 'none'} thunkCount=${d.thunkCount} esp=0x${bt.esp.toString(16)}`);
            dumpPrecedingFault();
            if (bt.recent.length) {
                Logger.error(LogCategory.SYSTEM, `[EXIT-TRACE] recent WinAPI: ${bt.recent.join(' | ')}`);
            }
            if (bt.frames.length) {
                for (const f of bt.frames) {
                    Logger.error(LogCategory.SYSTEM,
                        `[EXIT-TRACE]   #${f.index} [esp+0x${f.stackOffset.toString(16)}] 0x${f.retAddr.toString(16)} ` +
                        `${f.moduleName ? `(${f.moduleName}+0x${f.moduleOffset.toString(16)})` : '(unknown)'}${f.isThunk ? ' «thunk»' : ''}`);
                }
            } else {
                Logger.error(LogCategory.SYSTEM, `[EXIT-TRACE]   (no module-resolvable frames in stack window)`);
            }
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[EXIT-TRACE] ${reason} dump failed: ${e}`);
        }
}

function shouldCaptureSehRuntimeDump(force: boolean = false): boolean {
        if (force) return true;
        const globalToggle = (globalThis as any)?.__BS_SEH_DUMP__;
        if (typeof globalToggle === 'boolean') return globalToggle;
        return !!(import.meta as any)?.env?.DEV;
}

function collectSehFramesFromHead(d: any, view: DataView, sehHead: number): SehFrameSnapshot[] {
        const frames: SehFrameSnapshot[] = [];
        let walkHead = sehHead >>> 0;
        let frameCount = 0;
        while (walkHead !== 0xFFFFFFFF && walkHead !== 0 && frameCount < SEH_FRAME_LIST_MAX) {
            if (walkHead + 16 > d.memLength) break;
            const next = view.getUint32(walkHead, true) >>> 0;
            const handler = view.getUint32(walkHead + 4, true) >>> 0;
            const scopeTable = view.getUint32(walkHead + 8, true) >>> 0;
            const trylevel = view.getInt32(walkHead + 12, true);
            frames.push({
                addr: walkHead,
                handler,
                scopeTable,
                trylevel,
            });
            walkHead = next;
            frameCount++;
        }
        return frames;
}

export function collectSehFramesFromScratch(d: any, view: DataView): SehFrameSnapshot[] {
        if (!d.sehScratchAddr) return [];
        const frames: SehFrameSnapshot[] = [];
        let listAddr = d.sehScratchAddr + SEH_SCRATCH_LAYOUT.FRAME_LIST;
        for (let i = 0; i < SEH_FRAME_LIST_MAX; i++) {
            if (listAddr + 4 > d.memLength) break;
            const frameAddr = view.getUint32(listAddr, true) >>> 0;
            if (frameAddr === 0xFFFFFFFF || frameAddr === 0) break;
            if (frameAddr + 16 > d.memLength) break;
            frames.push({
                addr: frameAddr,
                handler: view.getUint32(frameAddr + 4, true) >>> 0,
                scopeTable: view.getUint32(frameAddr + 8, true) >>> 0,
                trylevel: view.getInt32(frameAddr + 12, true),
            });
            listAddr += 4;
        }
        return frames;
}

function computeSehDumpWindow(d: any, addresses: number[]): { base: number; endExclusive: number } {
        if (!d.cachedMem8 || d.cachedMem8.length === 0) {
            return { base: SEH_DEFAULT_DUMP_BASE, endExclusive: SEH_DEFAULT_DUMP_END };
        }
        const memLimit = d.cachedMem8.length >>> 0;
        const filtered = addresses.filter((v) => v >= 0x10000 && v < memLimit);
        if (filtered.length === 0) {
            return {
                base: Math.max(0, Math.min(SEH_DEFAULT_DUMP_BASE, memLimit - 1)),
                endExclusive: Math.max(1, Math.min(SEH_DEFAULT_DUMP_END, memLimit)),
            };
        }

        const pageMask = ~0xFFF;
        const minAddr = Math.min(...filtered) >>> 0;
        const maxAddr = Math.max(...filtered) >>> 0;
        let base = (minAddr & pageMask) >>> 0;
        let endExclusive = ((maxAddr + 0x1000) & pageMask) >>> 0;
        if (endExclusive <= base) {
            endExclusive = (base + 0x1000) >>> 0;
        }
        const maxWindow = 0x10000;
        if ((endExclusive - base) > maxWindow) {
            base = (minAddr & pageMask) >>> 0;
            endExclusive = (base + maxWindow) >>> 0;
        }
        base = Math.min(base, memLimit - 1);
        endExclusive = Math.min(Math.max(endExclusive, base + 1), memLimit);
        return { base, endExclusive };
}

export function captureSehRuntimeDump(
    d: any,
    reason: string,
    details: {
        faultAddr?: number;
        faultEip?: number;
        sehHead?: number;
        filterAddr?: number;
        handlerAddr?: number;
        frameList?: SehFrameSnapshot[];
        force?: boolean;
    } = {},
): void {
        if (!shouldCaptureSehRuntimeDump(details.force === true)) {
            return;
        }
        if (!d.cachedMem8 || !d.cachedDataView || !d.isDataViewValid()) {
            return;
        }

        const cpu = d.cachedCpu || (d.v86.cpu || (d.v86.v86 && d.v86.v86.cpu));
        if (!cpu) return;
        const regs = cpu.reg32;
        const eip = (cpu.instruction_pointer?.[0] ?? 0) >>> 0;
        const esp = (regs?.[4] ?? 0) >>> 0;
        const ebp = (regs?.[5] ?? 0) >>> 0;
        const tebAddr = (cpu.segment_offsets?.[5] ?? 0) >>> 0;
        let sehHead = details.sehHead ?? 0;
        if (!sehHead && tebAddr + 4 <= d.memLength) {
            sehHead = d.cachedDataView.getUint32(tebAddr, true) >>> 0;
        }

        const frameList = details.frameList ??
            (sehHead ? collectSehFramesFromHead(d, d.cachedDataView, sehHead) : collectSehFramesFromScratch(d, d.cachedDataView));

        const candidateAddresses: number[] = [
            details.faultEip ?? eip,
            details.filterAddr ?? 0,
            details.handlerAddr ?? 0,
            ...frameList.map((f) => f.addr),
            ...frameList.map((f) => f.handler),
            ...frameList.map((f) => f.scopeTable ?? 0),
        ];
        const { base, endExclusive } = computeSehDumpWindow(d, candidateAddresses);
        const bytes = d.cachedMem8.slice(base, endExclusive);
        const fileStem = makeSehDumpFileStem(d.sehDispatchGeneration, reason);

        const manifest: SehDumpManifest = {
            timestampIso: new Date().toISOString(),
            generation: d.sehDispatchGeneration >>> 0,
            reason,
            eip,
            esp,
            ebp,
            sehHead: sehHead >>> 0,
            faultAddr: (details.faultAddr ?? 0) >>> 0,
            faultEip: (details.faultEip ?? eip) >>> 0,
            filterAddr: (details.filterAddr ?? 0) >>> 0,
            handlerAddr: (details.handlerAddr ?? 0) >>> 0,
            frameList,
            dumpRange: {
                base: base >>> 0,
                end: (endExclusive - 1) >>> 0,
            },
        };

        const ok = emitSehRuntimeDump({
            fileStem,
            manifest,
            bytes: bytes.buffer,
            baseAddress: base >>> 0,
            endAddress: (endExclusive - 1) >>> 0,
        });

        Logger.warn(LogCategory.SYSTEM,
            `SEH runtime dump ${ok ? 'emitted' : 'skipped'}: ` +
            `${fileStem} range=0x${base.toString(16)}..0x${(endExclusive - 1).toString(16)} ` +
            `frames=${frameList.length}`);
}

export function logSehCorruptionProtocol(d: any, reason: string, faultingEip: number, faultAddr: number): void {
        Logger.error(LogCategory.SYSTEM,
            `[SEH CORRUPTION] ${reason}: faultEIP=0x${faultingEip.toString(16)} faultAddr=0x${faultAddr.toString(16)}`);
        const sched = d.ensureScheduler();
        const rt = sched.getCriticalRuntimeSnapshot();
        Logger.error(LogCategory.SYSTEM,
            `[SEH CORRUPTION] runtime: active=${rt.active ? 1 : 0} section=${rt.section ?? 'none'} ` +
            `owner=T${rt.ownerThreadId} gen=${rt.generation} deferred=${rt.deferredSwitchCount} ` +
            `restoreDenied=${rt.deniedRestoreCount} unbalanced=${rt.unbalancedExitCount}`);
        Logger.error(LogCategory.SYSTEM,
            `[SEH CORRUPTION] transient ranges: dispatch=0x${d.sehDispatchStubAddress.toString(16)}..0x${(d.sehDispatchStubAddress + 0x100).toString(16)} ` +
            `filter=0x${d.sehFilterStubAddress.toString(16)}..0x${(d.sehFilterStubAddress + 0x100).toString(16)} ` +
            `stack=0x${(d.sehStackBase - 0x100 >>> 0).toString(16)}..0x${d.sehStackTop.toString(16)}`);

        const recentCalls = d.getLastWinApiCalls(64, { includeNoisy: true });
        if (recentCalls.length > 0) {
            Logger.error(LogCategory.SYSTEM, `[SEH CORRUPTION] recent thunks: ${recentCalls.join(' | ')}`);
        }

        memoryEventBuffer.dump();
        System.getInstance().process?.addressSpace.logMap();

        if (d.cachedDataView && d.isDataViewValid()) {
            const frames = collectSehFramesFromScratch(d, d.cachedDataView);
            for (let i = 0; i < frames.length; i++) {
                const f = frames[i];
                Logger.error(LogCategory.SYSTEM,
                    `[SEH CORRUPTION] frame[${i}] addr=0x${f.addr.toString(16)} ` +
                    `handler=0x${f.handler.toString(16)} scope=0x${(f.scopeTable ?? 0).toString(16)} ` +
                    `trylevel=${f.trylevel ?? 0}`);
            }
            captureSehRuntimeDump(d, `corruption-${reason}`, {
                faultAddr,
                faultEip: faultingEip,
                frameList: frames,
                force: true,
            });
        }

        d.dumpCriticalForensics(`seh_${reason}`);
}

export function reportInvalidReturnCrash(d: any, name: string, esp: number, retAddr: number, cpu: any, phase: string): void {
        const eip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
        const regs = cpu?.reg32 ? {
            ecx: cpu.reg32[1] >>> 0, ebx: cpu.reg32[3] >>> 0, esp: cpu.reg32[4] >>> 0,
            ebp: cpu.reg32[5] >>> 0, esi: cpu.reg32[6] >>> 0, edi: cpu.reg32[7] >>> 0,
        } : null;

        // 32 stack words from ESP — the corrupt return-address chain leading here.
        const stackDump: number[] = [];
        if (d.cachedDataView && d.isDataViewValid()) {
            for (let i = 0; i < 32; i++) {
                const a = esp + i * 4;
                if (a + 4 > d.memLength) break;
                stackDump.push(d.cachedDataView.getUint32(a, true) >>> 0);
            }
        }

        let recentCalls: string[] = [];
        try { recentCalls = d.getLastWinApiCalls(48, { includeNoisy: true }); } catch { /* */ }

        let threadId: number | null = null;
        try { threadId = System.getInstance().scheduler?.getCurrentThreadId?.() ?? null; } catch { /* */ }

        System.getInstance().reportGuestCrash({
            reason: `Invalid return address (thunk stack desync, ${phase})`,
            eip,
            threadId,
            fault: { faultAddr: retAddr, lastThunk: name, regs, recentCalls, gameEsp: esp >>> 0, stackDump },
        });
}

export function reconstructCallStack(
    d: any,
    esp: number,
    mem8: Uint8Array,
    view: DataView,
    maxScanBytes: number = 256,
    maxFrames: number = 32
): Array<{
    stackOffset: number;
    retAddr: number;
    moduleName: string | null;
    moduleOffset: number;
    isThunk: boolean;
}> {
        const callStack = [];
        const moduleRegistry = System.getInstance().process?.moduleRegistry;
        const MAX_SCAN = maxScanBytes; // Scan up to maxScanBytes (maxScanBytes/4 stack slots)

        // NOTE: do NOT cap by a fixed low STACK_REGION_END (0x100000) — guest thread
        // stacks live high (the main thread's is ~0x10fff08), so that cap aborted the
        // scan on the first slot and returned an empty stack (broke this for every
        // thread with a stack above 1MB, fault path included). The scan window
        // (MAX_SCAN) + the mem8.length bound are the real guards.
        for (let offset = 0; offset < MAX_SCAN; offset += 4) {
            const addr = esp + offset;
            if (addr + 4 > mem8.length) break;

            const value = view.getUint32(addr, true) >>> 0;

            // Skip obviously invalid addresses
            if (value === 0 || value === 0xFFFFFFFF) continue;
            if (value < 0x10000) continue; // Too low
            if (value >= KERNEL_SPACE_START) continue; // Kernel space

            // Check if this looks like a return address
            let isLikelyRetAddr = false;
            let moduleName: string | null = null;
            let moduleOffset = 0;
            let isThunk = false;

            // Check if in thunk region
            if (d.thunkGeneratorBase !== 0 &&
                value >= d.thunkGeneratorBase &&
                value < d.thunkGeneratorEnd) {
                isLikelyRetAddr = true;
                isThunk = true;
                moduleName = "THUNK_CODE";
                moduleOffset = value - d.thunkGeneratorBase;
            }
            // Check if in callback stub region
            else if (d.callbackStubPoolBase !== 0 &&
                value >= d.callbackStubPoolBase &&
                value < d.callbackStubPoolEnd) {
                isLikelyRetAddr = true;
                moduleName = "CALLBACK_STUB";
                moduleOffset = value - d.callbackStubPoolBase;
            }
            // Check if in any registered module (EXE or DLL)
            else if (moduleRegistry) {
                const mod = moduleRegistry.getModuleContainingAddress(value);
                if (mod) {
                    isLikelyRetAddr = true;
                    moduleName = mod.name;
                    moduleOffset = value - mod.baseAddress;
                }
            }

            // If looks like return address, add to stack
            if (isLikelyRetAddr) {
                callStack.push({
                    stackOffset: offset,
                    retAddr: value,
                    moduleName,
                    moduleOffset,
                    isThunk
                });

                // Limit to maxFrames frames
                if (callStack.length >= maxFrames) break;
            }
        }

        return callStack;
}

/**
 * Vista+ kernel32 thread / process / system queries that modern runtimes (the VS2015+
 * UCRT and msvcp140 winapi thunks, SDL, engines) resolve through GetProcAddress.
 *
 * The machine they describe is the one the rest of kernel32 reports: one processor in one
 * group (GetSystemInfo, GetProcessAffinityMask), no XSAVE (CPUID.1:ECX[26] is clear), a
 * desktop process with no package and no mitigations it did not ask for.
 */

import { ThunkImplementation, X86Context } from '../../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../../core/logger';
import { System } from '../../../core/system';
import { Mem } from '../../../core/memory/mem-accessor';
import { EmulatorConfig } from '../../../core/emulator-config-manager';
import { cpuViews } from '../../../core/cpu/cpu-views';
import { getCPU } from '../../../core/thunking/thunk-utils';
import { getVirtualProcessManager, VIRTUAL_CURRENT_PROCESS_ID } from './virtual-process-manager';
import { shutdownProcess } from './process';
import { exports as memoryExports } from '../memory';
import { resolveDosDeviceTarget } from '../file-io-volume';

const S_OK = 0;
const E_POINTER = 0x80004003;
const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOACCESS = 998;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** HRESULT_FROM_NT: what the HRESULT-returning wrappers of Nt* calls answer with. */
const hresultFromNt = (status: number): number => (status | 0x10000000) >>> 0;
const STATUS_INVALID_HANDLE = 0xC0000008;
const STATUS_INVALID_PARAMETER = 0xC000000D;
const STATUS_NO_MEMORY = 0xC0000017;
const STATUS_FAIL_FAST_EXCEPTION = 0xC0000602;

const CURRENT_PROCESS_PSEUDO_HANDLE = 0xFFFFFFFF;
const PROCESSOR_COUNT = 1;
const ACTIVE_PROCESSOR_MASK = 0x1;

/** Return a 64-bit value the way the ABI does: low half in EAX, high half in EDX. */
function return64(value: bigint): number {
    const cpu = getCPU(System.getInstance().process?.v86);
    if (cpu) cpuViews(cpu).reg32[2] = Number((value >> 32n) & 0xffffffffn) | 0;
    return Number(value & 0xffffffffn) >>> 0;
}

/** The thread a handle names, in this process or a virtual child; null when none. */
function threadIdOf(handle: number): number | null {
    return System.getInstance().scheduler.getThreadIdByHandle(handle)
        ?? getVirtualProcessManager().getThreadIdByHandle(handle);
}

/** A process handle as the process it names; null when it names none. */
function processOf(handle: number): { pid: number; imagePath: string } | null {
    const system = System.getInstance();
    if ((handle >>> 0) === CURRENT_PROCESS_PSEUDO_HANDLE) {
        return { pid: VIRTUAL_CURRENT_PROCESS_ID, imagePath: system.executablePath };
    }
    const p = getVirtualProcessManager().describeProcessHandle(handle);
    if (!p) return null;
    if (p.pid === VIRTUAL_CURRENT_PROCESS_ID) return { pid: p.pid, imagePath: system.executablePath };
    return { pid: p.pid, imagePath: childImagePath(p.commandLine, p.imageName, p.currentDirectory) };
}

/** A child's image as its command line names it, made absolute against its directory. */
function childImagePath(commandLine: string, imageName: string, currentDirectory: string): string {
    const line = commandLine.trim();
    let token = line.startsWith('"') ? line.slice(1, Math.max(1, line.indexOf('"', 1))) : line.split(' ')[0];
    if (!token) token = imageName;
    token = token.replace(/\//g, '\\');
    if (/^[A-Za-z]:\\/.test(token)) return token;
    const parentDir = System.getInstance().executablePath.replace(/\\[^\\]*$/, '');
    const base = (currentDirectory || parentDir).replace(/\\+$/, '');
    return `${base}\\${token}`;
}

function readWideString(addr: number, maxChars: number): string | null {
    let s = '';
    for (let i = 0; i < maxChars; i++) {
        const c = Mem.readUint16(addr + i * 2);
        if (c === null) return null;
        if (c === 0) return s;
        s += String.fromCharCode(c);
    }
    return s;
}

function writeWideString(addr: number, s: string): boolean {
    const bytes = new Uint8Array(s.length * 2 + 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
    return Mem.writeBytes(addr, bytes) === bytes.length;
}

// ─── Per-thread state ────────────────────────────────────────────────────────────

const threadDescriptions = new Map<number, string>();
const threadErrorModes = new Map<number, number>();
const threadStackGuarantees = new Map<number, number>();

// ─── Mitigation policies ─────────────────────────────────────────────────────────

const PROCESS_DEP_POLICY = 0;
const PROCESS_MITIGATION_OPTIONS_MASK = 5;
const MAX_PROCESS_MITIGATION_POLICY = 19;
/** Flags (and, for DEP, the Permanent byte) the process has turned on. */
const mitigationFlags = new Map<number, number>();
let depPermanent = 0;

function mitigationPolicySize(policy: number, requested: number): number {
    if (policy === PROCESS_DEP_POLICY) return 8;
    if (policy === PROCESS_MITIGATION_OPTIONS_MASK) return requested === 16 ? 16 : 8;
    return 4;
}

// ─── Fail-fast / WER ─────────────────────────────────────────────────────────────

const werRuntimeExceptionModules: Array<{ dll: string; context: number }> = [];
const WER_MAX_REGISTERED_RUNTIME_EXCEPTION_MODULES = 16;

export function resetVistaSystemState(): void {
    threadDescriptions.clear();
    threadErrorModes.clear();
    threadStackGuarantees.clear();
    mitigationFlags.clear();
    depPermanent = 0;
    werRuntimeExceptionModules.length = 0;
}

// ─── SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX (x86 layout) ──────────────────────

const RELATION_PROCESSOR_CORE = 0;
const RELATION_NUMA_NODE = 1;
const RELATION_CACHE = 2;
const RELATION_PROCESSOR_PACKAGE = 3;
const RELATION_GROUP = 4;
const RELATION_NUMA_NODE_EX = 6;
const RELATION_ALL = 0xFFFF;

/** Header (Relationship, Size) + the relationship record. */
const SLPI_HEADER = 8;
/** PROCESSOR_RELATIONSHIP: Flags, EfficiencyClass, Reserved[20], GroupCount, GROUP_AFFINITY[1]. */
const PROCESSOR_RELATIONSHIP_SIZE = 36;
/** NUMA_NODE_RELATIONSHIP: NodeNumber, Reserved[18], GroupCount, GROUP_AFFINITY. */
const NUMA_NODE_RELATIONSHIP_SIZE = 36;
/** GROUP_RELATIONSHIP: MaximumGroupCount, ActiveGroupCount, Reserved[20], PROCESSOR_GROUP_INFO[1]. */
const GROUP_RELATIONSHIP_SIZE = 68;

function buildProcessorRecords(relationship: number): Uint8Array {
    const records: Uint8Array[] = [];
    const add = (rel: number, bodySize: number, fill: (v: DataView, at: number) => void) => {
        const rec = new Uint8Array(SLPI_HEADER + bodySize);
        const v = new DataView(rec.buffer);
        v.setUint32(0, rel, true);
        v.setUint32(4, rec.length, true);
        fill(v, SLPI_HEADER);
        records.push(rec);
    };
    const groupAffinity = (v: DataView, at: number) => {
        v.setUint32(at, ACTIVE_PROCESSOR_MASK, true); // Mask
        v.setUint16(at + 4, 0, true);                 // Group
    };
    const wants = (rel: number) => relationship === RELATION_ALL || relationship === rel;

    for (const rel of [RELATION_PROCESSOR_CORE, RELATION_PROCESSOR_PACKAGE]) {
        if (!wants(rel)) continue;
        add(rel, PROCESSOR_RELATIONSHIP_SIZE, (v, at) => {
            v.setUint16(at + 22, 1, true);            // GroupCount
            groupAffinity(v, at + 24);
        });
    }
    if (wants(RELATION_NUMA_NODE) || relationship === RELATION_NUMA_NODE_EX) {
        add(RELATION_NUMA_NODE, NUMA_NODE_RELATIONSHIP_SIZE, (v, at) => {
            v.setUint32(at, 0, true);                 // NodeNumber
            v.setUint16(at + 22, 1, true);            // GroupCount
            groupAffinity(v, at + 24);
        });
    }
    if (wants(RELATION_GROUP)) {
        add(RELATION_GROUP, GROUP_RELATIONSHIP_SIZE, (v, at) => {
            v.setUint16(at, 1, true);                 // MaximumGroupCount
            v.setUint16(at + 2, 1, true);             // ActiveGroupCount
            v.setUint8(at + 24, PROCESSOR_COUNT);     // MaximumProcessorCount
            v.setUint8(at + 25, PROCESSOR_COUNT);     // ActiveProcessorCount
            v.setUint32(at + 64, ACTIVE_PROCESSOR_MASK, true); // ActiveProcessorMask
        });
    }

    const out = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of records) { out.set(r, at); at += r.length; }
    return out;
}

// ─── CONTEXT / XSTATE (x86) ──────────────────────────────────────────────────────

const CONTEXT_I386 = 0x00010000;
const CONTEXT_EXTENDED_REGISTERS = CONTEXT_I386 | 0x20;
const CONTEXT_XSTATE = CONTEXT_I386 | 0x40;
const CONTEXT_EXTENDED_REGISTERS_OFFSET = 0xCC;
const CONTEXT_SIZE = 0x2CC;
/** CONTEXT_EX.XState.Offset, relative to the CONTEXT_EX that follows the CONTEXT. */
const CONTEXT_EX_XSTATE_OFFSET = 16;
const XSAVE_XMM_OFFSET = 0xA0;
const XSTATE_MASK_LEGACY = 3n;
/** KUSER_SHARED_DATA.XState.EnabledFeatures: nothing — the CPU we expose has no XSAVE. */
const ENABLED_XSTATE_FEATURES = 0n;

/**
 * LONG AppPolicyGet*(HANDLE processToken, AppPolicy* policy): the policy of a desktop,
 * unpackaged process, which is the only kind there is here.
 */
export function appPolicyExport(value: number): ThunkImplementation {
    return (_ctx, _mem, args) => {
        const out = args[1] >>> 0;
        if (!out || !Mem.writeUint32(out, value)) return { value: ERROR_INVALID_PARAMETER, stackCleanup: 8 };
        return { value: ERROR_SUCCESS, stackCleanup: 8 };
    };
}

function initVistaSystem(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // HRESULT SetThreadDescription(HANDLE hThread, PCWSTR lpThreadDescription)
    exports['SetThreadDescription'] = (_ctx, _mem, args) => {
        const tid = threadIdOf(args[0] >>> 0);
        if (tid === null) return { value: hresultFromNt(STATUS_INVALID_HANDLE), stackCleanup: 8 };
        const ptr = args[1] >>> 0;
        // The name is a UNICODE_STRING, so its byte length must fit a USHORT.
        const text = ptr ? readWideString(ptr, 0x8000) : '';
        if (text === null || text.length * 2 > 0xFFFF) {
            return { value: hresultFromNt(STATUS_INVALID_PARAMETER), stackCleanup: 8 };
        }
        threadDescriptions.set(tid, text);
        return { value: S_OK, stackCleanup: 8 };
    };

    // HRESULT GetThreadDescription(HANDLE hThread, PWSTR *ppszThreadDescription)
    // The string is LocalAlloc'd; the caller LocalFrees it. A thread never named yields "".
    exports['GetThreadDescription'] = (ctx, mem, args) => {
        const out = args[1] >>> 0;
        if (!out || !Mem.writeUint32(out, 0)) return { value: E_POINTER, stackCleanup: 8 };
        const tid = threadIdOf(args[0] >>> 0);
        if (tid === null) return { value: hresultFromNt(STATUS_INVALID_HANDLE), stackCleanup: 8 };
        const text = threadDescriptions.get(tid) ?? '';
        const buffer = memoryExports['LocalAlloc'](ctx, mem, [0, text.length * 2 + 2]) as number;
        if (!buffer || !writeWideString(buffer, text)) {
            return { value: hresultFromNt(STATUS_NO_MEMORY), stackCleanup: 8 };
        }
        Mem.writeUint32(out, buffer >>> 0);
        return { value: S_OK, stackCleanup: 8 };
    };

    // BOOL SetThreadStackGuarantee(PULONG StackSizeInBytes)
    // Reports the previous guarantee; only ever grows, and must leave room in the stack.
    exports['SetThreadStackGuarantee'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const sched = System.getInstance().scheduler;
        const requested = ptr ? Mem.readUint32(ptr) : null;
        if (requested === null) {
            sched.setLastError(ERROR_NOACCESS);
            return { value: 0, stackCleanup: 4 };
        }
        const tid = sched.getCurrentThreadId();
        const previous = threadStackGuarantees.get(tid) ?? 0;
        const wanted = Math.ceil(requested / 4096) * 4096;
        Mem.writeUint32(ptr, previous);
        const bounds = sched.getThreadStackBounds(tid);
        if (bounds && wanted >= bounds.top - bounds.base) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 4 };
        }
        if (wanted > previous) threadStackGuarantees.set(tid, wanted);
        return { value: 1, stackCleanup: 4 };
    };

    const SEM_FAILCRITICALERRORS = 0x0001;
    const SEM_NOGPFAULTERRORBOX = 0x0002;
    const SEM_NOOPENFILEERRORBOX = 0x8000;
    const THREAD_ERROR_MODE_BITS = SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX;

    // BOOL SetThreadErrorMode(DWORD dwNewMode, LPDWORD lpOldMode)
    exports['SetThreadErrorMode'] = (_ctx, _mem, args) => {
        const mode = args[0] >>> 0;
        const lpOld = args[1] >>> 0;
        const sched = System.getInstance().scheduler;
        if (mode & ~THREAD_ERROR_MODE_BITS) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 8 };
        }
        const tid = sched.getCurrentThreadId();
        if (lpOld) Mem.writeUint32(lpOld, threadErrorModes.get(tid) ?? 0);
        threadErrorModes.set(tid, mode);
        return { value: 1, stackCleanup: 8 };
    };

    // DWORD GetThreadErrorMode(void)
    exports['GetThreadErrorMode'] = () =>
        threadErrorModes.get(System.getInstance().scheduler.getCurrentThreadId()) ?? 0;

    // BOOL SetThreadGroupAffinity(HANDLE, const GROUP_AFFINITY *GroupAffinity, PGROUP_AFFINITY Previous)
    // GROUP_AFFINITY is { KAFFINITY Mask; WORD Group; WORD Reserved[3]; } — 12 bytes on x86.
    exports['SetThreadGroupAffinity'] = (_ctx, _mem, args) => {
        const sched = System.getInstance().scheduler;
        const next = args[1] >>> 0;
        const previous = args[2] >>> 0;
        if (threadIdOf(args[0] >>> 0) === null) {
            sched.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 12 };
        }
        if (previous) {
            const prev = new Uint8Array(12);
            new DataView(prev.buffer).setUint32(0, ACTIVE_PROCESSOR_MASK, true);
            if (Mem.writeBytes(previous, prev) !== prev.length) {
                sched.setLastError(ERROR_NOACCESS);
                return { value: 0, stackCleanup: 12 };
            }
        }
        const req = next ? Mem.readBytes(next, 12) : null;
        if (!req) {
            sched.setLastError(ERROR_NOACCESS);
            return { value: 0, stackCleanup: 12 };
        }
        const v = new DataView(req.buffer, req.byteOffset, req.byteLength);
        const mask = v.getUint32(0, true);
        const reserved = v.getUint16(6, true) | v.getUint16(8, true) | v.getUint16(10, true);
        if (v.getUint16(4, true) !== 0 || reserved !== 0 || mask === 0 || (mask & ~ACTIVE_PROCESSOR_MASK) !== 0) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 };
        }
        return { value: 1, stackCleanup: 12 };
    };

    // DWORD GetActiveProcessorCount(WORD GroupNumber) — ALL_PROCESSOR_GROUPS is 0xFFFF.
    exports['GetActiveProcessorCount'] = (_ctx, _mem, args) => {
        const group = args[0] & 0xFFFF;
        if (group === 0 || group === 0xFFFF) return { value: PROCESSOR_COUNT, stackCleanup: 4 };
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return { value: 0, stackCleanup: 4 };
    };

    // BOOL GetLogicalProcessorInformationEx(LOGICAL_PROCESSOR_RELATIONSHIP, PSLPI_EX Buffer, PDWORD ReturnedLength)
    exports['GetLogicalProcessorInformationEx'] = (_ctx, _mem, args) => {
        const relationship = args[0] >>> 0;
        const buffer = args[1] >>> 0;
        const lengthPtr = args[2] >>> 0;
        const sched = System.getInstance().scheduler;
        const known = relationship === RELATION_ALL || relationship <= RELATION_GROUP || relationship === RELATION_NUMA_NODE_EX;
        const capacity = lengthPtr ? Mem.readUint32(lengthPtr) : null;
        if (!known || capacity === null) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 };
        }
        const records = relationship === RELATION_CACHE ? new Uint8Array(0) : buildProcessorRecords(relationship);
        Mem.writeUint32(lengthPtr, records.length);
        if (capacity < records.length || (records.length > 0 && !buffer)) {
            sched.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return { value: 0, stackCleanup: 12 };
        }
        if (records.length > 0 && Mem.writeBytes(buffer, records) !== records.length) {
            sched.setLastError(ERROR_NOACCESS);
            return { value: 0, stackCleanup: 12 };
        }
        return { value: 1, stackCleanup: 12 };
    };

    // BOOL GetPhysicallyInstalledSystemMemory(PULONGLONG TotalMemoryInKilobytes)
    // The same RAM GlobalMemoryStatusEx reports as ullTotalPhys.
    exports['GetPhysicallyInstalledSystemMemory'] = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0;
        const total = System.getInstance().process?.getCurrentMemory().length ?? 0;
        if (!ptr || !Mem.writeUint32(ptr, Math.floor(total / 1024) >>> 0) || !Mem.writeUint32(ptr + 4, 0)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 4 };
        }
        return { value: 1, stackCleanup: 4 };
    };

    // DWORD64 GetEnabledXStateFeatures(void)
    exports['GetEnabledXStateFeatures'] = () => return64(ENABLED_XSTATE_FEATURES);

    // BOOL GetXStateFeaturesMask(PCONTEXT Context, PDWORD64 FeatureMask)
    exports['GetXStateFeaturesMask'] = (_ctx, _mem, args) => {
        const context = args[0] >>> 0;
        const out = args[1] >>> 0;
        const flags = Mem.readUint32(context) ?? 0;
        if (!(flags & CONTEXT_I386)) return { value: 0, stackCleanup: 8 };
        let mask = (flags & CONTEXT_EXTENDED_REGISTERS) === CONTEXT_EXTENDED_REGISTERS ? XSTATE_MASK_LEGACY : 0n;
        if ((flags & CONTEXT_XSTATE) === CONTEXT_XSTATE) {
            const contextEx = context + CONTEXT_SIZE;
            const header = (contextEx + (Mem.readInt32(contextEx + CONTEXT_EX_XSTATE_OFFSET) ?? 0)) >>> 0;
            const lo = Mem.readUint32(header) ?? 0;
            const hi = Mem.readUint32(header + 4) ?? 0;
            mask |= ((BigInt(hi) << 32n) | BigInt(lo)) & ~XSTATE_MASK_LEGACY;
        }
        Mem.writeUint32(out, Number(mask & 0xffffffffn) >>> 0);
        Mem.writeUint32(out + 4, Number(mask >> 32n) >>> 0);
        return { value: 1, stackCleanup: 8 };
    };

    // PVOID LocateXStateFeature(PCONTEXT Context, DWORD FeatureId, PDWORD Length)
    // x87 and SSE live in the CONTEXT's FXSAVE image; nothing beyond them is enabled.
    exports['LocateXStateFeature'] = (_ctx, _mem, args) => {
        const context = args[0] >>> 0;
        const feature = args[1] >>> 0;
        const lengthPtr = args[2] >>> 0;
        const flags = Mem.readUint32(context) ?? 0;
        if (!(flags & CONTEXT_I386) || feature >= 2) return { value: 0, stackCleanup: 12 };
        const fxsave = context + CONTEXT_EXTENDED_REGISTERS_OFFSET;
        if (feature === 1) {
            if (lengthPtr) Mem.writeUint32(lengthPtr, 16 * 8);
            return { value: (fxsave + XSAVE_XMM_OFFSET) >>> 0, stackCleanup: 12 };
        }
        if (lengthPtr) Mem.writeUint32(lengthPtr, XSAVE_XMM_OFFSET);
        return { value: fxsave >>> 0, stackCleanup: 12 };
    };

    // LONG AppPolicyGetWindowingModel(HANDLE processToken, AppPolicyWindowingModel* policy).
    // The other AppPolicyGet* exist only in kernelbase (modules/kernelbase.ts).
    exports['AppPolicyGetWindowingModel'] = appPolicyExport(2);      // ClassicDesktop

    // BOOL GetProcessMitigationPolicy(HANDLE, PROCESS_MITIGATION_POLICY, PVOID lpBuffer, SIZE_T dwLength)
    exports['GetProcessMitigationPolicy'] = (_ctx, _mem, args) => {
        const policy = args[1] >>> 0;
        const buffer = args[2] >>> 0;
        const length = args[3] >>> 0;
        const sched = System.getInstance().scheduler;
        const process = processOf(args[0] >>> 0);
        if (!process) {
            sched.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 16 };
        }
        const size = mitigationPolicySize(policy, length);
        if (policy >= MAX_PROCESS_MITIGATION_POLICY || length !== size || !buffer) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 16 };
        }
        const out = new Uint8Array(size);
        if (process.pid === VIRTUAL_CURRENT_PROCESS_ID && policy !== PROCESS_MITIGATION_OPTIONS_MASK) {
            const v = new DataView(out.buffer);
            v.setUint32(0, mitigationFlags.get(policy) ?? 0, true);
            if (policy === PROCESS_DEP_POLICY) v.setUint8(4, depPermanent);
        }
        if (Mem.writeBytes(buffer, out) !== out.length) {
            sched.setLastError(ERROR_NOACCESS);
            return { value: 0, stackCleanup: 16 };
        }
        return { value: 1, stackCleanup: 16 };
    };

    // BOOL SetProcessMitigationPolicy(PROCESS_MITIGATION_POLICY, PVOID lpBuffer, SIZE_T dwLength)
    // A mitigation, once on, cannot be turned back off.
    exports['SetProcessMitigationPolicy'] = (_ctx, _mem, args) => {
        const policy = args[0] >>> 0;
        const buffer = args[1] >>> 0;
        const length = args[2] >>> 0;
        const sched = System.getInstance().scheduler;
        if (policy >= MAX_PROCESS_MITIGATION_POLICY || policy === PROCESS_MITIGATION_OPTIONS_MASK ||
            length !== mitigationPolicySize(policy, length) || !buffer) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 12 };
        }
        const flags = Mem.readUint32(buffer);
        if (flags === null) {
            sched.setLastError(ERROR_NOACCESS);
            return { value: 0, stackCleanup: 12 };
        }
        const current = mitigationFlags.get(policy) ?? 0;
        if ((current & ~flags) !== 0) {
            sched.setLastError(ERROR_ACCESS_DENIED);
            return { value: 0, stackCleanup: 12 };
        }
        mitigationFlags.set(policy, (current | flags) >>> 0);
        if (policy === PROCESS_DEP_POLICY && (Mem.readUint8(buffer + 4) ?? 0)) depPermanent = 1;
        return { value: 1, stackCleanup: 12 };
    };

    // BOOL QueryFullProcessImageNameW(HANDLE, DWORD dwFlags, LPWSTR lpExeName, PDWORD lpdwSize)
    // dwFlags PROCESS_NAME_NATIVE asks for the NT device path instead of the Win32 one.
    exports['QueryFullProcessImageNameW'] = (_ctx, _mem, args) => {
        const flags = args[1] >>> 0;
        const out = args[2] >>> 0;
        const sizePtr = args[3] >>> 0;
        const sched = System.getInstance().scheduler;
        const PROCESS_NAME_NATIVE = 0x1;
        const process = processOf(args[0] >>> 0);
        if (!process) {
            sched.setLastError(ERROR_INVALID_HANDLE);
            return { value: 0, stackCleanup: 16 };
        }
        const capacity = sizePtr ? Mem.readUint32(sizePtr) : null;
        if ((flags & ~PROCESS_NAME_NATIVE) || capacity === null) {
            sched.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 16 };
        }
        let path = process.imagePath;
        if (flags & PROCESS_NAME_NATIVE) {
            const device = resolveDosDeviceTarget(path.slice(0, 2));
            if (device) path = device + path.slice(2);
        }
        if (capacity < path.length + 1) {
            sched.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return { value: 0, stackCleanup: 16 };
        }
        if (!out || !writeWideString(out, path)) {
            sched.setLastError(ERROR_NOACCESS);
            return { value: 0, stackCleanup: 16 };
        }
        Mem.writeUint32(sizePtr, path.length);
        return { value: 1, stackCleanup: 16 };
    };

    // HRESULT WerRegisterRuntimeExceptionModule(PCWSTR pwszOutOfProcessCallbackDll, PVOID pContext)
    // Registration is all that happens in-process; WER consults the list only after a crash.
    exports['WerRegisterRuntimeExceptionModule'] = (_ctx, _mem, args) => {
        const dllPtr = args[0] >>> 0;
        const dll = dllPtr ? readWideString(dllPtr, 260) : null;
        if (!dll) return { value: 0x80070057, stackCleanup: 8 }; // E_INVALIDARG
        if (werRuntimeExceptionModules.length >= WER_MAX_REGISTERED_RUNTIME_EXCEPTION_MODULES) {
            return { value: 0x80070008, stackCleanup: 8 };        // HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_MEMORY)
        }
        werRuntimeExceptionModules.push({ dll, context: args[1] >>> 0 });
        return { value: S_OK, stackCleanup: 8 };
    };

    // VOID RaiseFailFastException(PEXCEPTION_RECORD, PCONTEXT, DWORD dwFlags)
    // Fail-fast skips every handler — SEH, vectored, the unhandled-exception filter — and ends
    // the process with the exception code as its exit code.
    exports['RaiseFailFastException'] = (ctx: X86Context, _mem, args) => {
        const record = args[0] >>> 0;
        const code = record ? (Mem.readUint32(record) ?? STATUS_FAIL_FAST_EXCEPTION) : STATUS_FAIL_FAST_EXCEPTION;
        const address = record ? (Mem.readUint32(record + 12) ?? 0) : (Mem.readUint32(ctx.esp) ?? 0);
        Logger.error(LogCategory.KERNEL32,
            `RaiseFailFastException(code=0x${code.toString(16)}, address=0x${address.toString(16)}, ` +
            `flags=0x${(args[2] >>> 0).toString(16)}) — terminating the process`);
        return shutdownProcess(code >>> 0);
    };

    // BOOL GetProductInfo(DWORD dwOSMajorVersion, DWORD dwOSMinorVersion, DWORD dwSpMajorVersion,
    //   DWORD dwSpMinorVersion, PDWORD pdwReturnedProductType)
    // The edition installed is a workstation one; the arguments only gate pre-Vista callers.
    exports['GetProductInfo'] = (_ctx, _mem, args) => {
        const out = args[4] >>> 0;
        const PRODUCT_UNDEFINED = 0;
        const PRODUCT_ULTIMATE = 0x1;
        const PRODUCT_PROFESSIONAL = 0x30;
        if (!out) return { value: 0, stackCleanup: 20 };
        if ((args[0] >>> 0) < 6) {
            Mem.writeUint32(out, PRODUCT_UNDEFINED);
            return { value: 0, stackCleanup: 20 };
        }
        const os = EmulatorConfig.getInstance().osVersion;
        const win8OrLater = os.major > 6 || (os.major === 6 && os.minor >= 2);
        Mem.writeUint32(out, win8OrLater ? PRODUCT_PROFESSIONAL : PRODUCT_ULTIMATE);
        return { value: 1, stackCleanup: 20 };
    };

    return exports;
}

export const exports: Record<string, ThunkImplementation> = initVistaSystem();

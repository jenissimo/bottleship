/**
 * TEB/PEB Manager
 *
 * Allocates and manages per-thread Thread Environment Blocks (TEB)
 * and the single Process Environment Block (PEB) in guest memory.
 *
 * Note: Does NOT cache mem/DataView references — v86 can restart
 * and detach the underlying ArrayBuffer at any time. All access goes
 * through the getMemory() getter to always get the live buffer.
 *
 * TEB layout (Windows NT compatible, offsets in hex):
 *   0x00  ExceptionList           (SEH chain head, 0xFFFFFFFF = end)
 *   0x04  StackBase               (highest stack address)
 *   0x08  StackLimit              (lowest stack address)
 *   0x0C  SubSystemTib            (0)
 *   0x10  FiberData/Version       (0)
 *   0x14  ArbitraryUserPointer    (0)
 *   0x18  Self                    (-> TEB address itself)
 *   0x1C  EnvironmentPointer      (0)
 *   0x20  ClientId.UniqueProcess  (PID)
 *   0x24  ClientId.UniqueThread   (TID)
 *   0x28  ActiveRpcHandle         (0)
 *   0x2C  ThreadLocalStoragePointer (-> TLS array)
 *   0x30  ProcessEnvironmentBlock (-> PEB)
 *   0x34  LastErrorValue
 */

import { Logger, LogCategory } from './logger';
import { EmulatorConfig } from './emulator-config-manager';
import { GUEST_NUMBER_OF_PROCESSORS } from './guest-cpu-identity';

// TEB field offsets
const TEB_EXCEPTION_LIST    = 0x00;
const TEB_STACK_BASE        = 0x04;
const TEB_STACK_LIMIT       = 0x08;
const TEB_SELF              = 0x18;
const TEB_CLIENT_ID_PROCESS = 0x20;
const TEB_CLIENT_ID_THREAD  = 0x24;
const TEB_TLS_POINTER       = 0x2C;
const TEB_PEB               = 0x30;
const TEB_LAST_ERROR        = 0x34;

const TEB_SIZE = 4096;          // One page per TEB
// A 32-bit NT 5.x PEB is 0x210 bytes. Anything we place at PEB+offset below that lands inside a
// real field (0x100 is in the middle of GdiHandleBuffer), so the header proper is reserved whole.
const PEB_SIZE = 0x230;
const TLS_MINIMUM_AVAILABLE = 64;
const TLS_ARRAY_SIZE = TLS_MINIMUM_AVAILABLE * 4; // 64 slots * 4 bytes each

const FAKE_PID = 1234;

// PEB field offsets
const PEB_BEING_DEBUGGED       = 0x02; // BOOLEAN (byte)
const PEB_IMAGE_BASE           = 0x08; // PVOID
const PEB_PROCESS_PARAMETERS   = 0x10; // PRTL_USER_PROCESS_PARAMETERS
const PEB_LDR                  = 0x0C; // PPEB_LDR_DATA
const PEB_NUMBER_OF_PROCESSORS = 0x64; // ULONG
const PEB_OS_MAJOR_VERSION     = 0xA4; // ULONG
const PEB_OS_MINOR_VERSION     = 0xA8; // ULONG
const PEB_OS_BUILD_NUMBER      = 0xAC; // USHORT
const PEB_OS_CSD_VERSION       = 0xAE; // USHORT
const PEB_OS_PLATFORM_ID       = 0xB0; // ULONG

// RTL_USER_PROCESS_PARAMETERS (32-bit) — only the head scalar fields matter for us;
// the rest stays zeroed (empty/valid). Real CRTs read ProcessParameters->Flags (+8),
// std handles, CommandLine/ImagePathName etc. A NULL ProcessParameters faults any of
// these (unreal-gold's CRT reads [ProcessParameters+8] >> 31 on its first frame).
const PROC_PARAMS_SIZE         = 0x400; // generous; real struct is ~0x290 in 32-bit
const PP_MAXIMUM_LENGTH        = 0x00; // ULONG
const PP_LENGTH                = 0x04; // ULONG
const PP_FLAGS                 = 0x08; // ULONG
const RTL_USER_PROC_PARAMS_NORMALIZED = 0x01; // pointers are absolute (running process)

// ProcessParameters lives at a FIXED offset INSIDE the PEB allocation rather than a
// separate alloc. Post-reset (process.reset zeroes the heap + resets the bump to
// heap-base), a fresh alloc would land on 0x1000000 — the same address the persistent
// PEB occupies (it sits at the main thread's stack bottom and is reused in place). A
// fixed sub-region avoids that collision; updatePebImageBase re-writes it post-reset.
const LDR_OFFSET_IN_PEB        = PEB_SIZE + PROC_PARAMS_SIZE;
const LDR_STORAGE_SIZE         = 0x8000;
const PEB_ALLOC_SIZE           = LDR_OFFSET_IN_PEB + LDR_STORAGE_SIZE;
const PP_OFFSET_IN_PEB         = PEB_SIZE; // ProcessParameters immediately follows the PEB header

export interface PebLoaderModule {
    name: string;
    path: string;
    base: number;
    size: number;
    entryPoint: number;
}

interface MemoryManager {
    alloc(size: number, kind?: string, perms?: string): number;
}

export class TebManager {
    private pebAddress: number = 0;
    private processParametersAddress: number = 0;           // RTL_USER_PROCESS_PARAMETERS
    private tebMap: Map<number, number> = new Map();        // threadId -> TEB guest address
    private tlsArrayMap: Map<number, number> = new Map();   // threadId -> TLS array guest address
    private getMemory: (() => Uint8Array) | null = null;

    /** Get a fresh DataView over the current (non-detached) memory buffer. */
    private getView(): DataView | null {
        if (!this.getMemory) return null;
        const mem = this.getMemory();
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    }

    /**
     * Initialize the PEB (one per process).
     * Must be called once during process initialization.
     */
    initProcess(getMemory: () => Uint8Array, memoryManager: MemoryManager, imageBase: number = 0x00400000): void {
        this.getMemory = getMemory;
        this.tebMap.clear();
        this.tlsArrayMap.clear();

        // Allocate PEB + its embedded ProcessParameters as one block.
        this.pebAddress = memoryManager.alloc(PEB_ALLOC_SIZE);
        const mem = getMemory();
        mem.fill(0, this.pebAddress, this.pebAddress + PEB_ALLOC_SIZE);

        // Fill minimal PEB fields
        const view = this.getView()!;
        view.setUint8(this.pebAddress + PEB_BEING_DEBUGGED, 0);
        view.setUint32(this.pebAddress + PEB_IMAGE_BASE, imageBase, true);

        this.writePebSystemFields();
        this.ensureProcessParameters();

        Logger.log(LogCategory.THREAD,
            `TebManager: PEB allocated at 0x${this.pebAddress.toString(16)}, ` +
            `ProcessParameters at 0x${this.processParametersAddress.toString(16)}`);
    }

    /**
     * Allocate + wire PEB->ProcessParameters. Without it, PEB+0x10 is NULL and any
     * guest/CRT read of ProcessParameters (->Flags at +8, std handles, CommandLine,
     * ImagePathName, ...) faults — unreal-gold's statically-linked CRT reads
     * [ProcessParameters+8] >> 31 on its first frame (UInput::ReadInput → AV).
     *
     * MUST be (re)called after every process reset: process.reset() zeroes the HEAP
     * region (wiping the structure) but does NOT re-run initProcess. We re-write it at a
     * FIXED offset inside the persistent PEB allocation (NOT a fresh alloc — that would
     * collide with the PEB at heap-base post-reset). Hence updatePebImageBase() calls
     * this: both run right after PE (re)load, before the guest's first instruction.
     *
     * Empty UNICODE_STRINGs (Length=0, Buffer=NULL) are the legitimate "no value" state
     * and safe to read; only the head scalar fields are populated.
     */
    private ensureProcessParameters(): void {
        if (!this.pebAddress) return;
        const pp = this.pebAddress + PP_OFFSET_IN_PEB;
        this.processParametersAddress = pp;
        const mem = this.getMemory?.();
        if (mem) mem.fill(0, pp, pp + PROC_PARAMS_SIZE);
        const view = this.getView();
        if (!view) return;
        view.setUint32(pp + PP_MAXIMUM_LENGTH, PROC_PARAMS_SIZE, true);
        view.setUint32(pp + PP_LENGTH, PROC_PARAMS_SIZE, true);
        view.setUint32(pp + PP_FLAGS, RTL_USER_PROC_PARAMS_NORMALIZED, true);
        view.setUint32(this.pebAddress + PEB_PROCESS_PARAMETERS, pp, true);
    }

    /** Update PEB ImageBaseAddress after PE loading determines the actual base. Also
     *  re-establishes ProcessParameters, which process.reset() wiped (see above). */
    updatePebImageBase(imageBase: number): void {
        if (!this.pebAddress || !this.getMemory) return;
        const view = this.getView();
        if (view) {
            view.setUint32(this.pebAddress + PEB_IMAGE_BASE, imageBase, true);
        }
        this.writePebSystemFields();
        this.ensureProcessParameters();
    }

    /** Publish the 32-bit NT loader lists used by code that resolves exports through
     * PEB->Ldr instead of calling GetModuleHandle/GetProcAddress. */
    syncLoaderData(modules: PebLoaderModule[]): void {
        if (!this.pebAddress || !this.getMemory) return;
        const mem = this.getMemory();
        const view = this.getView();
        if (!view) return;

        const ldr = this.pebAddress + LDR_OFFSET_IN_PEB;
        const storageEnd = ldr + LDR_STORAGE_SIZE;
        mem.fill(0, ldr, storageEnd);
        view.setUint32(this.pebAddress + PEB_LDR, ldr, true);
        view.setUint32(ldr, 0x30, true);
        view.setUint8(ldr + 4, 1);

        const entrySize = 0x50;
        let cursor = ldr + 0x30 + modules.length * entrySize;
        const entries: number[] = [];
        const writeUnicodeString = (descriptor: number, value: string): void => {
            const byteLength = value.length * 2;
            if (cursor + byteLength + 2 > storageEnd) throw new Error('PEB loader storage exhausted');
            for (let i = 0; i < value.length; i++) view.setUint16(cursor + i * 2, value.charCodeAt(i), true);
            view.setUint16(cursor + byteLength, 0, true);
            view.setUint16(descriptor, byteLength, true);
            view.setUint16(descriptor + 2, byteLength + 2, true);
            view.setUint32(descriptor + 4, cursor, true);
            cursor += byteLength + 2;
            cursor = (cursor + 3) & ~3;
        };

        for (let i = 0; i < modules.length; i++) {
            const mod = modules[i]!;
            const entry = ldr + 0x30 + i * entrySize;
            entries.push(entry);
            view.setUint32(entry + 0x18, mod.base >>> 0, true);
            view.setUint32(entry + 0x1C, mod.entryPoint >>> 0, true);
            view.setUint32(entry + 0x20, mod.size >>> 0, true);
            writeUnicodeString(entry + 0x24, mod.path);
            writeUnicodeString(entry + 0x2C, mod.name);
            view.setUint16(entry + 0x38, 0xFFFF, true);
        }

        const linkList = (head: number, linkOffset: number, listEntries = entries): void => {
            if (listEntries.length === 0) {
                view.setUint32(head, head, true);
                view.setUint32(head + 4, head, true);
                return;
            }
            for (let i = 0; i < listEntries.length; i++) {
                const link = listEntries[i]! + linkOffset;
                const next = i + 1 < listEntries.length ? listEntries[i + 1]! + linkOffset : head;
                const prev = i > 0 ? listEntries[i - 1]! + linkOffset : head;
                view.setUint32(link, next, true);
                view.setUint32(link + 4, prev, true);
            }
            view.setUint32(head, listEntries[0]! + linkOffset, true);
            view.setUint32(head + 4, listEntries[listEntries.length - 1]! + linkOffset, true);
        };
        linkList(ldr + 0x0C, 0x00);
        linkList(ldr + 0x14, 0x08);
        // The process image is present in load/memory order, but Windows does not put
        // it in InInitializationOrder. Bootstrap resolvers rely on ntdll being first.
        linkList(ldr + 0x1C, 0x10, entries.filter((_, i) => !modules[i]!.name.toLowerCase().endsWith('.exe')));
    }

    /**
     * OS version + processor count as the loader publishes them. Code that avoids the call
     * overhead of GetVersionEx reads these inline through fs:[0x30]; left zeroed they say
     * "Windows 0.0, platform 0", which every version gate reads as an OS older than anything
     * it supports. Re-written on every image (re)load because the manifest that carries
     * osVersion is applied after the PEB is first allocated, and reset() zeroes it.
     */
    private writePebSystemFields(): void {
        if (!this.pebAddress) return;
        const view = this.getView();
        if (!view) return;
        const { major, minor, build, platformId } = EmulatorConfig.getInstance().osVersion;
        view.setUint32(this.pebAddress + PEB_OS_MAJOR_VERSION, major >>> 0, true);
        view.setUint32(this.pebAddress + PEB_OS_MINOR_VERSION, minor >>> 0, true);
        view.setUint16(this.pebAddress + PEB_OS_BUILD_NUMBER, build & 0xFFFF, true);
        view.setUint16(this.pebAddress + PEB_OS_CSD_VERSION, 0, true); // no service pack
        view.setUint32(this.pebAddress + PEB_OS_PLATFORM_ID, platformId >>> 0, true);
        view.setUint32(this.pebAddress + PEB_NUMBER_OF_PROCESSORS, GUEST_NUMBER_OF_PROCESSORS, true);
    }

    /**
     * Allocate a TEB for a new thread.
     * Returns the guest memory address of the TEB.
     */
    allocateTeb(
        threadId: number,
        stackBase: number,
        stackTop: number,
        memoryManager: MemoryManager
    ): number {
        if (!this.getMemory) {
            Logger.error(LogCategory.THREAD, 'TebManager: not initialized (call initProcess first)');
            return 0;
        }

        // Allocate TEB
        const tebAddress = memoryManager.alloc(TEB_SIZE);
        const mem = this.getMemory();
        mem.fill(0, tebAddress, tebAddress + TEB_SIZE);

        // Allocate TLS array
        const tlsArrayAddress = memoryManager.alloc(TLS_ARRAY_SIZE);
        mem.fill(0, tlsArrayAddress, tlsArrayAddress + TLS_ARRAY_SIZE);

        const view = this.getView()!;

        // Fill TEB fields
        view.setUint32(tebAddress + TEB_EXCEPTION_LIST, 0xFFFFFFFF, true);  // End-of-SEH-chain
        view.setUint32(tebAddress + TEB_STACK_BASE, stackTop, true);        // StackBase (highest)
        view.setUint32(tebAddress + TEB_STACK_LIMIT, stackBase, true);      // StackLimit (lowest)
        view.setUint32(tebAddress + TEB_SELF, tebAddress, true);            // Self pointer
        view.setUint32(tebAddress + TEB_CLIENT_ID_PROCESS, FAKE_PID, true); // PID
        view.setUint32(tebAddress + TEB_CLIENT_ID_THREAD, threadId, true);  // TID
        view.setUint32(tebAddress + TEB_TLS_POINTER, tlsArrayAddress, true);// TLS array
        view.setUint32(tebAddress + TEB_PEB, this.pebAddress, true);        // PEB
        view.setUint32(tebAddress + TEB_LAST_ERROR, 0, true);               // LastError

        this.tebMap.set(threadId, tebAddress);
        this.tlsArrayMap.set(threadId, tlsArrayAddress);

        Logger.log(LogCategory.THREAD,
            `TebManager: TEB for thread ${threadId} at 0x${tebAddress.toString(16)}, ` +
            `TLS at 0x${tlsArrayAddress.toString(16)}, ` +
            `stack=0x${stackBase.toString(16)}-0x${stackTop.toString(16)}`);

        return tebAddress;
    }

    /**
     * Get TEB address for a thread.
     */
    getTebAddress(threadId: number): number | undefined {
        return this.tebMap.get(threadId);
    }

    /** Guest address of the process PEB. */
    getPebAddress(): number {
        return this.pebAddress;
    }

    /** Guest address of the RTL_USER_PROCESS_PARAMETERS (PEB->ProcessParameters). */
    getProcessParametersAddress(): number {
        return this.processParametersAddress;
    }

    /**
     * Get TLS array address for a thread.
     */
    getTlsArrayAddress(threadId: number): number | undefined {
        return this.tlsArrayMap.get(threadId);
    }

    /**
     * Sync LastError value to guest TEB memory.
     */
    syncLastError(threadId: number, value: number): void {
        const tebAddr = this.tebMap.get(threadId);
        if (tebAddr === undefined) return;
        const view = this.getView();
        if (!view) return;
        view.setUint32(tebAddr + TEB_LAST_ERROR, value >>> 0, true);
    }

    /**
     * Read LastError from guest TEB memory.
     */
    readLastError(threadId: number): number {
        const tebAddr = this.tebMap.get(threadId);
        if (tebAddr === undefined) return 0;
        const view = this.getView();
        if (!view) return 0;
        return view.getUint32(tebAddr + TEB_LAST_ERROR, true);
    }

    /**
     * Sync a TLS slot value to guest memory.
     */
    syncTlsSlot(threadId: number, index: number, value: number): void {
        if (index < 0 || index >= TLS_MINIMUM_AVAILABLE) return;
        const tlsAddr = this.tlsArrayMap.get(threadId);
        if (tlsAddr === undefined) return;
        const view = this.getView();
        if (!view) return;
        view.setUint32(tlsAddr + index * 4, value >>> 0, true);
    }

    /**
     * Free a thread's TEB (just removes from tracking; memory freed by process cleanup).
     */
    freeTeb(threadId: number): void {
        this.tebMap.delete(threadId);
        this.tlsArrayMap.delete(threadId);
    }

    /**
     * Get all thread TEB addresses (for diagnostics).
     */
    getAllTebs(): Map<number, number> {
        return new Map(this.tebMap);
    }
}

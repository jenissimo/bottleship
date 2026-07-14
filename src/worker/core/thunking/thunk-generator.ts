// thunk-generator.ts
// Generates x86 stubs that trigger UD2 exceptions for WinAPI interception

import { deriveStackCleanupFromMangledName } from "./msvc-mangling";

export interface ThunkStub {
    address: number;
    dllName: string;
    functionName: string;
    functionId: number;
    argCount?: number;  // Number of arguments (for reading stack)
    /** Bytes callee pops on RET (for ESP checks). Use when decoration differs from params (e.g. _AIL_file_read@8). */
    stackCleanupBytes?: number;
}

/** Size of the shared "missing import" trap stub (UD2) – must be 16-byte aligned like other stubs */
const TRAP_STUB_SIZE = 16;

function normalizeThunkExportName(name: string): string {
    return name.toLowerCase().replace(/^_/, '').replace(/@\d+$/, '');
}

function buildQualifiedThunkKey(dllName: string, functionName: string): string {
    return `${dllName.toLowerCase()}:${functionName.toLowerCase()}`;
}

function buildNormalizedThunkKey(dllName: string, functionName: string): string {
    return `${dllName.toLowerCase()}:${normalizeThunkExportName(functionName)}`;
}

/** CRT/versioned DLL aliases — data exports registered on the canonical name only. */
const DATA_EXPORT_DLL_FORWARDS: Record<string, string> = {
    msvcr90: "msvcrt",
    msvcr80: "msvcrt",
    msvcr71: "msvcrt",
    msvcr70: "msvcrt",
};

export class ThunkGenerator {
    private baseAddress = 0x02000000; // Default fallback, will be set dynamically
    private currentAddress = 0x02000000;
    private nextFunctionId = 1;
    private stubs: Map<number, ThunkStub> = new Map();
    private addressToStub: Map<number, ThunkStub> = new Map();
    private nameToAddress: Map<string, number> = new Map();
    private exactNameToStubs: Map<string, ThunkStub[]> = new Map();
    private normalizedNameToStubs: Map<string, ThunkStub[]> = new Map();
    /** Data exports: dll:name -> guest memory address. No thunk stub generated; IAT points directly to data. */
    private dataExportAddresses: Map<string, number> = new Map();

    /** stdcall RET-N bytes: explicit override → argCount×4 → MSVC-mangled-name derivation. */
    private resolveBytesToPop(
        exportName: string,
        isStdcall: boolean,
        argCount?: number,
        stackCleanupBytes?: number
    ): number | undefined {
        let bytesToPop = stackCleanupBytes ?? (argCount !== undefined && argCount >= 0 ? argCount * 4 : undefined);
        if (isStdcall && bytesToPop === undefined && exportName.startsWith('?')) {
            // MSVC C++ mangling encodes the convention + parameter list (0 for __cdecl).
            bytesToPop = deriveStackCleanupFromMangledName(exportName);
        }
        return bytesToPop;
    }

    private appendStubIndex(index: Map<string, ThunkStub[]>, key: string, stub: ThunkStub): void {
        const existing = index.get(key);
        if (existing) {
            existing.push(stub);
            return;
        }
        index.set(key, [stub]);
    }

    private indexStub(stub: ThunkStub): void {
        this.appendStubIndex(this.exactNameToStubs, buildQualifiedThunkKey(stub.dllName, stub.functionName), stub);
        this.appendStubIndex(this.normalizedNameToStubs, buildNormalizedThunkKey(stub.dllName, stub.functionName), stub);
    }

    /**
     * Register a data export (global variable) for a DLL.
     * When the PE loader generates stubs, data exports get their address
     * written directly to the IAT instead of generating a thunk stub.
     * This is needed for imports like _acmdln (char*) and _adjust_fdiv (int)
     * which the game reads as data, not calls as functions.
     */
    registerDataExport(dllName: string, exportName: string, guestAddress: number): void {
        this.dataExportAddresses.set(buildQualifiedThunkKey(dllName, exportName), guestAddress);
    }

    private lookupDataExportAddress(dllName: string, exportName: string): number | undefined {
        const direct = this.dataExportAddresses.get(buildQualifiedThunkKey(dllName, exportName));
        if (direct !== undefined) return direct;
        const forwarded = DATA_EXPORT_DLL_FORWARDS[dllName.toLowerCase()];
        if (forwarded) {
            return this.dataExportAddresses.get(buildQualifiedThunkKey(forwarded, exportName));
        }
        return undefined;
    }

    /**
     * Set base address for thunk stubs (called from Process initialization).
     * Reserves the first TRAP_STUB_SIZE bytes for the shared "missing import" trap.
     */
    setBaseAddress(address: number): void {
        this.baseAddress = address;
        this.currentAddress = address + TRAP_STUB_SIZE;
    }

    /**
     * Address of the shared trap stub (UD2). IAT entries for unknown imports must point here
     * so the app fails predictably instead of calling into garbage.
     */
    getTrapStubAddress(): number {
        return this.baseAddress;
    }

    /**
     * Code for the trap stub: UD2 (0f 0b) + NOP padding. Caller must write this at getTrapStubAddress().
     */
    getTrapStubCode(): Uint8Array {
        const code = new Uint8Array(TRAP_STUB_SIZE);
        code[0] = 0x0f;
        code[1] = 0x0b; // UD2 – undefined instruction, triggers #UD
        return code;
    }

    /**
     * Idempotently materialize the trap stub in guest memory. Without this the trap
     * address holds zeroes, and a call to a missing import slides through `add [eax],al`
     * into the first real thunk stub — executing a random handler with foreign args
     * (root cause of the BoD python15 .text corruption, 2026-06-12).
     */
    writeTrapStub(mem: Uint8Array): boolean {
        const addr = this.getTrapStubAddress();
        if (addr <= 0 || addr + TRAP_STUB_SIZE > mem.length) return false;
        mem.set(this.getTrapStubCode(), addr);
        return true;
    }

    generateStubDll(dllName: string, exports: { name: string, argCount?: number, stackCleanupBytes?: number, callingConvention?: string }[]): {
        baseAddress: number;
        stubCode: Uint8Array;
        exportTable: Map<string, number>;
    } {
        const dllBase = this.currentAddress;
        const exportTable = new Map<string, number>();
        const codeChunks: number[] = [];

        for (const info of exports) {
            const exportName = info.name;
            const nameLower = exportName.toLowerCase();
            const fullKey = buildQualifiedThunkKey(dllName, exportName);

            // Check if this is a data export (global variable, not a function)
            const dataAddr = this.lookupDataExportAddress(dllName, exportName);
            if (dataAddr !== undefined) {
                exportTable.set(nameLower, dataAddr);
                continue; // Data export — IAT points directly to variable, no stub needed
            }

            // Check if we already have a stub for this function - reuse it!
            const existingAddr = this.nameToAddress.get(fullKey);
            if (existingAddr !== undefined) {
                exportTable.set(nameLower, existingAddr);
                continue; // Reuse existing stub, don't create duplicate
            }

            const stubAddress = this.currentAddress;
            const functionId = this.nextFunctionId++;

            // Stub format for 32-bit protected mode (16 bytes aligned):
            // B8 ID ID ID ID       - MOV EAX, functionId (5 bytes)
            // BA 77 B0 00 00       - MOV EDX, 0x0000B077 (5 bytes)
            // EF                   - OUT DX, EAX (1 byte)
            // C2 NN NN / C3        - RET N (3 bytes) or RET (1 byte)
            // Padding              - NOP padding

            codeChunks.push(
                0xB8,
                functionId & 0xFF,
                (functionId >> 8) & 0xFF,
                (functionId >> 16) & 0xFF,
                (functionId >> 24) & 0xFF,

                0xBA, 0x77, 0xB0, 0x00, 0x00,

                0xEF
            );

            // cdecl: caller cleans stack, use C3 (RET)
            // stdcall: callee cleans stack, use C2 NN NN (RET N). Prefer stackCleanupBytes when decoration is wrong.
            const isStdcall = !info.callingConvention || info.callingConvention === 'stdcall';
            const bytesToPop = this.resolveBytesToPop(exportName, isStdcall, info.argCount, info.stackCleanupBytes);

            if (isStdcall) {
                if (bytesToPop === undefined || bytesToPop < 0) {
                    throw new Error(
                        `[ThunkGenerator] Stub requires argCount or stackCleanupBytes for stdcall: ${dllName}:${exportName}. ` +
                        'Add to API or reference (tools/reference/win32). Run: bun tools/generate-reference-argcounts.ts'
                    );
                }
                if (bytesToPop > 0) {
                    codeChunks.push(0xC2, bytesToPop & 0xFF, (bytesToPop >> 8) & 0xFF);
                } else {
                    codeChunks.push(0xC3);
                }
            } else {
                codeChunks.push(0xC3);
            }

            // Pad this stub to 16 bytes
            while (codeChunks.length % 16 !== 0) {
                codeChunks.push(0x90);
            }

            const stub: ThunkStub = {
                address: stubAddress,
                dllName,
                functionName: exportName,
                functionId,
                argCount: info.argCount,
                stackCleanupBytes: isStdcall ? bytesToPop : 0,
            };

            this.stubs.set(functionId, stub);
            this.addressToStub.set(stubAddress, stub);
            this.indexStub(stub);
            exportTable.set(nameLower, stubAddress);

            // Store name mappings for GetProcAddress lookup
            this.nameToAddress.set(fullKey, stubAddress);
            this.nameToAddress.set(nameLower, stubAddress);

            this.currentAddress += 16;
        }

        return {
            baseAddress: dllBase,
            stubCode: new Uint8Array(codeChunks),
            exportTable,
        };
    }

    /**
     * Allocate one stub and register it. Used to extend an existing stub DLL when a later
     * importer (e.g. smackw32) needs an export the first importer did not (e.g. Sleep).
     * Returns address and code; caller must write code to memory and add address to export table.
     */
    allocateOneStub(
        dllName: string,
        exportName: string,
        argCount?: number,
        callingConvention?: string,
        stackCleanupBytes?: number
    ): { address: number; code: Uint8Array } {
        const stubAddress = this.currentAddress;
        const functionId = this.nextFunctionId++;
        const isStdcall = !callingConvention || callingConvention === 'stdcall';
        const bytesToPop = this.resolveBytesToPop(exportName, isStdcall, argCount, stackCleanupBytes);
        if (isStdcall && bytesToPop === undefined) {
            throw new Error(
                `[ThunkGenerator] allocateOneStub requires argCount or stackCleanupBytes for stdcall: ${dllName}:${exportName}`
            );
        }
        const codeChunks: number[] = [
            0xB8, functionId & 0xFF, (functionId >> 8) & 0xFF, (functionId >> 16) & 0xFF, (functionId >> 24) & 0xFF,
            0xBA, 0x77, 0xB0, 0x00, 0x00,
            0xEF,
        ];
        if (isStdcall) {
            if (bytesToPop && bytesToPop > 0) {
                codeChunks.push(0xC2, bytesToPop & 0xFF, (bytesToPop >> 8) & 0xFF);
            } else {
                codeChunks.push(0xC3);
            }
        } else {
            codeChunks.push(0xC3);
        }
        while (codeChunks.length % 16 !== 0) codeChunks.push(0x90);
        const code = new Uint8Array(codeChunks);
        const stub: ThunkStub = {
            address: stubAddress,
            dllName,
            functionName: exportName,
            functionId,
            argCount,
            // Cache cdecl as 0 so ThunkDispatcher never falls back to argCount * 4.
            stackCleanupBytes: isStdcall ? bytesToPop : 0,
        };
        this.stubs.set(functionId, stub);
        this.addressToStub.set(stubAddress, stub);
        this.indexStub(stub);
        const nameLower = exportName.toLowerCase();
        this.nameToAddress.set(buildQualifiedThunkKey(dllName, exportName), stubAddress);
        this.nameToAddress.set(nameLower, stubAddress);
        this.currentAddress += 16;
        return { address: stubAddress, code };
    }

    /**
     * Reserve a raw, 16-byte-granular executable area in THUNK_CODE with no
     * stub/functionId registration. Used by hle-lib for relocated-prologue
     * trampolines (Guarded Inner-Loop HLE): the caller writes the bytes and
     * guest code executes them like any other thunk-region code. Returns the
     * base address of the reserved area.
     */
    allocateRawCodeArea(sizeBytes: number): number {
        const address = this.currentAddress;
        const slots = Math.ceil(sizeBytes / 16);
        this.currentAddress += slots * 16;
        return address;
    }

    getStubById(id: number): ThunkStub | undefined {
        return this.stubs.get(id);
    }

    getStubByAddress(address: number): ThunkStub | undefined {
        return this.addressToStub.get(address);
    }

    /**
     * Get all registered stubs (for debugging)
     */
    getAllStubs(): ThunkStub[] {
        return Array.from(this.stubs.values());
    }

    /**
     * Find stubs by qualified name without scanning the full stub table.
     * Uses exact case-insensitive match first, then normalized-name fallback.
     */
    findStubsByName(dllName: string, functionName: string): ThunkStub[] {
        const exact = this.exactNameToStubs.get(buildQualifiedThunkKey(dllName, functionName));
        if (exact && exact.length > 0) {
            return exact;
        }
        return this.normalizedNameToStubs.get(buildNormalizedThunkKey(dllName, functionName)) ?? [];
    }

    /**
     * Get export address by function name (for GetProcAddress).
     * Searches both "dll:name" and "name" formats.
     */
    getExportAddress(name: string): number | undefined {
        const nameLower = name.toLowerCase();
        return this.nameToAddress.get(nameLower);
    }

    /**
     * Get data export address by dll:name key (for GetProcAddress on data exports like _acmdln, _adjust_fdiv).
     * Data exports are global variables — the returned address points to the variable in guest memory,
     * NOT to a thunk stub. The game reads/writes this address directly as data.
     */
    getDataExportAddress(dllName: string, exportName: string): number | undefined {
        return this.lookupDataExportAddress(dllName, exportName);
    }

    /**
     * Reset the thunk generator - clear all stubs and reset addresses.
     */
    reset(): void {
        this.currentAddress = this.baseAddress + TRAP_STUB_SIZE;
        this.nextFunctionId = 1;
        this.stubs.clear();
        this.addressToStub.clear();
        this.nameToAddress.clear();
        this.exactNameToStubs.clear();
        this.normalizedNameToStubs.clear();
        this.dataExportAddresses.clear();
    }

    /**
     * Allocate memory for vtable arrays in the protected thunk region.
     * This prevents heap allocations from overwriting vtables.
     * Returns the address where vtable should be written.
     */
    allocateVTableMemory(sizeInBytes: number): number {
        // Align to 16 bytes for consistency
        const alignedSize = (sizeInBytes + 15) & ~15;
        const addr = this.currentAddress;
        this.currentAddress += alignedSize;
        return addr;
    }

    /**
     * Get current address (for debugging memory layout)
     */
    getCurrentAddress(): number {
        return this.currentAddress;
    }
}

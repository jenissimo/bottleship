// thunk-generator.ts
// Generates x86 stubs that trigger UD2 exceptions for WinAPI interception

import { deriveStackCleanupFromMangledName } from "./msvc-mangling";
import { invalidateGuestCode, writeGuestCode } from "../memory/guest-code";

export interface ThunkStub {
    address: number;
    dllName: string;
    functionName: string;
    functionId: number;
    argCount?: number;  // Number of arguments (for reading stack)
    /** Bytes callee pops on RET (for ESP checks). Use when decoration differs from params (e.g. _AIL_file_read@8). */
    stackCleanupBytes?: number;
    /**
     * This export belongs to a DLL we deliberately refuse to load, so "absent" — not
     * "call failed" — is the honest answer: the default ERROR_NOT_SUPPORTED (50) reads
     * as a valid pointer/handle to a caller that stores the result (Serious Sam's
     * ImmWrapper kept 50 as its CImmDevice* and dereferenced it).
     */
    absentDll?: boolean;
    /**
     * The bytes at `address` were overwritten with a JMP to this address (an in-image
     * export body pointed at a trap-free inline stub). The stub's identity — which export
     * this address IS — does not change; what changes is that executing it no longer traps
     * on `functionId`, so anything naming the BODY must say so.
     */
    redirectedTo?: number;
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

/** The stdcall byte count in a decorated name (`_AIL_pause_stream@8` -> "8"), or null. */
function thunkDecoration(name: string): string | null {
    const m = /@(\d+)$/.exec(name);
    return m ? m[1]! : null;
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
     * Bump the code cursor and drop v86's compiled blocks for the handed-out range.
     *
     * Invalidating at hand-out (not after the caller's write) is what makes the invariant
     * hard to forget: the guest cannot execute between a JS allocation and the JS write that
     * fills it — the worker only re-enters v86 once the whole JS turn is done — so a callee
     * that assembles bytes in place is covered without knowing this file exists.
     */
    private bumpCode(size: number): number {
        const address = this.currentAddress;
        this.currentAddress += size;
        invalidateGuestCode(address, size);
        return address;
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
        return writeGuestCode(mem, this.getTrapStubCode(), addr);
    }

    generateStubDll(dllName: string, exports: { name: string, argCount?: number, stackCleanupBytes?: number, callingConvention?: string }[], opts?: { absentDll?: boolean }): {
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
                absentDll: opts?.absentDll,
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

        // One invalidation for the whole handed-out span (see bumpCode).
        invalidateGuestCode(dllBase, this.currentAddress - dllBase);

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
        const stubAddress = this.bumpCode(16);
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
        return { address: stubAddress, code };
    }

    /**
     * Build a stub for a caller-chosen address instead of the THUNK_CODE bump arena, and
     * register it exactly like any other. Used by the HLE synthetic module images, whose
     * export bodies must live INSIDE the image so AddressOfFunctions can name them with an
     * RVA below SizeOfImage. Dispatch keys on the functionId in EAX, not on where the
     * bytes sit, so such a stub dispatches identically. The caller publishes `code` at
     * `address` (through writeGuestCode — these bytes are executed).
     */
    allocateStubAt(
        address: number,
        dllName: string,
        exportName: string,
        argCount?: number,
        callingConvention?: string,
        stackCleanupBytes?: number
    ): { address: number; code: Uint8Array } {
        const functionId = this.nextFunctionId++;
        const isStdcall = !callingConvention || callingConvention === 'stdcall';
        const bytesToPop = this.resolveBytesToPop(exportName, isStdcall, argCount, stackCleanupBytes);
        if (isStdcall && bytesToPop === undefined) {
            throw new Error(
                `[ThunkGenerator] allocateStubAt requires argCount or stackCleanupBytes for stdcall: ${dllName}:${exportName}`
            );
        }
        const codeChunks: number[] = [
            0xB8, functionId & 0xFF, (functionId >> 8) & 0xFF, (functionId >> 16) & 0xFF, (functionId >> 24) & 0xFF,
            0xBA, 0x77, 0xB0, 0x00, 0x00,
            0xEF,
        ];
        if (isStdcall && bytesToPop && bytesToPop > 0) {
            codeChunks.push(0xC2, bytesToPop & 0xFF, (bytesToPop >> 8) & 0xFF);
        } else {
            codeChunks.push(0xC3);
        }
        while (codeChunks.length % 16 !== 0) codeChunks.push(0x90);

        const stub: ThunkStub = {
            address: address >>> 0,
            dllName,
            functionName: exportName,
            functionId,
            argCount,
            stackCleanupBytes: isStdcall ? bytesToPop : 0,
        };
        this.stubs.set(functionId, stub);
        this.addressToStub.set(address >>> 0, stub);
        this.indexStub(stub);
        // Deliberately NOT in nameToAddress: that map is generateStubDll's reuse cache, and
        // feeding it in-image bodies would make a guest IAT point into the image or into
        // THUNK_CODE depending on whether its DLL loaded before or after materialization.
        // One inconsistent rule is worse than one uniform divergence.
        return { address: address >>> 0, code: new Uint8Array(codeChunks) };
    }

    /**
     * Publish a second entry point for an existing thunk without consuming another
     * function ID. Synthetic HLE PE images need export bodies inside their own .text,
     * while dispatch identity belongs to the API, not to the address used to enter it.
     *
     * `exportName` is the name the body is published under, which is not always the
     * target's: `findStubsByName` bridges the undecorated/decorated spelling gap on
     * purpose. Returns null when the two do not agree on the stack contract — a module
     * that declares several decorations of one base name (`_AIL_file_read@8` takes two
     * arguments, `@12` takes three) matches the undecorated name against all of them,
     * and aliasing across that gap publishes one contract's RET N under the other's name
     * on the other's functionId. The caller must fall back to its own stub; refusing
     * here rather than throwing keeps that a decision, not a lost export.
     */
    allocateAliasStubAt(
        address: number,
        target: ThunkStub,
        exportName: string,
        argCount?: number,
        callingConvention?: string,
        stackCleanupBytes?: number
    ): { address: number; code: Uint8Array } | null {
        const isStdcall = !callingConvention || callingConvention === 'stdcall';
        const bytesToPop = this.resolveBytesToPop(exportName, isStdcall, argCount, stackCleanupBytes);
        if (isStdcall && bytesToPop === undefined) {
            throw new Error(
                `[ThunkGenerator] allocateAliasStubAt requires argCount or stackCleanupBytes for stdcall: ` +
                `${target.dllName}:${exportName}`
            );
        }
        // An alias shares the target's functionId, so a disagreement here is not a
        // cleanup detail — it means the two names are different functions.
        if ((isStdcall ? bytesToPop ?? 0 : 0) !== (target.stackCleanupBytes ?? 0)) return null;

        const functionId = target.functionId;
        const codeChunks: number[] = [
            0xB8, functionId & 0xFF, (functionId >> 8) & 0xFF, (functionId >> 16) & 0xFF, (functionId >> 24) & 0xFF,
            0xBA, 0x77, 0xB0, 0x00, 0x00,
            0xEF,
        ];
        if (isStdcall && bytesToPop && bytesToPop > 0) {
            codeChunks.push(0xC2, bytesToPop & 0xFF, (bytesToPop >> 8) & 0xFF);
        } else {
            codeChunks.push(0xC3);
        }
        while (codeChunks.length % 16 !== 0) codeChunks.push(0x90);

        const alias: ThunkStub = {
            address: address >>> 0,
            dllName: target.dllName,
            // The name this body is REACHED by. Recording the target's instead makes every
            // name-based reading of this address (the stub audits, a crash's ESP check)
            // answer with an export that does not live here.
            functionName: exportName,
            functionId,
            argCount,
            stackCleanupBytes: isStdcall ? bytesToPop : 0,
        };
        this.addressToStub.set(alias.address, alias);
        return { address: alias.address, code: new Uint8Array(codeChunks) };
    }

    /**
     * Reserve a raw, 16-byte-granular executable area in THUNK_CODE with no
     * stub/functionId registration. Used by hle-lib for relocated-prologue
     * trampolines (Guarded Inner-Loop HLE): the caller writes the bytes and
     * guest code executes them like any other thunk-region code. Returns the
     * base address of the reserved area.
     */
    allocateRawCodeArea(sizeBytes: number): number {
        return this.bumpCode(Math.ceil(sizeBytes / 16) * 16);
    }

    getStubById(id: number): ThunkStub | undefined {
        return this.stubs.get(id);
    }

    getStubByAddress(address: number): ThunkStub | undefined {
        return this.addressToStub.get(address);
    }

    /**
     * Record that a registered stub's bytes were replaced by a JMP to `target`. The
     * registration stays — the address is still that export's entry point — but a
     * diagnostic that reads the stub to explain the bytes would otherwise name an OUT trap
     * that no longer runs there.
     */
    markStubRedirected(address: number, target: number): boolean {
        const stub = this.addressToStub.get(address >>> 0);
        if (!stub) return false;
        stub.redirectedTo = target >>> 0;
        return true;
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
     *
     * The fallback exists for the undecorated/decorated spelling gap, and it must not
     * reach ACROSS decorations: `@N` is the argument list, not spelling. `_AIL_pause_stream@4`
     * (MSS 3.x: one argument, always pauses) and `@8` (HSTREAM + onoff) are different
     * functions, and letting one bind into the other's stub silently drops an argument —
     * GTA III's per-frame `AIL_pause_stream(stream, 0)`, which means RESUME, reached the
     * 1-arg handler and paused the cutscene line it was keeping alive.
     */
    findStubsByName(dllName: string, functionName: string): ThunkStub[] {
        const exact = this.exactNameToStubs.get(buildQualifiedThunkKey(dllName, functionName));
        if (exact && exact.length > 0) {
            return exact;
        }
        const normalized = this.normalizedNameToStubs.get(buildNormalizedThunkKey(dllName, functionName)) ?? [];
        const want = thunkDecoration(functionName);
        if (want === null) return normalized;
        return normalized.filter((s) => {
            const got = thunkDecoration(s.functionName);
            return got === null || got === want;
        });
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
        // Align to 16 bytes for consistency. Bumped through bumpCode because the area shares
        // 4 KiB pages with real stubs — page-granular JIT invalidation covers both.
        return this.bumpCode((sizeInBytes + 15) & ~15);
    }

    /**
     * Get current address (for debugging memory layout)
     */
    getCurrentAddress(): number {
        return this.currentAddress;
    }
}

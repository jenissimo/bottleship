/**
 * Patch guest function entries with a 5-byte `E9 rel32` JMP to our callout stub.
 *
 * Workflow per hooked function:
 *   1. Allocate a thunk stub via the existing ThunkGenerator (OUT+RET N).
 *   2. Write the stub bytes into THUNK_CODE memory.
 *   3. Register the handler with ThunkDispatcher under the virtual module
 *      '<libId>-hle' so the existing dispatch table does the work.
 *   4. Save the first 16 bytes of the target function for diagnostics.
 *   5. Overwrite the first 5 bytes of the target with `E9 rel32` pointing to
 *      the stub, and pad up to 6 more bytes with NOP (so any crash dump of
 *      the patched prologue is obvious).
 *   6. Invalidate v86 JIT cache for the patched range so the prior-compiled
 *      block is re-compiled with the JMP.
 *
 * We never restore the original bytes at runtime. Patches are one-way by design
 * — there is no need for a length-disassembler because we never branch back into
 * the overwritten bytes.
 */

import { Logger, LogCategory } from '../logger';
import { Mem } from '../memory/mem-accessor';
import { invalidateGuestCode, writeGuestCode } from '../memory/guest-code';
import type { LoadedPEModule } from '../module-registry';
import type { ThunkDispatcher, ThunkImplementation } from '../thunking/thunk-dispatcher';
import type { ThunkGenerator } from '../thunking/thunk-generator';
import type { EntryFilterInfo, PatchHandle } from './types';

export interface PatchContext {
    dispatcher: ThunkDispatcher;
    thunkGenerator: ThunkGenerator;
    getMemory: () => Uint8Array | null;
}

export interface PatchRequest {
    libId: string;
    functionName: string;
    /** Absolute guest address of the target function entry. */
    targetAddress: number;
    /** cdecl = caller cleans stack; stdcall = callee RET N. */
    callingConvention: 'cdecl' | 'stdcall';
    /** Number of 4-byte arguments — used to derive RET N for stdcall when stackCleanupBytes omitted. */
    argCount?: number;
    /** Explicit callee stack cleanup (thiscall RET N). Prefer over argCount*4 when struct-by-value args exist. */
    stackCleanupBytes?: number;
    /** Handler invoked when the guest jumps into our stub. */
    handler: ThunkImplementation;
    /** Bytes to overwrite at target (default 11: E9 + rel32 + NOP pad). Use 5 for tight export thunks. */
    overwriteBytes?: number;
    /**
     * Build a relocated-prologue trampoline of this many bytes (5..15, at an
     * instruction boundary — RE-measured). The bytes must pass
     * `validatePrologueBytes`; on failure the whole patch is REFUSED (loud)
     * rather than hooked without a working original-call path.
     */
    prologueLen?: number;
    /**
     * Guest-side entry filter codegen (see HookedFunction.entryFilter). When
     * present, the patch JMP targets the filter's returned address instead of
     * the OUT stub; requires prologueLen (the trampoline is the decline path).
     * A null return refuses the whole patch.
     */
    entryFilter?: (info: EntryFilterInfo) => number | null;
}

/**
 * Conservative position-independence check for relocated prologue bytes.
 * Decodes ONLY a whitelisted subset of instructions that occur in real
 * MSVC/EA function prologues — anything else (including every EIP-relative
 * branch) returns a reason string and the patch is refused. Extend the table
 * when a legitimate hook needs a new prologue shape; never loosen it to a
 * blind byte scan (immediates would false-positive).
 *
 * Exported for unit tests.
 */
export function validatePrologueBytes(bytes: Uint8Array): string | null {
    if (bytes.length < 5) return `prologueLen ${bytes.length} < 5 (JMP does not fit)`;
    if (bytes.length > 15) return `prologueLen ${bytes.length} > 15`;
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        const b1 = bytes[i + 1];
        // push ebp / push r32
        if (b === 0x55 || (b >= 0x50 && b <= 0x57)) { i += 1; continue; }
        // mov ebp, esp (both encodings)
        if (b === 0x8B && b1 === 0xEC) { i += 2; continue; }
        if (b === 0x89 && b1 === 0xE5) { i += 2; continue; }
        // sub esp, imm8 / imm32
        if (b === 0x83 && b1 === 0xEC) { i += 3; continue; }
        if (b === 0x81 && b1 === 0xEC) { i += 6; continue; }
        // and esp, imm8 (stack align)
        if (b === 0x83 && b1 === 0xE4) { i += 3; continue; }
        // push imm8 / imm32
        if (b === 0x6A) { i += 2; continue; }
        if (b === 0x68) { i += 5; continue; }
        // mov r32, [ebp+disp8] (argument loads: modrm 45/4D/55/5D/75/7D)
        if (b === 0x8B && (b1 === 0x45 || b1 === 0x4D || b1 === 0x55 || b1 === 0x5D || b1 === 0x75 || b1 === 0x7D)) {
            i += 3; continue;
        }
        // mov r32, [esp+disp8] (frameless argument loads: modrm /r=100 SIB 24)
        if (b === 0x8B && b1 !== undefined && (b1 & 0xC7) === 0x44 && bytes[i + 2] === 0x24) {
            i += 4; continue;
        }
        // mov eax, moffs32 (absolute — position-independent)
        if (b === 0xA1) { i += 5; continue; }
        // SEH prologue: mov eax, fs:[imm32]
        if (b === 0x64 && b1 === 0xA1) { i += 6; continue; }
        // xor r32, r32 (33 /r reg-reg)
        if (b === 0x33 && b1 !== undefined && (b1 & 0xC0) === 0xC0) { i += 2; continue; }
        return `unsupported prologue byte 0x${b.toString(16)} at +${i} — extend validatePrologueBytes if this is a real, position-independent instruction`;
    }
    if (i !== bytes.length) return `prologueLen ${bytes.length} splits an instruction (decoder landed at +${i})`;
    return null;
}

/**
 * Apply a single patch. Returns the PatchHandle on success, or null if the
 * environment isn't ready (e.g. memory not yet available).
 */
export function applyPatch(ctx: PatchContext, req: PatchRequest): PatchHandle | null {
    const mem = ctx.getMemory();
    if (!mem) {
        Logger.warn(LogCategory.SYSTEM,
            `[HLE-lib] applyPatch: guest memory not yet available, skipping ${req.libId}:${req.functionName}`);
        return null;
    }

    // With a trampoline, bytes [prologueLen, overwriteBytes) would be clobbered
    // AND re-entered (the trampoline jumps back to target+prologueLen) — NOP-
    // padding there executes in place of real instructions and silently corrupts
    // the original-call path (root-caused 2026-07-10: the EAGL converter's
    // `mov eax,[ebp+8]` at +6 became NOPs → garbage EAX → #PF at +0x15).
    // Default to the bare 5-byte JMP when a trampoline exists; refuse explicit
    // requests that violate the invariant. Checked FIRST — nothing is mutated yet.
    const overwriteBytes = req.overwriteBytes ?? (req.prologueLen !== undefined ? 5 : 11);
    if (req.prologueLen !== undefined && overwriteBytes > req.prologueLen) {
        Logger.error(LogCategory.SYSTEM,
            `[HLE-lib] applyPatch: overwriteBytes ${overwriteBytes} > prologueLen ${req.prologueLen} ` +
            `for ${req.libId}:${req.functionName} — the trampoline would re-enter clobbered bytes; refusing`);
        return null;
    }

    const virtualModuleId = `${req.libId}-hle`;

    // 1. Allocate the callout stub. ThunkGenerator returns {address, code}.
    let stubAddress = 0;
    let stubCode: Uint8Array | null = null;
    try {
        const allocated = ctx.thunkGenerator.allocateOneStub(
            virtualModuleId,
            req.functionName,
            req.argCount,
            req.callingConvention,
            req.stackCleanupBytes,
        );
        stubAddress = allocated.address;
        stubCode = allocated.code;
    } catch (e) {
        Logger.error(LogCategory.SYSTEM,
            `[HLE-lib] applyPatch: allocateOneStub failed for ${req.libId}:${req.functionName}: ${e}`);
        return null;
    }

    // 2. Write stub bytes to guest memory.
    if (stubAddress + stubCode.length > mem.length) {
        Logger.error(LogCategory.SYSTEM,
            `[HLE-lib] applyPatch: stub 0x${stubAddress.toString(16)} overruns memory`);
        return null;
    }
    writeGuestCode(mem, stubCode, stubAddress);

    // 3. Register handler under the virtual module id.
    ctx.dispatcher.register(virtualModuleId, req.functionName, req.handler);
    // Run pending registrations so the argCount / stackCleanup tables are populated.
    ctx.dispatcher.applyPendingRegistrations?.();

    // 4. Save original 16 bytes for diagnostics, then patch target prologue.
    const originalBytes = mem.slice(req.targetAddress, req.targetAddress + 16);

    // 4b. Relocated-prologue trampoline (Guarded Inner-Loop HLE): original
    //     prologue bytes + JMP back to target+prologueLen. Built BEFORE the
    //     entry is clobbered; refusal aborts the whole patch — a shadow hook
    //     without an original-call path is worse than no hook.
    let trampolineAddress: number | undefined;
    if (req.prologueLen !== undefined) {
        const pl = req.prologueLen;
        const prologue = originalBytes.slice(0, pl);
        const reason = validatePrologueBytes(prologue);
        if (reason) {
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] applyPatch: trampoline refused for ${req.libId}:${req.functionName}: ${reason} ` +
                `(bytes: ${Array.from(prologue).map(x => x.toString(16).padStart(2, '0')).join(' ')})`);
            return null;
        }
        trampolineAddress = ctx.thunkGenerator.allocateRawCodeArea(pl + 5);
        if (trampolineAddress + pl + 5 > mem.length) {
            Logger.error(LogCategory.SYSTEM, `[HLE-lib] applyPatch: trampoline 0x${trampolineAddress.toString(16)} overruns memory`);
            return null;
        }
        writeGuestCode(mem, prologue, trampolineAddress);
        const back = (req.targetAddress + pl - (trampolineAddress + pl + 5)) | 0;
        mem[trampolineAddress + pl]     = 0xE9;
        mem[trampolineAddress + pl + 1] = back & 0xFF;
        mem[trampolineAddress + pl + 2] = (back >> 8)  & 0xFF;
        mem[trampolineAddress + pl + 3] = (back >> 16) & 0xFF;
        mem[trampolineAddress + pl + 4] = (back >> 24) & 0xFF;
        invalidateGuestCode(trampolineAddress, pl + 5);
    }

    // 4c. Guest-side entry filter (partial hooks): emit the classifier and
    //     point the patch JMP at it. Requires the trampoline (decline path).
    let jmpTarget = stubAddress;
    if (req.entryFilter) {
        if (trampolineAddress === undefined) {
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] applyPatch: entryFilter for ${req.libId}:${req.functionName} requires prologueLen ` +
                `(the trampoline is its decline path); refusing`);
            return null;
        }
        let filterAddr: number | null = null;
        try {
            filterAddr = req.entryFilter({
                mem,
                targetAddress: req.targetAddress,
                stubAddress,
                trampolineAddress,
                allocCode: (size: number) => ctx.thunkGenerator.allocateRawCodeArea(size),
            });
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[HLE-lib] applyPatch: entryFilter threw for ${req.libId}:${req.functionName}: ${e}`);
            filterAddr = null;
        }
        if (filterAddr === null || filterAddr <= 0 || filterAddr >= mem.length) {
            Logger.error(LogCategory.SYSTEM,
                `[HLE-lib] applyPatch: entryFilter refused/invalid for ${req.libId}:${req.functionName} — aborting patch`);
            return null;
        }
        jmpTarget = filterAddr;
    }

    // 5. E9 rel32 — relative to (target + 5) per x86 semantics.
    const rel32 = (jmpTarget - (req.targetAddress + 5)) | 0;
    mem[req.targetAddress]     = 0xE9;
    mem[req.targetAddress + 1] = rel32 & 0xFF;
    mem[req.targetAddress + 2] = (rel32 >> 8)  & 0xFF;
    mem[req.targetAddress + 3] = (rel32 >> 16) & 0xFF;
    mem[req.targetAddress + 4] = (rel32 >> 24) & 0xFF;
    // Pad with NOPs only when there is room — Galaxy export thunks are 5-byte jmp chains.
    // (overwriteBytes validated against prologueLen at the top of this function.)
    for (let i = 5; i < overwriteBytes; i++) {
        mem[req.targetAddress + i] = 0x90;
    }

    // 6. Drop the cached pre-patch block for the rewritten prologue. Covering the full
    //    16-byte range is cheap and defensive.
    if (!invalidateGuestCode(req.targetAddress, 16)) {
        Logger.warn(LogCategory.SYSTEM,
            `[HLE-lib] applyPatch: no wasm instance, JIT invalidation deferred for ${req.libId}:${req.functionName}`);
    }

    const stubInfo = ctx.thunkGenerator.getStubByAddress?.(stubAddress);
    const functionId = stubInfo?.functionId ?? -1;

    return {
        libId: req.libId,
        functionName: req.functionName,
        targetAddress: req.targetAddress,
        stubAddress,
        originalBytes,
        functionId,
        trampolineAddress,
    };
}

// Resolution of an HLE (thunked) DLL export by name.
//
// HLE modules have no PE image, so their exports live in the ThunkGenerator's
// stub registry, NOT in ModuleRegistry (which only knows loaded PE images).
// Every entry point that hands a function pointer to the guest — kernel32's
// GetProcAddress and opengl32's wglGetProcAddress alike — MUST resolve through
// here, or the two disagree and a guest that cross-checks them sees an API it
// was told exists but cannot call.

import { System } from '../system';
import { APIRegistry } from '../api-registry';
import { Logger, LogCategory } from '../logger';
import { writeGuestCode } from '../memory/guest-code';
import { hleImageExportAddress } from '../hle-module-images';

/**
 * Resolve a thunked DLL export by name, creating an on-demand stub when needed.
 * Extension-only entry points are never in the boot-time stub set, so the
 * on-demand path is the normal case for them, not a fallback.
 *
 * Returns 0 when the export is genuinely not provided — callers must propagate
 * that as NULL rather than inventing a pointer.
 */
export function resolveHleExportAddress(
    dispatcher: any,
    dllName: string,
    exportName: string,
    verbose = false,
): number {
    const tg = dispatcher?.thunkGenerator;
    if (!tg) return 0;

    // An export with no failure encoding (see UnimplementedReturn "unresolvable") cannot
    // be handed out: the guest would take the value as data. NULL is the honest answer and
    // the one a Windows without the function gives — the caller's own fallback then runs.
    if (APIRegistry.getInstance().getUnimplementedReturnClass(dllName, exportName) === 'unresolvable') {
        Logger.log(LogCategory.KERNEL32,
            `resolveHleExport: ${dllName}:${exportName} is not implemented and has no failure value — ` +
            `answering NULL, as a Windows without the export would`);
        return 0;
    }

    // The IAT and GetProcAddress must hand out the SAME address, or a wrapper that scans
    // the import table for the pointer it was given finds nothing and installs no hook.
    // hleExportBindingAddress is that one decision; the arena stub below is only for an
    // export it does not cover (no image, or a name only the on-demand path can build).
    const bound = hleExportBindingAddress(
        tg, dllName, exportName,
        !(globalThis as { __noImageIatBinding?: boolean }).__noImageIatBinding);
    if (bound !== undefined) return bound >>> 0;

    const byQualifiedName = tg.getExportAddress(`${dllName}:${exportName}`);
    if (byQualifiedName !== undefined) return byQualifiedName >>> 0;

    const system = System.getInstance();
    const apiRegistry = APIRegistry.getInstance();
    const inApi = apiRegistry.hasExportedFunction(dllName, exportName);
    const pendingKey = `${dllName}:${exportName}`.toLowerCase();
    const hasPending = !!dispatcher?.pendingRegistrations?.has(pendingKey);
    if (!apiRegistry.hasModule(dllName) && !hasPending) return 0;

    // Signature metadata may fall back across descriptors for ABI recovery, but export
    // ownership may not: GetProcAddress is scoped by HMODULE.
    if (!inApi && !hasPending && !apiRegistry.hasModuleFunctionSignature(dllName, exportName)) {
        return 0;
    }

    const argCount = apiRegistry.getArgCount(dllName, exportName);
    const stackCleanupBytes = apiRegistry.getStackCleanupBytes(dllName, exportName);
    if (!inApi && !hasPending && argCount === undefined && stackCleanupBytes === undefined) {
        return 0;
    }

    const callingConv = apiRegistry.getCallingConvention(dllName, exportName);
    try {
        const { address: stubAddr, code } = tg.allocateOneStub(
            dllName,
            exportName,
            argCount ?? 0,
            callingConv || 'stdcall',
            stackCleanupBytes ?? 0,
        );

        const memArray = system.process?.getCurrentMemory();
        if (memArray && stubAddr + code.length <= memArray.length) {
            writeGuestCode(memArray, code, stubAddr);
            if (typeof dispatcher.bindPendingRegistrationsForFunctionId === "function") {
                dispatcher.bindPendingRegistrationsForFunctionId(tg.getStubByAddress(stubAddr)?.functionId ?? 0);
            } else {
                dispatcher.applyPendingRegistrations();
            }
            if (verbose) {
                Logger.verbose(
                    LogCategory.KERNEL32,
                    `resolveHleExport: created stub ${dllName}:${exportName} at 0x${stubAddr.toString(16)}`
                );
            }
            Logger.log(
                LogCategory.KERNEL32,
                `resolveHleExport: created on-demand stub ${dllName}:${exportName} -> 0x${stubAddr.toString(16)}`
            );
            return stubAddr >>> 0;
        }
        Logger.warn(
            LogCategory.KERNEL32,
            `resolveHleExport: stub ${dllName}:${exportName} at 0x${stubAddr.toString(16)} exceeds guest mem (len=${memArray?.length ?? 0})`
        );
    } catch (e) {
        Logger.warn(LogCategory.KERNEL32, `resolveHleExport: stub creation failed for ${dllName}:${exportName}: ${e}`);
    }
    return 0;
}

/**
 * The ONE address an HLE export has: what the PE loader writes into an importer's IAT
 * and what GetProcAddress hands back. Single owner of the precedence, so the two cannot
 * be decided differently in two places — that divergence is the whole bug class this
 * exists for (tools/validate-data-export-binding.ts keeps hleImageExportAddress private
 * to this decision).
 *
 * A data export wins over the in-image body. An export declared BOTH in the module's API
 * table and through registerDataExport gets a call stub in the image, and for a name that
 * is not a plain call that stub is wrong, not merely a second address: msvcrt's _EH_prolog
 * rewrites its CALLER's frame (links FS:[0], moves EBP, returns through an address it
 * placed on the stack), so a stub that returns normally leaves the SEH chain and EBP
 * broken and the epilogue unwinds into nothing. qsort/bsearch are native x86 for the same
 * reason — they call back into guest code. The registered address is the real body.
 *
 * `allowImage` is the PE loader's A/B switch (__noImageIatBinding) and nothing else: it
 * takes the image body out of the answer, restoring the pre-image binding. A data export
 * is not part of that experiment — it has always won — and an instrument asking what the
 * one address IS must not pass it, or it stops being able to see the experiment.
 *
 * Returns undefined when neither exists, so callers keep their own fallback.
 */
export function hleExportBindingAddress(
    thunkGenerator: any,
    dllName: string,
    exportName: string,
    allowImage = true,
): number | undefined {
    const dataAddr = thunkGenerator?.getDataExportAddress?.(dllName, exportName);
    if (dataAddr !== undefined) return dataAddr >>> 0;
    return allowImage ? hleImageExportAddress(dllName, exportName) : undefined;
}

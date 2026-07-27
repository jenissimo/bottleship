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

    const dataAddr = tg.getDataExportAddress(dllName, exportName);
    if (dataAddr !== undefined) return dataAddr >>> 0;

    const byQualifiedName = tg.getExportAddress(`${dllName}:${exportName}`);
    if (byQualifiedName !== undefined) return byQualifiedName >>> 0;
    const byShortName = tg.getExportAddress(exportName);
    if (byShortName !== undefined) return byShortName >>> 0;

    const system = System.getInstance();
    const apiRegistry = APIRegistry.getInstance();
    const inApi = apiRegistry.hasExportedFunction(dllName, exportName);
    const pendingKey = `${dllName}:${exportName}`.toLowerCase();
    const hasPending = !!dispatcher?.pendingRegistrations?.has(pendingKey);
    if (!apiRegistry.hasModule(dllName) && !hasPending) return 0;

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

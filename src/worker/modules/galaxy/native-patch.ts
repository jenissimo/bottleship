import { Mem } from '../../core/memory/mem-accessor';
import type { LoadedPEModule } from '../../core/module-registry';
import type { Process } from '../../core/process';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { Logger, LogCategory } from '../../core/logger';
import { applyPatch, type PatchContext } from '../../core/hle-lib/lib-patcher';
import {
    detectGalaxyIntegration,
    isGalaxyModule,
    isGalaxyHleEnabled,
    resolveExportBodyRva,
    selectGalaxyProfile,
    verifyProfileInitPrologue,
} from './detect';
import { GALAXY_EXPORT } from './export-names';
import { resolveGalaxyPatchPlan } from './patch-exports';
import { GALAXY_STACK_CLEANUP } from './stack-cleanup';
import { probeGalaxyMixerKernels } from './mixer-probe';
import type { GalaxyContext } from './context';
import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

function resolveExportAddr(module: LoadedPEModule, mangledName: string): number | null {
    const lower = mangledName.toLowerCase();
    for (const [k, v] of module.exports) {
        if (k.toLowerCase() === lower) return v;
    }
    return null;
}

export function shouldPatchGalaxyNative(module: LoadedPEModule): boolean {
    if (!isGalaxyModule(module)) return false;
    if (!isGalaxyHleEnabled()) return false;
    const cfg = EmulatorConfig.getInstance().hleLibs as { galaxy?: { enable?: boolean } };
    if (cfg.galaxy && cfg.galaxy.enable === false) return false;
    if (detectGalaxyIntegration(module) !== 'UE1_GALAXY') return false;
    const profile = selectGalaxyProfile(module);
    if (!profile) return false;
    return true;
}

export function patchGalaxyNativeModule(
    process: Process,
    module: LoadedPEModule,
    ctx: GalaxyContext,
    handlerMap: Record<string, ThunkImplementation>,
): boolean {
    if (!shouldPatchGalaxyNative(module)) return false;

    const integration = detectGalaxyIntegration(module);
    const profile = selectGalaxyProfile(module);
    if (!profile) return false;

    const initExportAddr = resolveExportAddr(module, GALAXY_EXPORT.init);
    if (initExportAddr) {
        const initExportRva = initExportAddr - module.baseAddress;
        if (!verifyProfileInitPrologue(module, profile, initExportRva)) {
            Logger.warn(LogCategory.SYSTEM, `[Galaxy] Init prologue mismatch — skipping HLE patch (${profile.id})`);
            return false;
        }
    }

    ctx.activeProfile = profile;
    ctx.galaxyModule = module;

    const galaxyCfg = EmulatorConfig.getInstance().hleLibs.galaxy ?? {};
    const patchPlan = resolveGalaxyPatchPlan(galaxyCfg);

    const patchCtx: PatchContext = {
        dispatcher: process.dispatcher,
        thunkGenerator: process.thunkGenerator,
        getMemory: () => process.getCurrentMemory(),
    };

    const patchedExports: string[] = [];

    for (const exportName of patchPlan.exports) {
        const handler = handlerMap[exportName];
        if (!handler) continue;
        const exportAddr = resolveExportAddr(module, exportName);
        if (!exportAddr) continue;

        // HP Galaxy exports are 5-byte jmp thunks packed back-to-back — never patch
        // the thunks (11-byte overwrite clobbers neighbors → #UD at image+0xc).
        // Patch the resolved function body; vtable/export thunks still jmp into it.
        const exportRva = exportAddr - module.baseAddress;
        const bodyRva = resolveExportBodyRva(module, exportRva);
        const bodyAddr = module.baseAddress + bodyRva;

        const stackCleanup = GALAXY_STACK_CLEANUP[exportName] ?? 0;
        const handle = applyPatch(patchCtx, {
            libId: 'galaxy',
            functionName: exportName,
            targetAddress: bodyAddr,
            callingConvention: 'stdcall',
            stackCleanupBytes: stackCleanup,
            handler,
            overwriteBytes: 5,
        });
        if (handle) {
            patchedExports.push(exportName);
            Logger.verbose(
                LogCategory.SYSTEM,
                `[Galaxy] patched ${exportName} exportRva=0x${exportRva.toString(16)} bodyRva=0x${bodyRva.toString(16)} stub=0x${handle.stubAddress.toString(16)}`,
            );
        }
    }

    ctx.patchStats = {
        patchedExports,
        patchedVtableSlots: 0,
        profile: profile.id,
        integration,
        mode: patchPlan.mode,
        mixerProbe: null,
    };

    Logger.log(
        LogCategory.SYSTEM,
        `[Galaxy] HLE patched ${patchedExports.length} export bodies (${profile.id}, mode=${patchPlan.mode})`,
    );
    return patchedExports.length > 0;
}

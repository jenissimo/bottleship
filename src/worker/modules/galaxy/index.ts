import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import type { LoadedPEModule } from '../../core/module-registry';
import { createGalaxyContext, type GalaxyContext } from './context';
import { createGalaxyHandlers } from './handlers';
import { patchGalaxyNativeModule, shouldPatchGalaxyNative } from './native-patch';
import { handleAudioEnded, resetGalaxyPlayback } from './playback';
import { probeGalaxyMixerKernels } from './mixer-probe';

export class Galaxy implements IModule {
    name = 'galaxy';
    exports: Record<string, ThunkImplementation> = {};
    private ctx!: GalaxyContext;

    getContext(): GalaxyContext {
        return this.ctx;
    }

    initialize(process: Process): void {
        this.ctx = createGalaxyContext(process);
        this.exports = createGalaxyHandlers(this.ctx);
        Logger.log(LogCategory.SYSTEM, `[Galaxy] module initialized (${Object.keys(this.exports).length} handlers)`);
    }

    reset(): void {
        resetGalaxyPlayback();
        // Handlers close over the ctx object — mutate in place, do not replace.
        const process = this.ctx.process;
        Object.assign(this.ctx, createGalaxyContext(process));
    }

    /** Called from pe-loader after native Galaxy.dll is registered. */
    static onNativeModuleLoaded(process: Process, module: LoadedPEModule): void {
        const inst = process.getModule('galaxy') as Galaxy | undefined;
        if (!inst) return;
        const ctx = inst.getContext();
        if (!shouldPatchGalaxyNative(module)) return;
        patchGalaxyNativeModule(process, module, ctx, inst.exports);
    }

    handleAudioEnded(id: number): void {
        handleAudioEnded(id);
        for (const entry of this.ctx.sounds.values()) {
            if (entry.audioId === id) entry.isPlaying = false;
        }
    }

    /** Manual mixer kernel probe (also runs automatically from HLE Update). */
    probeMixer() {
        const mod = this.ctx.galaxyModule;
        const profile = this.ctx.activeProfile;
        if (!mod || !profile) return null;
        const probe = probeGalaxyMixerKernels(mod, profile);
        if (probe) {
            this.ctx.mixerProbe = probe;
            if (this.ctx.patchStats) this.ctx.patchStats.mixerProbe = probe;
        }
        return probe ?? this.ctx.mixerProbe;
    }

    getPatchStats() {
        return this.ctx.patchStats;
    }
}

export { shouldPatchGalaxyNative, patchGalaxyNativeModule };

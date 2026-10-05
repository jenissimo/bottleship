import type { LoadedPEModule } from '../../core/module-registry';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { Logger, LogCategory } from '../../core/logger';
import { Mem } from '../../core/memory/mem-accessor';
import { resolveExportBodyRva } from '../../core/hle-lib/lib-patcher';
import { HP344_PROFILE } from './profiles/hp-344';
import { UT348_PROFILE } from './profiles/ut-348';
import type { GalaxyProfile } from './profiles/types';

export type GalaxyIntegrationKind = 'UE1_GALAXY' | 'FLAT_C_GALAXY' | 'UNKNOWN';

const UE1_MIN_MATCHES = 8;

const PROFILES: GalaxyProfile[] = [HP344_PROFILE, UT348_PROFILE];

export function isGalaxyModule(module: { name: string; path?: string }): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/');
    for (const raw of [module.path, module.name]) {
        if (!raw) continue;
        const n = norm(raw);
        if (n.endsWith('galaxy.dll') || n.endsWith('/galaxy')) return true;
    }
    return false;
}

export function detectGalaxyIntegration(module: LoadedPEModule): GalaxyIntegrationKind {
    const exportNames = Array.from(module.exports.keys());
    let ueMatches = 0;
    let flatMatches = 0;

    for (const name of exportNames) {
        if (name.includes('ugalaxyaudiosubsystem')) ueMatches++;
        if (/^(_)?galaxy/i.test(name) && !name.startsWith('?')) flatMatches++;
    }

    if (ueMatches >= UE1_MIN_MATCHES) return 'UE1_GALAXY';
    if (flatMatches >= 3) return 'FLAT_C_GALAXY';

    Logger.warn(
        LogCategory.SYSTEM,
        `[Galaxy] unknown integration for ${module.name} (${exportNames.length} exports); sample: ${exportNames.slice(0, 4).join(', ')}`,
    );
    return 'UNKNOWN';
}

export { resolveExportBodyRva };

export function verifyBannerNeedle(module: LoadedPEModule, needle: string): boolean {
    if (!needle) return false;
    const base = module.baseAddress;
    const end = base + module.size;
    const bytes = new TextEncoder().encode(needle);
    outer: for (let addr = base; addr + bytes.length <= end; addr++) {
        for (let i = 0; i < bytes.length; i++) {
            if ((Mem.readUint8(addr + i) ?? 0) !== bytes[i]!) continue outer;
        }
        return true;
    }
    return false;
}

export function selectGalaxyProfile(module: LoadedPEModule): GalaxyProfile | null {
    const fileSize = module.fileSize ?? module.size;
    const candidate = PROFILES.find((p) => p.dllSize === fileSize);
    if (!candidate) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] no profile for fileSize=${fileSize} — fail-closed`);
        return null;
    }
    if (!verifyBannerNeedle(module, candidate.bannerNeedle)) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] banner "${candidate.bannerNeedle}" not found — fail-closed (${candidate.id})`);
        return null;
    }
    return candidate;
}

export function verifyProfileInitPrologue(module: LoadedPEModule, profile: GalaxyProfile, initExportRva: number): boolean {
    const bodyRva = resolveExportBodyRva(module, initExportRva);
    const bodyAddr = module.baseAddress + bodyRva;
    for (let i = 0; i < profile.initPrologue.length; i++) {
        if ((Mem.readUint8(bodyAddr + i) ?? 0) !== profile.initPrologue[i]) {
            Logger.warn(
                LogCategory.SYSTEM,
                `[Galaxy] Init prologue mismatch @0x${bodyAddr.toString(16)}+${i} (expected ${candidateByte(profile.initPrologue[i])})`,
            );
            return false;
        }
    }
    return true;
}

function candidateByte(b: number | undefined): string {
    return `0x${(b ?? 0).toString(16).padStart(2, '0')}`;
}

export function isGalaxyHleEnabled(): boolean {
    const cfg = EmulatorConfig.getInstance().hleLibs as { enable: boolean; galaxy?: { enable?: boolean } };
    if (cfg.galaxy?.enable === true) return true;
    if (cfg.galaxy?.enable === false) return false;
    return cfg.enable;
}

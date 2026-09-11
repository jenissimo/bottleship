/**
 * UE1 render-device probe — the child's config side effect.
 *
 * The engine tests a renderer by launching its OWN image with
 * `testrendev=<Class> log=Detected.log`. That child writes
 * `[<Class>] DescFlags=RDDESCF_Incompatible` BEFORE constructing the device (so a
 * driver that faults during Init stays excluded), the device ORs in
 * RDDESCF_Certified when its Init succeeds, and the child finally creates an EMPTY
 * `Detected.ini` purely as the "I finished" marker the parent polls for. The parent
 * never reads that file: it reads DescFlags out of the ACTIVE config, and its
 * first-run wizard offers a class only when the flag says Certified (or the class'
 * Autodetect DLL is present, or it is the built-in software renderer).
 *
 * We cannot run a second guest process, so the probe is virtual — which makes the
 * DescFlags write OUR responsibility. Without it the wizard lists nothing but
 * "Software Rendering" and the game commits to the software rasterizer for good.
 * Writing Certified for the device we implement, and Incompatible for the ones we do
 * not, is exactly the outcome the real probe would have reached on this machine.
 */

import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { invalidateIniCache } from './profile';
import {
    parseUe1RenderProbeDevice,
    setUe1RenderDeviceDescFlags,
    RDDESCF_CERTIFIED,
    RDDESCF_INCOMPATIBLE,
    UE1_RENDER_DEVICE,
} from '../../runtime/filesystem/ue1-firstrun';

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;

/** Configs a probe result must land in: the engine's active one, plus the learned
 *  user-dir copy when the exe redirects its config elsewhere. */
function probeConfigPaths(): string[] {
    const config = EmulatorConfig.getInstance();
    const paths: string[] = [];
    if (config.ue1ConfigIni) paths.push(config.ue1ConfigIni);
    if (config.ue1UserDir && config.ue1ConfigIni) {
        const base = config.ue1ConfigIni.split(/[\\/]/).pop()!;
        const inUserDir = `${config.ue1UserDir}\\${base}`;
        if (inUserDir.toLowerCase() !== config.ue1ConfigIni.toLowerCase()) paths.push(inUserDir);
    }
    return paths;
}

/**
 * Apply the probe's config side effect for `commandLine`. No-op for a non-UE1 bundle,
 * a command line without `testrendev=`, or a config we cannot read whole — a config we
 * could not read is a config we must not rewrite (see pinGuestEngineIni).
 */
export async function applyUe1RenderProbeResult(commandLine: string): Promise<void> {
    const config = EmulatorConfig.getInstance();
    if (!config.ue1) return;
    const device = parseUe1RenderProbeDevice(commandLine);
    if (!device) return;

    // Certified is a claim about OUR renderer: the D3D device is the one whose Init
    // would succeed here. Anything else (Glide, MeTaL, OpenGL, SGL) has no backing
    // implementation, and Incompatible is what its failed Init would have left.
    const flags = device.toLowerCase() === UE1_RENDER_DEVICE.toLowerCase()
        ? RDDESCF_CERTIFIED
        : RDDESCF_INCOMPATIBLE;

    const vfs = System.getInstance().fileSystem;
    for (const path of probeConfigPaths()) {
        try {
            const size = vfs.getFileSize(path);
            if (size <= 0) continue;
            const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) continue;
            const bytes = new Uint8Array(size);
            let got = 0;
            while (got < size) {
                const chunk = await vfs.read(handle, size - got);
                if (chunk.length === 0) break;
                bytes.set(chunk.subarray(0, Math.min(chunk.length, size - got)), got);
                got += chunk.length;
            }
            if (got < size) {
                Logger.warn(LogCategory.SYSTEM,
                    `UE1 probe: refusing to patch ${path} — read ${got} of ${size} bytes`);
                continue;
            }
            const text = new TextDecoder('utf-8').decode(bytes);
            const patched = setUe1RenderDeviceDescFlags(text, device, flags);
            if (patched === text) continue;

            const out = await vfs.open(path, GENERIC_WRITE, CREATE_ALWAYS);
            if (!out) continue;
            await vfs.write(out, new TextEncoder().encode(patched));
            await vfs.flushFile(out.path ?? path);
            invalidateIniCache(path);
            Logger.log(LogCategory.SYSTEM,
                `UE1 probe: ${device} -> DescFlags=${flags} in ${path}`);
        } catch (err) {
            Logger.warn(LogCategory.SYSTEM, `UE1 probe: patching ${path} failed: ${err}`);
        }
    }
}

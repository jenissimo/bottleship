/**
 * hleReport — what static-library HLE did to the loaded images: descriptor matches and their
 * patches, plus the CRT leaves replaced in place (native-leaves.ts). A native leaf runs as
 * guest code and has no hit counter, so each site is re-read instead: `intact:false` means
 * something rewrote the replacement after load and the slow original may be running again.
 */

import type { HarnessService } from "../service";
import { guestMem } from "../serialize";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { libHleManager } from "../../core/hle-lib/lib-hle-manager";
import { NATIVE_LEAVES } from "../../core/hle-lib/native-leaves";

export function registerHleCommands(svc: HarnessService): void {
    svc.register("hleReport", () => {
        const cfg = EmulatorConfig.getInstance().hleLibs;
        const mem = guestMem();
        const nativeLeaves = libHleManager.getNativeLeafSites().map((s) => {
            const leaf = NATIVE_LEAVES.find((l) => l.name === s.name && l.crt === s.crt);
            const intact = !!leaf && !!mem
                && leaf.replacement.every((b, i) => mem[s.address + i] === b);
            return { module: s.module, name: s.name, crt: s.crt, addr: "0x" + s.address.toString(16), intact };
        });
        return {
            enable: cfg.enable,
            logOnly: cfg.logOnly,
            killSwitch: (globalThis as { __noNativeLeaves?: boolean }).__noNativeLeaves === true,
            libs: libHleManager.getReport(),
            nativeLeaves,
        };
    });
}

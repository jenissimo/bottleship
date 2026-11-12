import { describe, expect, test, beforeEach } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import type { WgbManifest } from "../../src/worker/runtime/filesystem/wgb-loader";

function minimalManifest(emulator: WgbManifest["emulator"]): WgbManifest {
    return {
        formatVersion: 2,
        name: "test",
        entrypoint: "rom/game.exe",
        emulator,
    };
}

describe("EmulatorConfig manifest display modes", () => {
    beforeEach(() => {
        EmulatorConfig.getInstance().reset();
    });

    test("screenResolution.bpp alone does not strip 16bpp from supportedResolutions", () => {
        const cfg = EmulatorConfig.getInstance();
        cfg.applyFromManifest(
            minimalManifest({
                screenResolution: { width: 800, height: 600, bpp: 32 },
            }),
        );
        const bpps = new Set(cfg.supportedResolutions.map((m) => m.bpp));
        expect(bpps.has(16)).toBe(true);
        expect(bpps.has(32)).toBe(true);
        expect(cfg.supportedResolutions.some((m) => m.width === 640 && m.height === 480 && m.bpp === 16)).toBe(true);
    });

    test("default modes offer every 16bpp size at 8bpp too", () => {
        const modes = EmulatorConfig.getInstance().supportedResolutions;
        const has = (w: number, h: number, bpp: number) =>
            modes.some((m) => m.width === w && m.height === h && m.bpp === bpp);
        for (const m of modes.filter((m) => m.bpp === 16)) {
            expect(has(m.width, m.height, 8)).toBe(true);
        }
    });

    test("explicit supportedResolutions keeps author-listed depths", () => {
        const cfg = EmulatorConfig.getInstance();
        cfg.applyFromManifest(
            minimalManifest({
                screenResolution: { width: 800, height: 600, bpp: 32 },
                supportedResolutions: [
                    { width: 640, height: 480, bpp: 16 },
                    { width: 800, height: 600, bpp: 32 },
                ],
            }),
        );
        const bpps = new Set(cfg.supportedResolutions.map((m) => m.bpp));
        expect(bpps.has(16)).toBe(true);
        expect(bpps.has(32)).toBe(true);
    });
});

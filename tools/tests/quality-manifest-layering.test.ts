import { beforeEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { DEFAULT_QUALITY } from "../../src/worker/core/quality-config";
import type { QualityConfig } from "../../src/worker/core/quality-config";

const cfg = () => EmulatorConfig.getInstance();
/** The host always sends the WHOLE object, which is what made a single merged value unsafe. */
const wholePref = (over: Partial<QualityConfig>) => ({ ...DEFAULT_QUALITY, ...over });
const manifest = (quality: Partial<QualityConfig>) => ({ emulator: { quality } }) as never;

describe("quality layering: global user pref vs per-game manifest", () => {
    beforeEach(() => {
        cfg().reset();
        cfg().applyQuality({ ...DEFAULT_QUALITY });
    });

    test("the manifest override survives the host re-sending the pref after load", () => {
        // App.tsx re-sends the saved global pref on the load-"done" message, AFTER the
        // manifest has been applied. Merged into one value, that wiped every key the
        // manifest had set — which is why manifest.emulator.quality never took effect.
        cfg().applyQuality(wholePref({ anisotropy: 1 }));
        cfg().applyFromManifest(manifest({ anisotropy: 16 }));
        expect(cfg().quality.anisotropy).toBe(16);

        cfg().applyQuality(wholePref({ anisotropy: 1 }));
        expect(cfg().quality.anisotropy).toBe(16);
    });

    test("the pref still shows through on keys the manifest does not set", () => {
        cfg().applyQuality(wholePref({ anisotropy: 8, msaa: 4 }));
        cfg().applyFromManifest(manifest({ anisotropy: 16 }));
        expect(cfg().quality.anisotropy).toBe(16); // manifest wins where it speaks
        expect(cfg().quality.msaa).toBe(4);        // pref survives where it does not
    });

    test("a later pref change still moves a key the manifest left alone", () => {
        cfg().applyFromManifest(manifest({ anisotropy: 16 }));
        cfg().applyQuality({ msaa: 2 });
        expect(cfg().quality.msaa).toBe(2);
        expect(cfg().quality.anisotropy).toBe(16);
    });

    test("reset drops the manifest layer but keeps the user pref", () => {
        // reset() runs immediately before every applyFromManifest, so a surviving manifest
        // layer would apply the previous game's override to the next one.
        cfg().applyQuality(wholePref({ msaa: 4 }));
        cfg().applyFromManifest(manifest({ anisotropy: 16 }));

        cfg().reset();
        expect(cfg().quality.anisotropy).toBe(DEFAULT_QUALITY.anisotropy);
        expect(cfg().quality.msaa).toBe(4);
    });

    test("one game's override does not leak into the next", () => {
        cfg().applyQuality(wholePref({ anisotropy: 2 }));
        cfg().reset();
        cfg().applyFromManifest(manifest({ anisotropy: 16, brightness: 1.5 }));
        expect(cfg().quality.brightness).toBe(1.5);

        cfg().reset();
        cfg().applyFromManifest(manifest({ msaa: 2 }));
        expect(cfg().quality.brightness).toBe(DEFAULT_QUALITY.brightness);
        expect(cfg().quality.anisotropy).toBe(2); // back to the user's own value
        expect(cfg().quality.msaa).toBe(2);
    });

    test("a manifest value is still validated, not taken on trust", () => {
        cfg().applyFromManifest(manifest({ anisotropy: 999, msaa: 99, aspectMode: "nonsense" as never }));
        expect(cfg().quality.anisotropy).toBe(16);          // snapped to the top step
        expect(cfg().quality.msaa).toBe(4);                 // snapped to the top step
        expect(cfg().quality.aspectMode).toBe(DEFAULT_QUALITY.aspectMode); // rejected, not stored
    });
});

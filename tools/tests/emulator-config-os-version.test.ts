import { afterEach, describe, expect, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

describe("EmulatorConfig.osAtLeast", () => {
    const cfg = EmulatorConfig.getInstance();
    afterEach(() => cfg.reset());
    const at = (major: number, minor: number) => {
        cfg.osVersion = { ...cfg.osVersion, major, minor };
        return cfg.osAtLeast(6, 0);
    };

    test("Vista (6.0) and everything after it is at least 6.0", () => {
        for (const [major, minor] of [[6, 0], [6, 1], [6, 3], [10, 0]] as const) expect(at(major, minor)).toBe(true);
    });

    test("Win9x, NT 4, 2000, XP and Server 2003 are not", () => {
        for (const [major, minor] of [[4, 0], [4, 10], [4, 90], [5, 0], [5, 1], [5, 2]] as const) expect(at(major, minor)).toBe(false);
    });

    test("the minor version only counts within the same major", () => {
        cfg.osVersion = { ...cfg.osVersion, major: 6, minor: 0 };
        expect(cfg.osAtLeast(5, 2)).toBe(true);
        expect(cfg.osAtLeast(6, 1)).toBe(false);
        expect(cfg.osAtLeast(7, 0)).toBe(false);
    });

    test("the default (Win98) is not Vista", () => {
        cfg.reset();
        expect(cfg.osAtLeast(6, 0)).toBe(false);
        expect(cfg.osAtLeast(4, 10)).toBe(true);
    });
});

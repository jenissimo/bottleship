import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as guards from "../../src/worker/core/memory/address-guard";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { System } from "../../src/worker/core/system";
import { EmulatorConfig, VER_PLATFORM_WIN32_NT, VER_PLATFORM_WIN32_WINDOWS } from "../../src/worker/core/emulator-config-manager";

// Before the user-probe export exists, exercise the old raw guard as the RED
// behavior. Once implemented the same cases use the actual export; raw access
// has its own assertions, so globally forbidding LOW_MEM cannot make this green.
const user: typeof guards.isValidAddress =
    (guards as typeof guards & { isValidUserAddress?: typeof guards.isValidAddress }).isValidUserAddress ??
    guards.isValidAddress;

describe("Win32 user buffers versus raw boot/DOS memory", () => {
    let mem: Uint8Array;
    let space: AddressSpace;
    let savedProcess: System["process"];
    let savedVersion: EmulatorConfig["osVersion"];

    beforeEach(() => {
        const system = System.getInstance();
        savedProcess = system.process;
        savedVersion = { ...EmulatorConfig.getInstance().osVersion };
        mem = new Uint8Array(0x40000);
        space = new AddressSpace(() => mem);
        // Actual protected spans over the constructor's broad rw LOW_MEM bucket.
        space.registerRegion({ base: 0x18000, size: 0x1000, perms: "r", kind: "BORROWED",
            owner: "user-probe-test", allowOverlap: true, skipOverlapCheck: true });
        space.registerRegion({ base: 0x1a000, size: 0x1000, perms: "noaccess", kind: "BORROWED",
            owner: "user-probe-test", allowOverlap: true, skipOverlapCheck: true });
        system.process = { addressSpace: space, getCurrentMemory: () => mem } as NonNullable<System["process"]>;
    });
    afterEach(() => {
        System.getInstance().process = savedProcess;
        EmulatorConfig.getInstance().osVersion = savedVersion;
    });

    test("the explicit user-buffer export exists", () => {
        expect((guards as Record<string, unknown>).isValidUserAddress).toBeFunction();
    });

    test("numeric raw overload validates its full supplied extent with or without explicit permissions", () => {
        expect(space.validateRange(0x17ffc, 8, "rw")).toBe(false);
        expect(guards.isValidAddress(mem, 0x17ffc, 8, "rw")).toBe(false);
        expect(guards.isValidAddress(0x17ffc, 8, "rw")).toBe(false);
        expect(guards.isValidAddress(0x17ffc, 8)).toBe(false);
        expect(guards.isValidAddress(0x17ffc, 8, "r")).toBe(true);
        expect(guards.isValidAddress(0x19ffc, 8, "r")).toBe(false);
    });

    test("raw boot memory at 0x7c00 remains writable and readable", () => {
        const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
        expect(space.write(0x7c00, bytes)).toBe(4);
        expect(space.read(0x7c00, 4)).toEqual(bytes);
        expect(guards.isValidAddress(0x7c00, 4, "rw")).toBe(true);
        expect(guards.isValidAddress(mem, 0x7c00, 4, "rw")).toBe(true);
        expect(user(mem, 0x7c00, 4, "rw")).toBe(false);
        expect(space.getRegion(0x7c00)?.perms).toBe("rw");
    });

    test("nonempty user outputs below 64 KiB are rejected without changing raw mappings", () => {
        for (const address of [0, 1, 0x1000, 0x6ffc, 0x7c00, 0xfffc, 0xffff]) {
            expect(space.validateRange(address, 4, "rw")).toBe(true);
            expect(user(mem, address, 4, "rw")).toBe(false);
            expect(user(address, 4, "rw")).toBe(false);
        }
    });

    test("64 KiB boundary and the remaining LOW_MEM are valid user storage", () => {
        for (const address of [0x10000, 0x10001, 0x17000, 0x20000, mem.length - 4]) {
            expect(user(mem, address, 4, "rw")).toBe(true);
            expect(user(address, 4, "rw")).toBe(true);
        }
    });

    test("CPU compatibility version does not turn boot-owned bytes into Win32 output storage", () => {
        for (const platformId of [VER_PLATFORM_WIN32_WINDOWS, VER_PLATFORM_WIN32_NT]) {
            EmulatorConfig.getInstance().osVersion = { ...savedVersion, platformId };
            expect(guards.isValidAddress(mem, 0x7c00, 4, "rw")).toBe(true);
            expect(user(mem, 0x7c00, 4, "rw")).toBe(false);
            expect(user(mem, 0x10000, 4, "rw")).toBe(true);
        }
    });

    test("both user overloads retain read-only permissions across a page boundary", () => {
        expect(user(mem, 0x17ffc, 8, "rw")).toBe(false);
        expect(user(0x17ffc, 8, "rw")).toBe(false);
        expect(user(mem, 0x17ffc, 8, "r")).toBe(true);
        expect(user(0x17ffc, 8, "r")).toBe(true);
        expect(user(mem, 0x18000, 4, "rw")).toBe(false);
        expect(user(0x18000, 4, "r")).toBe(true);
    });

    test("NOACCESS cannot be hidden by the broad LOW_MEM region", () => {
        expect(user(mem, 0x19ffc, 8, "r")).toBe(false);
        expect(user(0x19ffc, 8, "r")).toBe(false);
        expect(user(mem, 0x1a000, 4, "rw")).toBe(false);
        expect(user(0x1a000, 4, "rw")).toBe(false);
    });

    test("backed RAM bounds override a broader valid AddressSpace bucket", () => {
        expect(space.validateRange(mem.length - 2, 4, "rw")).toBe(true);
        expect(user(mem, mem.length - 2, 4, "rw")).toBe(false);
        expect(user(mem.length - 2, 4, "rw")).toBe(false);
        expect(user(mem, mem.length, 1, "rw")).toBe(false);
        expect(user(mem.length, 1, "rw")).toBe(false);
        expect(user(mem.subarray(0, 0x10002), 0x10000, 4, "rw")).toBe(false);
    });

    test("numeric user bounds follow current process RAM after the view changes", () => {
        expect(space.validateRange(0x50000, 4, "rw")).toBe(true);
        expect(user(0x50000, 4, "rw")).toBe(false);
        mem = new Uint8Array(0x60000);
        expect(user(0x50000, 4, "rw")).toBe(true);
        expect(user(mem, 0x50000, 4, "rw")).toBe(true);
    });

    test("invalid numeric extents cannot wrap, truncate, or become a one-byte probe", () => {
        const extents: [number, number][] = [
            [-1, 4], [NaN, 4], [Infinity, 4], [0x10000 + 0.5, 4],
            [0x10000, -1], [0x10000, NaN], [0x10000, Infinity], [0x10000, 0.5],
            [0xfffffffe, 4], [0x100000000, 1], [0x10000, 0x100000000],
            [Number.MAX_SAFE_INTEGER, 4], [0x10000, Number.MAX_SAFE_INTEGER],
        ];
        for (const [address, size] of extents) {
            expect(user(mem, address, size, "rw")).toBe(false);
            expect(user(address, size, "rw")).toBe(false);
        }
    });

    test("a zero extent does not introduce the nonempty user-floor restriction", () => {
        expect(user(mem, 0, 0, "rw")).toBe(true);
        expect(user(0, 0, "rw")).toBe(true);
        expect(user(mem, 0xffff, 0, "r")).toBe(true);
    });

    test("explicit byte view still supplies bounds when isolated callers have no process", () => {
        System.getInstance().process = null;
        expect(user(mem, 0x10000, 4, "rw")).toBe(true);
        expect(user(mem, 1, 4, "rw")).toBe(false);
        expect(user(mem, mem.length - 2, 4, "rw")).toBe(false);
        expect(user(mem, NaN, 4, "rw")).toBe(false);
        expect(user(0x10000, 4, "rw")).toBe(false);
    });
});

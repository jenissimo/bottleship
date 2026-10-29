import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { MsvcrtTimezoneState, parseCrtTimezone } from "../../src/worker/modules/msvcrt-timezone";
import { registerMsvcrtTimeLocaleExports } from "../../src/worker/modules/msvcrt-time-locale";
import {
    readWindowsTimezoneSnapshot,
    type WindowsTimezoneSnapshot,
} from "../../src/worker/runtime/windows-timezone";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
let mem: Uint8Array, next: number, tz: string | undefined, os: WindowsTimezoneSnapshot;
const create = () =>
    new MsvcrtTimezoneState({
        alloc: n => {
            const p = next;
            next += n;
            return p;
        },
        environmentTZ: () => tz,
        windowsTimezone: () => os,
    });
const signed = (p: number) => Mem.readUint32(p)! | 0;

describe("CRT timezone DATA and _tzset state", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x10000);
        Mem.bind(
            () => mem,
            (p, n) => p >= 0 && p + n <= mem.length
        );
        next = 0x1000;
        tz = undefined;
        os = {
            biasMinutes: 360,
            standardBiasMinutes: 0,
            daylightBiasMinutes: -60,
            standardName: "Central Standard Time",
            daylightName: "Central Daylight Time",
            hasDaylightTransitions: true,
        };
    });
    test("published TZ offsets use seconds west, optional minutes/seconds and DST names", () => {
        expect(parseCrtTimezone("PST8PDT")).toEqual({
            secondsWest: 28800,
            daylight: 1,
            dstBias: -3600,
            standardName: "PST",
            daylightName: "PDT",
        });
        expect(parseCrtTimezone("GST-1GDT").secondsWest).toBe(-3600);
        expect(parseCrtTimezone("IST-5:30").secondsWest).toBe(-19800);
        expect(parseCrtTimezone("ABC+1:02:03").secondsWest).toBe(3723);
        expect(parseCrtTimezone("UTC0")).toEqual({
            secondsWest: 0,
            daylight: 0,
            dstBias: -3600,
            standardName: "UTC",
            daylightName: "",
        });
        for (const value of ["America/Chicago", "XXX25", "XXX1:60", "ABC1DEF,M3.2.0,M11.1.0"])
            expect(() => parseCrtTimezone(value)).toThrow("unsupported TZ");
    });
    test("globals contain OS-derived data before the loader can bind their addresses", () => {
        const state = create();
        expect(signed(state.timezone)).toBe(21600);
        expect(signed(state.daylight)).toBe(1);
        expect(signed(state.dstbias)).toBe(-3600);
        expect(state.name(0)).toBe("Central Standard Time");
        expect(state.name(1)).toBe("Central Daylight Time");
        expect(Mem.readUint32(state.tzname)).toBeGreaterThan(state.tzname);
    });
    test("explicit TZ updates stable addresses and clearing TZ restores OS state", () => {
        const state = create(),
            address = state.timezone;
        tz = "IST-5:30";
        state.tzset();
        expect(state.timezone).toBe(address);
        expect(signed(address)).toBe(-19800);
        expect(signed(state.daylight)).toBe(0);
        expect(signed(state.dstbias)).toBe(-3600);
        expect(state.name(0)).toBe("IST");
        expect(state.name(1)).toBe("");
        tz = undefined;
        state.tzset();
        expect(signed(address)).toBe(21600);
    });
    test("explicit TZ preserves a previously configured mutable DST adjustment", () => {
        const state = create();
        Mem.writeUint32(state.dstbias, -1800);
        tz = "PST8PDT";
        state.tzset();
        expect(signed(state.dstbias)).toBe(-1800);
    });
    test("OS standard bias and DST difference are applied separately", () => {
        os = { ...os, biasMinutes: -600, standardBiasMinutes: -30, daylightBiasMinutes: -60 };
        const state = create();
        expect(signed(state.timezone)).toBe(-37800);
        expect(signed(state.dstbias)).toBe(-1800);
        os = { ...os, hasDaylightTransitions: false };
        state.tzset();
        expect(signed(state.daylight)).toBe(0);
        expect(signed(state.dstbias)).toBe(0);
    });
    test("the shared current OS snapshot explicitly retains its fixed-offset limitation", () => {
        const snapshot = readWindowsTimezoneSnapshot();
        expect(snapshot.biasMinutes).toBe(new Date().getTimezoneOffset());
        expect(snapshot.hasDaylightTransitions).toBe(false);
        expect(snapshot.standardName).toBe("");
    });
    test("process reset reconstructs cells without a stale module-static address", () => {
        const old = create();
        const oldAddress = old.timezone;
        mem.fill(0);
        next = 0x5000;
        tz = "UTC0";
        const fresh = create();
        expect(fresh.timezone).toBe(0x5000);
        expect(fresh.timezone).not.toBe(oldAddress);
        expect(signed(fresh.timezone)).toBe(0);
    });
    test("_tzname is a real mutable pointer array", () => {
        const state = create();
        Mem.writeBytes(0x300, new Uint8Array([88, 89, 90, 0]));
        Mem.writeUint32(state.tzname, 0x300);
        expect(state.name(0)).toBe("XYZ");
    });
    test("formatter uses legacy timezone names for both %z and %Z", () => {
        tz = "PST8PDT";
        const state = create(),
            exports: Record<string, ThunkImplementation> = {};
        registerMsvcrtTimeLocaleExports(exports, {
            alloc: n => {
                const p = next;
                next += n;
                return p;
            },
            hasCLocale: () => true,
            setErrno: () => {},
            timezoneName: i => state.name(i),
        });
        Mem.writeBytes(0x200, new Uint8Array([37, 122, 47, 37, 90, 0]));
        Mem.writeUint32(0x400 + 32, 1);
        expect(exports._Strftime!(null as never, mem, [0x600, 20, 0x200, 0x400, 0])).toBe(7);
        expect(Array.from(mem.slice(0x600, 0x608))).toEqual([80, 68, 84, 47, 80, 68, 84, 0]);
    });
    test("failed memory writes cannot initialize apparently valid DATA exports", () => {
        next = mem.length - 2;
        expect(() => create()).toThrow("timezone data write");
    });
});

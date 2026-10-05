/**
 * MCI device registry identity rules.
 *
 * A simple device is ONE device — there is one drive. Two `open cdaudio`s produced two
 * MCIDevice records sharing one alias entry, so `close cdaudio` deleted the alias plus
 * the NEWEST device: the first stayed live and findable by name, the game's own device
 * id was dead, and the drive-side completion listener could never be released.
 *
 * mciGetDeviceID is a QUERY. Real MCI returns 0 for a device that is not open; opening
 * one as a side effect defeats the `mciGetDeviceID(...) == 0` "no CD support" test and
 * leaves a device nothing will ever close.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { WinmmMci } from "../../src/worker/modules/winmm-mci";
import { virtualCd } from "../../src/worker/core/audio/virtual-cd";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const MMSYSERR_NOERROR = 0;
const MCIERR_DEVICE_OPEN = 266;
const MCIERR_DUPLICATE_ALIAS = 289;

const CMD_PTR = 0x100;
const NAME_PTR = 0x800;

const mem = new Uint8Array(0x10000);
let exports: Record<string, ThunkImplementation>;

function readAnsiString(ptr: number, maxLen: number): string {
    let s = "";
    for (let i = 0; i < maxLen && mem[ptr + i]; i++) s += String.fromCharCode(mem[ptr + i]!);
    return s;
}

function writeAnsi(ptr: number, value: string): number {
    mem.fill(0, ptr, ptr + 512);
    for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i);
    return ptr;
}

const send = (command: string): number =>
    exports["mciSendStringA"]!({} as never, mem, [writeAnsi(CMD_PTR, command), 0, 0, 0]) as number;

const deviceId = (name: string): number =>
    exports["mciGetDeviceIDA"]!({} as never, mem, [writeAnsi(NAME_PTR, name)]) as number;

beforeEach(() => {
    mem.fill(0);
    virtualCd().reset();
    const mci = new WinmmMci({
        readAnsiString,
        writeAnsiString: () => true,
        readWideString: () => "",
        writeWideString: () => true,
    });
    exports = {};
    mci.registerExports(exports);
});

describe("MCI device registry", () => {
    test("mciGetDeviceID answers 0 for a device that is not open, and opens nothing", () => {
        expect(deviceId("cdaudio")).toBe(0);
        // Still nothing open: a query that created a device would make this non-zero.
        expect(deviceId("cdaudio")).toBe(0);

        expect(send("open cdaudio")).toBe(MMSYSERR_NOERROR);
        expect(deviceId("cdaudio")).toBeGreaterThan(0);
    });

    test("re-opening a simple device is MCIERR_DEVICE_OPEN, and one close retires it", () => {
        expect(send("open cdaudio")).toBe(MMSYSERR_NOERROR);
        const id = deviceId("cdaudio");
        expect(id).toBeGreaterThan(0);

        expect(send("open cdaudio")).toBe(MCIERR_DEVICE_OPEN);
        expect(deviceId("cdaudio")).toBe(id);

        expect(send("close cdaudio")).toBe(MMSYSERR_NOERROR);
        expect(deviceId("cdaudio")).toBe(0);
    });

    test("an explicit duplicate alias is still MCIERR_DUPLICATE_ALIAS", () => {
        expect(send("open cdaudio alias music")).toBe(MMSYSERR_NOERROR);
        expect(send("open cdaudio alias music")).toBe(MCIERR_DUPLICATE_ALIAS);
        expect(deviceId("music")).toBeGreaterThan(0);
    });
});

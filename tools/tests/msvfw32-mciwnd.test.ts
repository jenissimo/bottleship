/**
 * MCIWnd is a window that owns one MCI device: window messages in, MCI commands out.
 * The application never sees the device, so what it polls (MCIWNDM_GETMODE) and what it
 * sends (MCI_PLAY, MCI_STOP) has to reach the device the window opened — and only that one.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import {Mem} from "../../src/worker/core/memory/mem-accessor";
import {Msvfw32} from "../../src/worker/modules/msvfw32";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import {
    MCIWND_CLASS_NAME, clearMciWndState, handleMciWndMessage, openMciWndFile, readMciWndFileName, resetMciWndState,
} from "../../src/worker/modules/msvfw32-mciwnd";

const WS_CHILD = 0x40000000;
const WS_BORDER = 0x00800000;
const MCIWNDF_NOAUTOSIZEWINDOW = 0x0001;
const MCI_CLOSE = 0x0804;
const MCI_PLAY = 0x0806;
const MCI_STOP = 0x0808;
const MCIWNDM_GETMODEA = 0x0400 + 106;
const MCI_MODE_NOT_READY = 524;
const MCI_MODE_STOP = 525;
const MCI_MODE_PLAY = 526;

const HWND = 0x10042;
const mem = new Uint8Array(0x1000);
const ctx = {} as never;

let commands: string[];
let mode: string;
let resized: number[] | null;
let openError: number;

const system = System.getInstance() as unknown as { process: unknown };
const realProcess = system.process;
afterAll(() => { system.process = realProcess; });

beforeEach(() => {
    commands = [];
    mode = "stopped";
    resized = null;
    openError = 0;
    const mci = {
        executeString(command: string) {
            commands.push(command);
            const verb = command.split(" ")[0];
            if (verb === "open") return { error: openError, value: "" };
            if (verb === "where") return { error: 0, value: "0 0 320 240" };
            if (verb === "status") return { error: 0, value: mode };
            if (verb === "play") mode = "playing";
            if (verb === "stop") mode = "stopped";
            return { error: 0, value: "" };
        },
        deviceIdOf: () => 7,
    };
    system.process = {
        getModule: (name: string) => name === "winmm"
            ? { getMci: () => mci }
            : { exports: { SetWindowPos: (_c: unknown, _m: unknown, args: number[]) => { resized = args; return 1; } } },
    };
    clearMciWndState(HWND);
    windows.clear();
});

function makeWindow(style: number): void {
    windows.set(HWND, {
        handle: HWND, title: "", style, x: 0, y: 0, width: 300, height: 0, children: [],
        visible: true, wndProc: 0, nativeClassName: MCIWND_CLASS_NAME,
    } as WindowInfo);
}

describe("MCIWnd", () => {
    test("MCIWndCreate publishes its class name through a fresh view after memory growth", () => {
        let current = new Uint8Array(128), freed = 0;
        Mem.bind(() => current);
        const model = {
            memory: {alloc: () => {
                const old = current; current = new Uint8Array(2048); current.set(old);
                structuredClone(old.buffer, {transfer: [old.buffer]}); return 0x200;
            }, free: () => { freed++; }},
            getModule: () => ({exports: {CreateWindowExA: (_c: unknown, m: Uint8Array, a: number[]) => {
                expect(m).toBe(current);
                expect(new TextDecoder().decode(m.subarray(a[1], a[1]! + MCIWND_CLASS_NAME.length))).toBe(MCIWND_CLASS_NAME);
                return HWND;
            }}}),
        };
        system.process = model;
        const module = new Msvfw32(); module.initialize(model as any);
        expect(module.exports.MCIWndCreate!({} as never, current, [0, 0, 0, 0])).toBe(HWND);
        module.reset(); expect(freed).toBe(1);
    });
    test("opening a file aims the device at the window, sized around the movie", () => {
        makeWindow(WS_CHILD | WS_BORDER);
        expect(openMciWndFile(ctx, mem, HWND, "logos.avi")).toBe(0);
        expect(commands[0]).toBe(`open "logos.avi" alias mciwnd${HWND}`);
        expect(commands).toContain(`window mciwnd${HWND} handle ${HWND}`);
        // A one-pixel border on each side of a 320x240 picture, which sits inside it.
        expect(resized?.slice(4, 6)).toEqual([322, 242]);
        expect(commands).toContain(`put mciwnd${HWND} destination at 1 1 320 240`);
    });

    test("a top-level MCIWnd is sized around the movie and plays into its whole client area", () => {
        makeWindow(WS_BORDER);
        expect(openMciWndFile(ctx, mem, HWND, "logos.avi")).toBe(0);
        expect(resized?.slice(4, 6)).toEqual([322, 242]);
        expect(commands).toContain(`put mciwnd${HWND} destination at 0 0 320 240`);
    });

    test("MCIWNDF_NOAUTOSIZEWINDOW leaves the window alone", () => {
        makeWindow(WS_CHILD | WS_BORDER | MCIWNDF_NOAUTOSIZEWINDOW);
        expect(openMciWndFile(ctx, mem, HWND, "logos.avi")).toBe(0);
        expect(resized).toBeNull();
    });

    test("play, mode and stop reach the opened device", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_STOP);
        expect(handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem)).toBe(0);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_PLAY);
        expect(handleMciWndMessage(ctx, HWND, MCI_STOP, 0, 0, mem)).toBe(0);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_STOP);
    });

    test("GETMODE copies the mode name into the caller's buffer", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem);
        handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 16, 0x200, mem);
        expect(String.fromCharCode(...mem.subarray(0x200, 0x207))).toBe("playing");
    });

    test("a window with no device is not ready, and play is an error rather than a success", () => {
        makeWindow(WS_CHILD);
        openError = 275;
        expect(openMciWndFile(ctx, mem, HWND, "missing.avi")).toBe(275);
        expect(handleMciWndMessage(ctx, HWND, 0x0400 + 128, 0, 0, mem)).toBe(275);
        expect(handleMciWndMessage(ctx, HWND, 0x0400 + 228, 0, 0, mem)).toBe(275);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_NOT_READY);
        expect(handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem)).not.toBe(0);
    });

    test("MCI_CLOSE and destroying the window both close the device, once", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        expect(handleMciWndMessage(ctx, HWND, MCI_CLOSE, 0, 0, mem)).toBe(0);
        clearMciWndState(HWND);
        expect(commands.filter((c) => c.startsWith("close"))).toEqual([`close mciwnd${HWND}`]);
    });

    test("messages for any other window class are not ours", () => {
        makeWindow(WS_CHILD);
        windows.get(HWND)!.nativeClassName = "Button";
        expect(handleMciWndMessage(ctx, HWND, MCI_PLAY, 0, 0, mem)).toBeNull();
    });

    test("GETMODE does not partially write a buffer that overruns guest memory", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        mem.fill(0x5a, mem.length - 4);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 16, mem.length - 4, mem)).toBe(0);
        expect([...mem.subarray(mem.length - 4)]).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
    });

    test("unterminated and unreadable filenames cannot open a device", () => {
        mem.fill(0x61, mem.length - 4);
        expect(readMciWndFileName(mem, mem.length - 4, false)).toBeNull();
        expect(readMciWndFileName(mem, mem.length - 1, true)).toBeNull();
        expect(readMciWndFileName(mem, 0, false)).toBe("");
    });

    test("reset closes devices and removes state before a window handle is reused", () => {
        makeWindow(WS_CHILD);
        openMciWndFile(ctx, mem, HWND, "logos.avi");
        resetMciWndState();
        expect(commands.filter((c) => c.startsWith("close"))).toEqual([`close mciwnd${HWND}`]);
        expect(handleMciWndMessage(ctx, HWND, MCIWNDM_GETMODEA, 0, 0, mem)).toBe(MCI_MODE_NOT_READY);
        resetMciWndState();
        expect(commands.filter((c) => c.startsWith("close"))).toHaveLength(1);
    });
});

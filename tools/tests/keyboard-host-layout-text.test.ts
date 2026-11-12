// A key-down says WHICH key went down; what it types depends on the host keyboard layout,
// and only the host knows that. On a German keyboard AltGr+Q is '@', Shift+2 is '"' and
// the key right of P is 'ü' — read off a US table those presses type 'q', '@' and ';',
// so an e-mail address cannot be entered at all. The press carries its character from the
// KeyboardEvent to the guest's TranslateMessage.

import { describe, expect, test } from "bun:test";
import { hardwareKeyText, hardwareKeyVk } from "../../src/app/hardware-key-vk";
import { INPUT_BUFFER_SIZE, KEY_TEXT_NONE, KEY_TEXT_UNKNOWN } from "../../src/input/sab-layout";
import { VirtualInputDevice } from "../../src/input/virtual-device";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import { keyDownChar, translateKeyMessage } from "../../src/worker/modules/user32/translate-message";
import { createSystemExports } from "../../src/worker/modules/user32/system";
import { System } from "../../src/worker/core/system";

const VK_Q = 0x51, VK_2 = 0x32, VK_OEM_1 = 0xba, VK_CONTROL = 0x11, VK_MENU = 0x12;

interface Press { code: string; key: string; keyCode: number; ctrl?: boolean; alt?: boolean; altGraph?: boolean; meta?: boolean }

const event = (p: Press) => ({
    key: p.key, ctrlKey: !!p.ctrl, altKey: !!p.alt, metaKey: !!p.meta,
    getModifierState: (name: string) => name === "AltGraph" && !!p.altGraph,
});

const noWindows = { getKeyboardTargetWindow: () => undefined } as never;

function rig() {
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const device = new VirtualInputDevice();
    device.attach(new Int32Array(sab), () => { });
    const im = new InputManager(noWindows);
    im.setInputBuffer(sab);
    const press = (p: Press): number => {
        const vk = hardwareKeyVk(p.code, p.keyCode);
        device.setKey(vk, true, "hw-key", hardwareKeyText(event(p)));
        device.commitNow();
        im.poll();
        return vk;
    };
    const release = (vk: number): void => {
        device.setKey(vk, false, "hw-key");
        device.commitNow();
        im.poll();
    };
    const typed = (vk: number, shift = false): number => keyDownChar(im.getKeyDownText(vk), vk, shift, false);
    return { device, im, press, release, typed };
}

describe("a key-down types what the host layout says", () => {
    test("AltGr+Q on a German keyboard is '@'", () => {
        const r = rig();
        r.press({ code: "ControlLeft", key: "Control", keyCode: VK_CONTROL, ctrl: true });
        r.press({ code: "AltRight", key: "AltGraph", keyCode: VK_MENU, ctrl: true, alt: true, altGraph: true });
        const vk = r.press({ code: "KeyQ", key: "@", keyCode: VK_Q, ctrl: true, alt: true, altGraph: true });
        expect(vk).toBe(VK_Q);
        expect(r.typed(vk)).toBe(0x40);
    });

    test("Shift+2 on a German keyboard is '\"', not the US '@'", () => {
        const r = rig();
        const vk = r.press({ code: "Digit2", key: "\"", keyCode: VK_2 });
        expect(r.typed(vk, true)).toBe(0x22);
    });

    test("a letter outside ASCII arrives as its ANSI code page byte", () => {
        const r = rig();
        const vk = r.press({ code: "BracketLeft", key: "ü", keyCode: VK_OEM_1 });
        expect(r.typed(vk)).toBe(0xfc);
        r.release(vk);
        expect(r.typed(r.press({ code: "KeyE", key: "€", keyCode: 0x45, ctrl: true, alt: true, altGraph: true }))).toBe(0x80);
    });

    test("a character the ANSI code page lacks falls back to the US table", () => {
        const r = rig();
        expect(r.typed(r.press({ code: "KeyQ", key: "й", keyCode: VK_Q }))).toBe(0x71);
        expect(r.typed(VK_Q, true)).toBe(0x51);
    });

    test("a dead key types nothing", () => {
        const r = rig();
        expect(hardwareKeyText(event({ code: "Equal", key: "Dead", keyCode: 0xdd }))).toBe(KEY_TEXT_NONE);
        expect(r.typed(r.press({ code: "Equal", key: "Dead", keyCode: 0xdd }))).toBe(0);
    });

    test("a named key and a Ctrl shortcut are left to the guest's own table", () => {
        expect(hardwareKeyText(event({ code: "Enter", key: "Enter", keyCode: 13 }))).toBe(KEY_TEXT_UNKNOWN);
        expect(hardwareKeyText(event({ code: "KeyC", key: "c", keyCode: 0x43, ctrl: true }))).toBe(KEY_TEXT_UNKNOWN);
        const r = rig();
        expect(r.typed(r.press({ code: "Enter", key: "Enter", keyCode: 13 }))).toBe(13);
    });

    test("Alt alone is not a layout modifier (macOS Option+F is 'ƒ', Option+E is a dead key)", () => {
        expect(hardwareKeyText(event({ code: "KeyF", key: "ƒ", keyCode: 0x46, alt: true }))).toBe(KEY_TEXT_UNKNOWN);
        expect(hardwareKeyText(event({ code: "KeyE", key: "Dead", keyCode: 0x45, alt: true }))).toBe(KEY_TEXT_UNKNOWN);
        expect(hardwareKeyText(event({ code: "KeyF", key: "f", keyCode: 0x46, alt: true }))).toBe(KEY_TEXT_UNKNOWN);
        const r = rig();
        expect(r.typed(r.press({ code: "KeyF", key: "ƒ", keyCode: 0x46, alt: true }))).toBe(0x66);
        expect(hardwareKeyText(event({ code: "KeyQ", key: "@", keyCode: VK_Q, alt: true, altGraph: true }))).toBe(0x40);
    });
});

describe("TranslateMessage posts the host character", () => {
    const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102, WM_SYSKEYDOWN = 0x104, WM_SYSCHAR = 0x106;
    const HWND = 0x10001;
    const system = System.getInstance() as unknown as { inputManager: InputManager; windowManager: unknown };

    function translating(r: ReturnType<typeof rig>) {
        const posted: Array<[number, number, number, number]> = [];
        const saved = { inputManager: system.inputManager, windowManager: system.windowManager };
        system.inputManager = r.im;
        system.windowManager = { postMessage: (h: number, m: number, w: number, l: number) => { posted.push([h, m, w, l]); } };
        return { posted, restore: () => { Object.assign(system, saved); } };
    }

    test("WM_KEYDOWN of AltGr+Q posts WM_CHAR '@' to the same window with the key's lParam", () => {
        const r = rig();
        const t = translating(r);
        try {
            const vk = r.press({ code: "KeyQ", key: "@", keyCode: VK_Q, ctrl: true, alt: true, altGraph: true });
            expect(translateKeyMessage(HWND, WM_KEYDOWN, vk, 0x00100001)).toBe(true);
            expect(t.posted).toEqual([[HWND, WM_CHAR, 0x40, 0x00100001]]);
        } finally { t.restore(); }
    });

    test("WM_SYSKEYDOWN posts WM_SYSCHAR, a key-up and a dead key post nothing", () => {
        const r = rig();
        const t = translating(r);
        try {
            const vk = r.press({ code: "BracketLeft", key: "ü", keyCode: VK_OEM_1 });
            expect(translateKeyMessage(HWND, WM_SYSKEYDOWN, vk, 1)).toBe(true);
            expect(t.posted).toEqual([[HWND, WM_SYSCHAR, 0xfc, 1]]);
            expect(translateKeyMessage(HWND, WM_KEYUP, vk, 1)).toBe(false);
            r.release(vk);
            const dead = r.press({ code: "Equal", key: "Dead", keyCode: 0xdd });
            expect(translateKeyMessage(HWND, WM_KEYDOWN, dead, 1)).toBe(false);
            expect(t.posted.length).toBe(1);
        } finally { t.restore(); }
    });

    test("a host character outside the guest code page still posts the US character", () => {
        const r = rig();
        const t = translating(r);
        try {
            const vk = r.press({ code: "KeyQ", key: "й", keyCode: VK_Q });
            expect(translateKeyMessage(HWND, WM_KEYDOWN, vk, 1)).toBe(true);
            expect(t.posted).toEqual([[HWND, WM_CHAR, 0x71, 1]]);
        } finally { t.restore(); }
    });
});

describe("a press never inherits another press's character", () => {
    test("an on-screen key after a hardware AltGr press types from the US table", () => {
        const r = rig();
        const vk = r.press({ code: "KeyQ", key: "@", keyCode: VK_Q, ctrl: true, alt: true, altGraph: true });
        r.release(vk);
        r.device.setKey(VK_Q, true, "widget");
        r.device.commitNow();
        r.im.poll();
        expect(r.typed(VK_Q)).toBe(0x71);
    });

    test("an injected key after a hardware press types from the US table", () => {
        const r = rig();
        const vk = r.press({ code: "Digit2", key: "\"", keyCode: VK_2 });
        r.release(vk);
        r.im.injectKey(VK_2, true);
        expect(r.typed(VK_2)).toBe(0x32);
    });

    test("each press of one key types its own character", () => {
        const r = rig();
        const vk = r.press({ code: "KeyQ", key: "@", keyCode: VK_Q, ctrl: true, alt: true, altGraph: true });
        expect(r.typed(vk)).toBe(0x40);
        r.release(vk);
        r.press({ code: "KeyQ", key: "q", keyCode: VK_Q });
        expect(r.typed(vk)).toBe(0x71);
    });
});

describe("ToAscii and ToUnicode of a held key", () => {
    const mem = new Uint8Array(0x1000);
    const STATE = 0x100, OUT = 0x300;
    const exports = createSystemExports();
    const system = System.getInstance() as unknown as { inputManager: InputManager };
    const call = (name: string, vk: number, scan: number): number =>
        exports[name]!({} as never, mem, name === "ToUnicode" ? [vk, scan, STATE, OUT, 4, 0] : [vk, scan, STATE, OUT, 0]) as number;
    const word = (): number => mem[OUT]! | (mem[OUT + 1]! << 8);

    test("the key being pressed translates to its host character", () => {
        const r = rig();
        const saved = system.inputManager;
        system.inputManager = r.im;
        try {
            const vk = r.press({ code: "KeyQ", key: "@", keyCode: VK_Q, ctrl: true, alt: true, altGraph: true });
            expect(call("ToAscii", vk, 0x10)).toBe(1);
            expect(word()).toBe(0x40);
            expect(call("ToUnicode", vk, 0x10)).toBe(1);
            expect(word()).toBe(0x40);
            r.release(vk);
            r.press({ code: "KeyE", key: "€", keyCode: 0x45, ctrl: true, alt: true, altGraph: true });
            expect(call("ToAscii", 0x45, 0x12)).toBe(1);
            expect(word()).toBe(0x80);
            expect(call("ToUnicode", 0x45, 0x12)).toBe(1);
            expect(word()).toBe(0x20ac);
        } finally { system.inputManager = saved; }
    });

    test("a held key whose host character the code page lacks answers the US character", () => {
        const r = rig();
        const saved = system.inputManager;
        system.inputManager = r.im;
        try {
            const vk = r.press({ code: "KeyQ", key: "й", keyCode: VK_Q });
            expect(call("ToAscii", vk, 0x10)).toBe(1);
            expect(word()).toBe(0x71);
            expect(call("ToUnicode", vk, 0x10)).toBe(1);
            expect(word()).toBe(0x71);
        } finally { system.inputManager = saved; }
    });

    test("a key nobody holds, and a key-up, keep the US table", () => {
        const r = rig();
        const saved = system.inputManager;
        system.inputManager = r.im;
        try {
            const vk = r.press({ code: "KeyQ", key: "@", keyCode: VK_Q, ctrl: true, alt: true, altGraph: true });
            expect(call("ToAscii", vk, 0x8010)).toBe(1);
            expect(word()).toBe(0x71);
            r.release(vk);
            expect(call("ToAscii", vk, 0x10)).toBe(1);
            expect(word()).toBe(0x71);
            expect(call("ToAscii", VK_2, 0x03)).toBe(1);
            expect(word()).toBe(0x32);
        } finally { system.inputManager = saved; }
    });
});

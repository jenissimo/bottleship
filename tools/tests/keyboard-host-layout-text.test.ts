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

// Ctrl without Alt selects the layout's control column: WM_CHAR carries 0x01..0x1A for the
// letters and a handful of others, which is what edit controls and in-game consoles read
// Ctrl+C / Ctrl+V / Ctrl+Z from. Ctrl+Alt is AltGr and keeps typing the layout's character.
describe("Ctrl types control characters", () => {
    const WM_KEYDOWN = 0x100, WM_CHAR = 0x102;
    const HWND = 0x10001;
    const system = System.getInstance() as unknown as { inputManager: InputManager; windowManager: unknown };

    function withCtrl(
        run: (r: ReturnType<typeof rig>, char: (p: Press) => number | null, releaseCtrl: () => void) => void,
        shift = false,
    ) {
        const r = rig();
        const posted: number[][] = [];
        const saved = { inputManager: system.inputManager, windowManager: system.windowManager };
        system.inputManager = r.im;
        system.windowManager = { postMessage: (...m: number[]) => { posted.push(m); } };
        try {
            const ctrlVk = r.press({ code: "ControlLeft", key: "Control", keyCode: VK_CONTROL, ctrl: true });
            if (shift) r.press({ code: "ShiftLeft", key: "Shift", keyCode: 0x10, ctrl: true });
            run(r, (p) => {
                posted.length = 0;
                const vk = r.press({ ...p, ctrl: true });
                const sent = translateKeyMessage(HWND, WM_KEYDOWN, vk, 0x001e0001);
                r.release(vk);
                if (!sent) { expect(posted).toEqual([]); return null; }
                expect(posted).toEqual([[HWND, WM_CHAR, posted[0]![2]!, 0x001e0001]]);
                return posted[0]![2]!;
            }, () => r.release(ctrlVk));
        } finally { Object.assign(system, saved); }
    }

    test("Ctrl+A..Ctrl+Z post WM_CHAR 0x01..0x1A", () => {
        withCtrl((_r, char) => {
            for (let i = 0; i < 26; i++) {
                const letter = String.fromCharCode(0x61 + i);
                expect(char({ code: `Key${letter.toUpperCase()}`, key: letter, keyCode: 0x41 + i })).toBe(i + 1);
            }
        });
    });

    test("Ctrl+[ \\ ] and Ctrl+Backspace post 0x1B, 0x1C, 0x1D and 0x7F", () => {
        withCtrl((_r, char) => {
            expect(char({ code: "BracketLeft", key: "[", keyCode: 0xdb })).toBe(0x1b);
            expect(char({ code: "Backslash", key: "\\", keyCode: 0xdc })).toBe(0x1c);
            expect(char({ code: "BracketRight", key: "]", keyCode: 0xdd })).toBe(0x1d);
            expect(char({ code: "Backspace", key: "Backspace", keyCode: 8 })).toBe(0x7f);
        });
    });

    test("Ctrl+Shift+2 posts a WM_CHAR of 0x00; Ctrl+Shift+6 and Ctrl+Shift+- post 0x1E and 0x1F", () => {
        withCtrl((_r, char) => {
            expect(char({ code: "Digit2", key: "@", keyCode: 0x32 })).toBe(0x00);
            expect(char({ code: "Digit6", key: "^", keyCode: 0x36 })).toBe(0x1e);
            expect(char({ code: "Minus", key: "_", keyCode: 0xbd })).toBe(0x1f);
        }, true);
    });

    test("without Shift those three keys have no control character and type as before", () => {
        withCtrl((_r, char) => {
            expect(char({ code: "Digit2", key: "2", keyCode: 0x32 })).toBe(0x32);
            expect(char({ code: "Digit6", key: "6", keyCode: 0x36 })).toBe(0x36);
            expect(char({ code: "Minus", key: "-", keyCode: 0xbd })).toBe(0x2d);
        });
    });

    test("Ctrl+Enter, Ctrl+Space, Ctrl+Esc, Ctrl+Break and Ctrl+ISO-backslash post kbdus's control column", () => {
        withCtrl((_r, char) => {
            expect(char({ code: "Enter", key: "Enter", keyCode: 13 })).toBe(0x0a);
            expect(char({ code: "Space", key: " ", keyCode: 0x20 })).toBe(0x20);
            expect(char({ code: "Escape", key: "Escape", keyCode: 0x1b })).toBe(0x1b);
            expect(char({ code: "Pause", key: "Cancel", keyCode: 0x03 })).toBe(0x03);
            expect(char({ code: "IntlBackslash", key: "\\", keyCode: 0xe2 })).toBe(0x1c);
        });
    });

    test("Ctrl+Shift on a key with only a Ctrl column posts nothing", () => {
        withCtrl((_r, char) => {
            expect(char({ code: "BracketLeft", key: "{", keyCode: 0xdb })).toBeNull();
            expect(char({ code: "Backslash", key: "|", keyCode: 0xdc })).toBeNull();
            expect(char({ code: "BracketRight", key: "}", keyCode: 0xdd })).toBeNull();
            expect(char({ code: "Backspace", key: "Backspace", keyCode: 8 })).toBeNull();
            expect(char({ code: "Enter", key: "Enter", keyCode: 13 })).toBeNull();
            expect(char({ code: "Space", key: " ", keyCode: 0x20 })).toBeNull();
            expect(char({ code: "Escape", key: "Escape", keyCode: 0x1b })).toBeNull();
            expect(char({ code: "KeyA", key: "A", keyCode: 0x41 })).toBe(0x01);
        }, true);
    });

    test("AltGr+Q on a German layout is still '@', and Q alone after Ctrl is released is 'q'", () => {
        withCtrl((r, char, releaseCtrl) => {
            const altGr = r.press({ code: "AltRight", key: "AltGraph", keyCode: VK_MENU, ctrl: true, alt: true, altGraph: true });
            expect(char({ code: "KeyQ", key: "@", keyCode: VK_Q, alt: true, altGraph: true })).toBe(0x40);
            r.release(altGr);
            expect(char({ code: "KeyQ", key: "q", keyCode: VK_Q })).toBe(0x11);
            releaseCtrl();
            expect(char({ code: "KeyQ", key: "q", keyCode: VK_Q })).toBe(0x71);
        });
    });
});

describe("ToAscii and ToUnicode honour Ctrl in the caller's key state", () => {
    const mem = new Uint8Array(0x1000);
    const STATE = 0x100, OUT = 0x300;
    const exports = createSystemExports();
    const call = (name: string, vk: number): number =>
        exports[name]!({} as never, mem, name === "ToUnicode" ? [vk, 0, STATE, OUT, 4, 0] : [vk, 0, STATE, OUT, 0]) as number;
    const word = (): number => mem[OUT]! | (mem[OUT + 1]! << 8);
    const state = (ctrl: boolean, alt: boolean, shift: boolean): void => {
        mem.fill(0, STATE, STATE + 256);
        if (shift) mem[STATE + 0x10] = 0x80;
        if (ctrl) mem[STATE + 0x11] = 0x80;
        if (alt) mem[STATE + 0x12] = 0x80;
    };

    for (const name of ["ToAscii", "ToUnicode"]) {
        test(`${name}: Ctrl down gives the control character, whatever the keyboard itself holds`, () => {
            state(true, false, false);
            mem[OUT] = 0xee; mem[OUT + 1] = 0xee;
            expect(call(name, 0x43)).toBe(1);
            expect(word()).toBe(0x03);
            expect(call(name, 0x5a)).toBe(1);
            expect(word()).toBe(0x1a);
            expect(call(name, 0xdb)).toBe(1);
            expect(word()).toBe(0x1b);
            expect(call(name, 0x08)).toBe(1);
            expect(word()).toBe(0x7f);
        });

        test(`${name}: Ctrl+Shift+2 is one character, 0x00; Ctrl+Shift+6 is 0x1E`, () => {
            state(true, false, true);
            mem[OUT] = 0xee; mem[OUT + 1] = 0xee;
            expect(call(name, 0x32)).toBe(1);
            expect(word()).toBe(0x00);
            expect(call(name, 0x36)).toBe(1);
            expect(word()).toBe(0x1e);
        });

        test(`${name}: Ctrl+Shift+[ and Ctrl+Shift+Enter give no character; Ctrl+Enter is 0x0A`, () => {
            state(true, false, true);
            mem[OUT] = 0xee; mem[OUT + 1] = 0xee;
            expect(call(name, 0xdb)).toBe(0);
            expect(call(name, 0x0d)).toBe(0);
            expect(word()).toBe(0xeeee);
            state(true, false, false);
            expect(call(name, 0x0d)).toBe(1);
            expect(word()).toBe(0x0a);
        });

        test(`${name}: Ctrl without Shift reads the Shift bit of the caller's state (Ctrl+2 is not 0x00)`, () => {
            state(true, false, false);
            mem[OUT] = 0xee; mem[OUT + 1] = 0xee;
            expect(call(name, 0x32)).toBe(1);
            expect(word()).toBe(0x32);
        });

        test(`${name}: Ctrl in the caller's state wins over a held key's host character`, () => {
            const r = rig();
            const system = System.getInstance() as unknown as { inputManager: InputManager };
            const saved = system.inputManager;
            system.inputManager = r.im;
            try {
                r.press({ code: "KeyC", key: "c", keyCode: 0x43 });
                state(true, false, false);
                mem[OUT] = 0xee; mem[OUT + 1] = 0xee;
                expect(exports[name]!({} as never, mem, name === "ToUnicode" ? [0x43, 0x2e, STATE, OUT, 4, 0] : [0x43, 0x2e, STATE, OUT, 0])).toBe(1);
                expect(word()).toBe(0x03);
                r.press({ code: "BracketLeft", key: "{", keyCode: 0xdb });
                state(true, false, true);
                expect(exports[name]!({} as never, mem, name === "ToUnicode" ? [0xdb, 0x1a, STATE, OUT, 4, 0] : [0xdb, 0x1a, STATE, OUT, 0])).toBe(0);
            } finally { system.inputManager = saved; }
        });

        test(`${name}: Ctrl+Alt, and no Ctrl, translate the key as before`, () => {
            state(true, true, false);
            expect(call(name, 0x43)).toBe(1);
            expect(word()).toBe(0x63);
            state(false, false, true);
            expect(call(name, 0x43)).toBe(1);
            expect(word()).toBe(0x43);
        });
    }
});

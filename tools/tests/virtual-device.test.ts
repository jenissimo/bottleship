// The device composes several input producers into one level-based record. The
// property that matters: no producer can erase another's state, and no sequence
// of presses and releases can leave a key or button latched after everyone lets go.

import { describe, expect, test } from "bun:test";
import { INPUT_BUFFER_SIZE, INPUT_INDEX, KEY_BITFIELD_BASE } from "../../src/input/sab-layout";
import { VirtualInputDevice, type SourceId } from "../../src/input/virtual-device";

const VK_W = 0x57;
const VK_SHIFT = 0x10;

function makeDevice(): { device: VirtualInputDevice; view: Int32Array; ticks: () => number } {
    const view = new Int32Array(INPUT_BUFFER_SIZE / 4);
    let ticks = 0;
    const device = new VirtualInputDevice();
    device.attach(view, () => { ticks++; });
    device.setPointerBounds(640, 480);
    return { device, view, ticks: () => ticks };
}

const keyBit = (view: Int32Array, vk: number): boolean =>
    (view[KEY_BITFIELD_BASE + (vk >> 5)]! & (1 << (vk & 31))) !== 0;

describe("source composition", () => {
    test("a physical keystroke does not erase a virtual key", () => {
        const { device, view } = makeDevice();
        device.setKey(VK_W, true, "widget");
        device.commitNow();
        expect(keyBit(view, VK_W)).toBe(true);

        // The physical keyboard publishes its own world; the widget still holds W.
        device.setKey(VK_SHIFT, true, "hw-key");
        device.commitNow();
        expect(keyBit(view, VK_W)).toBe(true);
        expect(keyBit(view, VK_SHIFT)).toBe(true);

        device.setKey(VK_SHIFT, false, "hw-key");
        device.commitNow();
        expect(keyBit(view, VK_W)).toBe(true);
    });

    test("a hardware pad poll does not erase a virtual stick", () => {
        const { device, view } = makeDevice();
        device.publishPad({ connected: true, buttons: 0b1, axes: [16000, 0, 0, 0] }, "widget");
        device.commitNow();
        device.publishPad({ connected: true, buttons: 0b10, axes: [0, 0, 0, 0] }, "hw-pad");
        device.commitNow();

        expect(view[INPUT_INDEX.gamepadButtons]).toBe(0b11);
        // Larger deflection wins, so a physical stick at rest cannot cancel a virtual one.
        expect(view[INPUT_INDEX.gamepadAxis0]).toBe(16000);
        expect(view[INPUT_INDEX.gamepadConnected]).toBe(1);
    });

    test("a touch-derived button mask survives a mouse event reporting no buttons", () => {
        const { device, view } = makeDevice();
        device.setButton(1, true, "touch");
        device.commitNow();
        expect(view[INPUT_INDEX.buttons]).toBe(2);

        device.setButtonsMask(0, "hw-mouse");
        device.commitNow();
        expect(view[INPUT_INDEX.buttons]).toBe(2);
    });

    test("mouseInside is the OR of the sources that claim it", () => {
        const { device, view } = makeDevice();
        device.setMouseInside(true, "touch");
        device.commitNow();
        expect(view[INPUT_INDEX.mouseInside]).toBe(1);
        device.setMouseInside(false, "hw-mouse");
        device.commitNow();
        expect(view[INPUT_INDEX.mouseInside]).toBe(1);
        device.setMouseInside(false, "touch");
        device.commitNow();
        expect(view[INPUT_INDEX.mouseInside]).toBe(0);
    });
});

describe("release", () => {
    test("releaseSource drops only that source", () => {
        const { device, view } = makeDevice();
        device.setKey(VK_W, true, "widget");
        device.setKey(VK_SHIFT, true, "hw-key");
        device.setButton(0, true, "touch");
        device.commitNow();

        device.releaseSource("touch");
        device.commitNow();
        expect(view[INPUT_INDEX.buttons]).toBe(0);
        expect(keyBit(view, VK_W)).toBe(true);
        expect(keyBit(view, VK_SHIFT)).toBe(true);
    });

    test("releaseAllSources clears every level including mouseInside", () => {
        const { device, view } = makeDevice();
        device.setKey(VK_W, true, "widget");
        device.setButton(0, true, "hw-mouse");
        device.setMouseInside(true, "hw-mouse");
        device.publishPad({ connected: true, buttons: 3, axes: [100, 0, 0, 0] }, "hw-pad");
        device.commitNow();

        device.releaseAllSources();
        device.commitNow();
        expect(view[INPUT_INDEX.buttons]).toBe(0);
        expect(view[INPUT_INDEX.mouseInside]).toBe(0);
        expect(view[INPUT_INDEX.gamepadConnected]).toBe(0);
        expect(view[INPUT_INDEX.gamepadButtons]).toBe(0);
        expect(view[INPUT_INDEX.gamepadAxis0]).toBe(0);
        for (let w = 0; w < 8; w++) expect(view[KEY_BITFIELD_BASE + w]).toBe(0);
    });

    test("property: any press/release sequence ends fully released and seq stays even", () => {
        const { device, view } = makeDevice();
        const sources: SourceId[] = ["hw-key", "hw-mouse", "touch", "widget", "osk"];
        const vks = [VK_W, VK_SHIFT, 0x41, 0x1b, 0xa0];
        // Deterministic pseudo-random walk: reproducible without a seeded RNG dependency.
        let x = 123456789;
        const rnd = (n: number): number => {
            x = (x * 1103515245 + 12345) & 0x7fffffff;
            return x % n;
        };
        for (let i = 0; i < 2000; i++) {
            const src = sources[rnd(sources.length)]!;
            switch (rnd(5)) {
                case 0: device.setKey(vks[rnd(vks.length)]!, true, src); break;
                case 1: device.setKey(vks[rnd(vks.length)]!, false, src); break;
                case 2: device.setButton((rnd(3) as 0 | 1 | 2), rnd(2) === 0, src); break;
                case 3: device.releaseSource(src); break;
                case 4: device.setMouseInside(rnd(2) === 0, src); break;
            }
            device.commitNow();
            expect(view[INPUT_INDEX.seq] & 1).toBe(0);
        }

        device.releaseAllSources();
        device.commitNow();
        expect(view[INPUT_INDEX.buttons]).toBe(0);
        for (let w = 0; w < 8; w++) expect(view[KEY_BITFIELD_BASE + w]).toBe(0);
    });
});

describe("accumulators", () => {
    test("wheel notches accumulate instead of overwriting", () => {
        const { device, view } = makeDevice();
        device.addWheel(100);
        device.addWheel(100);
        device.commitNow();
        expect(view[INPUT_INDEX.mouseWheel]).toBe(200);
    });

    test("relative motion feeds raw deltas to DInput and scaled ones to the cursor", () => {
        const { device, view } = makeDevice();
        device.setPointerAbsolute(100, 100);
        device.addPointerRelative(5, 5, 10, 10);
        device.commitNow();
        expect(view[INPUT_INDEX.mouseX]).toBe(105);
        expect(view[INPUT_INDEX.dinputDX]).toBe(10);
        expect(view[INPUT_INDEX.dinputDY]).toBe(10);
    });

    test("the cursor is clamped to the pointer bounds", () => {
        const { device, view } = makeDevice();
        device.setPointerAbsolute(600, 400);
        device.addPointerRelative(1000, 1000);
        device.commitNow();
        expect(view[INPUT_INDEX.mouseX]).toBe(639);
        expect(view[INPUT_INDEX.mouseY]).toBe(479);
    });
});

describe("publication", () => {
    test("an edge publishes synchronously", () => {
        const { device, ticks } = makeDevice();
        device.setKey(VK_W, true, "hw-key");
        device.commit();
        expect(ticks()).toBe(1);
    });

    test("committing an unchanged state publishes nothing", () => {
        const { device, ticks } = makeDevice();
        device.setKey(VK_W, true, "hw-key");
        device.commit();
        device.setKey(VK_W, true, "hw-key");
        device.commit();
        expect(ticks()).toBe(1);
    });
});

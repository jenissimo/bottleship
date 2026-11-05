// Relative pointer motion moves the one system cursor, as device motion does on Windows,
// while the DirectInput axes keep the raw, unclamped delta.
import {expect, test} from 'bun:test';
import {InputManager} from '../../src/worker/runtime/input/input-manager';
import {WindowManager} from '../../src/worker/runtime/windowing/window-manager';
import {getVirtualScreenRect, setCursorClipRect} from '../../src/worker/modules/user32/shared-state';
import {INPUT_BUFFER_SIZE, INPUT_INDEX} from '../../src/input/sab-layout';

test('injectPointerDelta advances the cursor from the guest warp, clamped; DInput sees the raw delta', () => {
    const im = new InputManager(new WindowManager());
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const view = new Int32Array(sab);
    im.setInputBuffer(sab);
    const screen = getVirtualScreenRect();
    try {
        im.reset();
        // UE1 WinDrv: read WM_MOUSEMOVE, then SetCursorPos back to the centre.
        im.moveCursorTo(320, 240);
        im.injectPointerDelta(10, -5);
        expect(im.getMouseState()).toMatchObject({x: 330, y: 235});
        im.moveCursorTo(320, 240);
        im.injectPointerDelta(10, -5);
        expect(im.getMouseState()).toMatchObject({x: 330, y: 235});
        expect(Atomics.load(view, INPUT_INDEX.dinputDX)).toBe(20);
        expect(Atomics.load(view, INPUT_INDEX.dinputDY)).toBe(-10);

        im.injectPointerDelta(100000, 100000);
        expect(im.getMouseState()).toMatchObject({x: screen.right - 1, y: screen.bottom - 1});
        expect(Atomics.load(view, INPUT_INDEX.dinputDX)).toBe(100020);

        setCursorClipRect({left: 10, top: 20, right: 100, bottom: 200});
        im.moveCursorTo(50, 50);
        im.injectPointerDelta(-500, 500);
        expect(im.getMouseState()).toMatchObject({x: 10, y: 199});
    } finally {
        setCursorClipRect(null);
    }
});

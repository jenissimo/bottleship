import {expect, test} from 'bun:test';
import {hypercallDataManager} from '../../src/worker/core/cpu/hypercall-data';
import {InputManager} from '../../src/worker/runtime/input/input-manager';
import {WindowManager} from '../../src/worker/runtime/windowing/window-manager';
import {setCursorClipRect} from '../../src/worker/modules/user32/shared-state';
import {INPUT_BUFFER_SIZE} from '../../src/input/sab-layout';

test('cursor mutations reach the WASM GetCursorPos page before the next tick', () => {
    const manager: any = hypercallDataManager;
    const saved: Record<string, unknown> = {};
    for (const key of ['cpu', 'wasmMemory', 'view', 'hpBase', 'initialized']) saved[key] = manager[key];
    const buffer = new ArrayBuffer(0x20000), view = new DataView(buffer), base = 0x1000;
    Object.assign(manager, {cpu: {wasm_memory: {buffer}}, wasmMemory: buffer,
        view, hpBase: base, initialized: true});
    const im = new InputManager(new WindowManager());
    im.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
    const cached = () => [view.getInt32(base + 0x80, true), view.getInt32(base + 0x84, true)];
    try {
        im.reset();
        im.injectMoveAtScreen(145, 297);
        expect(cached()).toEqual([145, 297]);
        // SDL's relative pump reads, recentres, then reads again in the same guest tick.
        im.moveCursorTo(512, 384);
        expect(cached()).toEqual([512, 384]);
        expect(im.getMouseState()).toMatchObject({x: 512, y: 384});
        // A key/button publication must not undo the guest warp with old host coordinates.
        im.injectKey(0x41, true);
        expect(cached()).toEqual([512, 384]);
        im.injectMoveAtScreen(145, 297);
        expect(cached()).toEqual([145, 297]);
        expect(im.getMouseState()).toMatchObject({x: 145, y: 297});
        im.moveCursorTo(512, 384);
        im.injectMoveAtScreen(145, 297);
        expect(cached()).toEqual([145, 297]);
        setCursorClipRect({left: 10, top: 20, right: 100, bottom: 200});
        im.setMousePosition(500, -10);
        expect(cached()).toEqual([99, 20]);
        im.reset();
        expect(cached()).toEqual([0, 0]);
    } finally {
        setCursorClipRect(null);
        for (const [key, value] of Object.entries(saved)) manager[key] = value;
    }
});

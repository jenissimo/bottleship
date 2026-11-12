import { afterEach, describe, expect, test } from "bun:test";
import { InputManager } from "../../src/worker/runtime/input/input-manager";
import { INPUT_BUFFER_SIZE, INPUT_INDEX, KEY_BITFIELD_BASE, beginInputWrite, endInputWrite } from "../../src/input/sab-layout";
import { System } from "../../src/worker/core/system";
import { savestateParticipants, type Participant } from "../../src/worker/savestate/participant";
import { newCaptureRun } from "../../src/worker/savestate/session";
import type { SaveValue } from "../../src/worker/savestate/value-codec";
import { createInputExports, type User32InputState } from "../../src/worker/modules/user32/input";

const WM_MOUSEMOVE = 0x200;
const CENTRE = { x: 320, y: 240 };

function rig() {
    const moves: Array<[number, number]> = [];
    const win = { hwnd: 0x10001, rect: { x: 0, y: 0, width: 640, height: 480 }, visible: true };
    const wm = {
        getKeyboardTargetWindow: () => win,
        getMouseTargetWindow: () => win,
        getCaptureHwnd: () => 0,
        getWindow: () => win,
        getTopLevelAncestor: () => win.hwnd,
        getActiveHwnd: () => win.hwnd,
        setActiveWindow: () => { },
        postInputMessage: (_h: number, msg: number, _w: number, _l: number, x: number, y: number) => {
            if (msg === WM_MOUSEMOVE) moves.push([x, y]);
        },
    };
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    const view = new Int32Array(sab);
    const im = new InputManager(wm as never);
    im.setInputBuffer(sab);
    const pos = () => { const m = im.getMouseState(); return [m.x, m.y]; };
    const mouseLook = () => {
        const [x, y] = pos();
        im.moveCursorTo(CENTRE.x, CENTRE.y);
        return [x! - CENTRE.x, y! - CENTRE.y];
    };
    return { im, view, moves, pos, mouseLook };
}

function publishPointer(view: Int32Array, x: number, y: number): void {
    beginInputWrite(view);
    view[INPUT_INDEX.mouseX] = x;
    view[INPUT_INDEX.mouseY] = y;
    view[INPUT_INDEX.mouseInside] = 1;
    endInputWrite(view);
}

function republishWithKey(view: Int32Array, vk: number): void {
    beginInputWrite(view);
    view[KEY_BITFIELD_BASE + (vk >> 5)]! ^= 1 << (vk & 31);
    endInputWrite(view);
}

describe("the cursor position at capture", () => {
    test("is the position the guest reads, whoever wrote it last", () => {
        const a = rig();
        publishPointer(a.view, 100, 50);
        a.im.poll();
        expect(a.im.captureCursor()).toEqual({ x: 100, y: 50, movedX: 100, movedY: 50 });
        a.im.moveCursorTo(CENTRE.x, CENTRE.y);
        expect(a.im.captureCursor()).toEqual({ x: CENTRE.x, y: CENTRE.y, movedX: CENTRE.x, movedY: CENTRE.y });
    });

    test("a title that recentres the cursor reads no motion on its first frame after a restore", () => {
        const a = rig();
        publishPointer(a.view, 300, 200);
        a.im.poll();
        a.mouseLook();
        const saved = a.im.captureCursor();

        const fresh = rig();
        expect(fresh.mouseLook()).toEqual([-CENTRE.x, -CENTRE.y]);

        const b = rig();
        b.im.restoreCursor(saved);
        expect(b.pos()).toEqual([CENTRE.x, CENTRE.y]);
        expect(b.mouseLook()).toEqual([0, 0]);
    });

    test("the position the new host had already published is not motion", () => {
        const a = rig();
        a.im.moveCursorTo(CENTRE.x, CENTRE.y);
        const saved = a.im.captureCursor();

        const b = rig();
        publishPointer(b.view, 17, 600);
        b.im.restoreCursor(saved);
        b.moves.length = 0;
        b.im.poll();
        republishWithKey(b.view, 0x41);
        b.im.poll();
        expect(b.pos()).toEqual([CENTRE.x, CENTRE.y]);
        expect(b.moves).toEqual([]);
        expect(b.mouseLook()).toEqual([0, 0]);
    });

    test("a host that had polled its own position before the restore still yields to the saved one", () => {
        const a = rig();
        a.im.moveCursorTo(CENTRE.x, CENTRE.y);
        const saved = a.im.captureCursor();

        const b = rig();
        publishPointer(b.view, 17, 100);
        b.im.poll();
        expect(b.pos()).toEqual([17, 100]);
        b.im.restoreCursor(saved);
        republishWithKey(b.view, 0x41);
        b.im.poll();
        expect(b.pos()).toEqual([CENTRE.x, CENTRE.y]);
    });

    test("real motion after the restore moves the cursor again", () => {
        const a = rig();
        a.im.moveCursorTo(CENTRE.x, CENTRE.y);
        const saved = a.im.captureCursor();

        const b = rig();
        b.im.restoreCursor(saved);
        publishPointer(b.view, CENTRE.x + 5, CENTRE.y - 3);
        b.im.poll();
        expect(b.mouseLook()).toEqual([5, -3]);
        expect(b.moves.at(0)).toEqual([CENTRE.x + 5, CENTRE.y - 3]);
    });

    test("relative motion after the restore is added to the saved position", () => {
        const a = rig();
        a.im.moveCursorTo(CENTRE.x, CENTRE.y);
        const saved = a.im.captureCursor();

        const b = rig();
        b.im.restoreCursor(saved);
        b.im.injectPointerDelta(7, 2);
        expect(b.mouseLook()).toEqual([7, 2]);
    });

    test("a move the window had not been told about yet is still owed after the restore", () => {
        const b = rig();
        b.im.restoreCursor({ x: 200, y: 100, movedX: 150, movedY: 100 });
        b.moves.length = 0;
        republishWithKey(b.view, 0x41);
        b.im.poll();
        expect(b.moves).toEqual([[200, 100]]);
        republishWithKey(b.view, 0x41);
        b.im.poll();
        expect(b.moves.length).toBe(1);
    });

    test("fifty capture and restore rounds end where they started", () => {
        let state = { x: 123, y: 45, movedX: 120, movedY: 45 };
        for (let i = 0; i < 50; i++) {
            const r = rig();
            r.im.restoreCursor(state);
            state = r.im.captureCursor();
        }
        expect(state).toEqual({ x: 123, y: 45, movedX: 120, movedY: 45 });
    });
});

describe("the cursor position in the user32-input participant", () => {
    const flag = globalThis as { __savestates?: unknown };
    const host = self as unknown as { postMessage: (m: unknown) => void };
    const savedPost = host.postMessage;
    const participant = (): Participant | undefined => savestateParticipants.all().find(p => p.id === "user32-input");

    afterEach(() => {
        delete flag.__savestates;
        host.postMessage = savedPost;
        System.getInstance().inputManager.restoreCursor({ x: 0, y: 0, movedX: 0, movedY: 0 });
    });

    test("is saved, restored and handed to the host, which keeps its own copy of the pointer", () => {
        flag.__savestates = true;
        createInputExports();
        const im = System.getInstance().inputManager;
        im.restoreCursor({ x: 311, y: 207, movedX: 311, movedY: 207 });
        const saved = participant()!.capture(newCaptureRun()) as unknown as User32InputState;
        expect(saved.cursor).toEqual({ x: 311, y: 207, movedX: 311, movedY: 207 });

        im.restoreCursor({ x: 0, y: 0, movedX: 0, movedY: 0 });
        const posted: unknown[] = [];
        host.postMessage = (m) => { posted.push(m); };
        participant()!.restore(structuredClone(saved) as unknown as SaveValue, { object: () => null, blob: () => new Uint8Array(0) });
        expect(im.captureCursor()).toEqual({ x: 311, y: 207, movedX: 311, movedY: 207 });
        expect(posted).toEqual([{ type: "set_cursor_pos", x: 311, y: 207 }]);
    });

    test("with savestates off nothing registers and the cursor is only what the host and the guest make it", () => {
        const before = participant();
        createInputExports();
        expect(participant()).toBe(before);
    });
});

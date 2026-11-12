import { afterEach, describe, expect, test } from "bun:test";
import { encodeValue, type SaveValue } from "../../src/worker/savestate/value-codec";
import { CaptureRefusal } from "../../src/worker/savestate/object-codecs";
import { savestateParticipants, type Participant } from "../../src/worker/savestate/participant";
import { newCaptureRun } from "../../src/worker/savestate/session";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { System } from "../../src/worker/core/system";
import {
    WINDOW_INFO_FIELDS, buttonCheckStates, getOrCreateListState, getOrCreateTrackbarState, windows,
    setCursorClipRect, type WindowInfo,
} from "../../src/worker/modules/user32/shared-state";
import { captureUser32State, registerUser32Participants, restoreUser32State } from "../../src/worker/modules/user32/savestate";
import { installHook, pushActiveHook, popActiveHook, resetHooks } from "../../src/worker/modules/user32/hooks";
import { createMenuExports, resetMenuState } from "../../src/worker/modules/user32/menu";
import { invalidateWindow, restorePaintRegions } from "../../src/worker/modules/user32/paint-region";
import { activeDialogs } from "../../src/worker/modules/user32/modal-dialog-state";
import { createMessageExports } from "../../src/worker/modules/user32/message";
import { createInputExports } from "../../src/worker/modules/user32/input";
import { createSystemExports } from "../../src/worker/modules/user32/system";
import { getOrCreateListViewState, resetListViewStatesForTests } from "../../src/worker/modules/user32/list-view-control";
import { getOrCreateTabState, resetTabStatesForTests } from "../../src/worker/modules/user32/tab-control";
import { resetRichEditStatesForTests, setRichEditContent } from "../../src/worker/modules/user32/rich-edit-control";
import { resetEditStatesForTests, setEditControlText } from "../../src/worker/modules/user32/edit-control";
import { purgeControlState } from "../../src/worker/modules/user32/shared-state";
import { clearTimerHandler } from "../../src/worker/core/scheduler/timer-wheel";
import { TimerKind } from "../../src/worker/core/scheduler/types";

const bytes = (v: unknown) => {
    const e = encodeValue(v as SaveValue);
    return { json: e.json, blobs: e.blobs.map(b => [...b]) };
};

const WS_VISIBLE = 0x10000000;
const WM_USER = 0x0400;
const WM_KEYDOWN = 0x0100;
const WM_MOUSEMOVE = 0x0200;

function populatedWindowManager(): WindowManager {
    const wm = new WindowManager();
    wm.registerClass({ name: 'GameClass', wndProc: 0x401000, hInstance: 0x400000, style: 3, hbrBackground: 0 });
    const main = wm.createWindow('GameClass', 'Game', WS_VISIBLE, 0, 10, 20, 640, 480, 0, 0, 0x400000, 0);
    const child = wm.createWindow('GameClass', 'Child', WS_VISIBLE | 0x40000000, 0, 0, 0, 32, 32, main, 0, 0x400000, 0);
    wm.setActiveWindow(main);
    wm.setFocus(child);
    const keys = new Uint8Array(256);
    keys[0x41] = 0x80;
    wm.postMessage(main, WM_USER + 1, 7, 9, 1, 2, 0, keys, 0x55);
    wm.postInputMessage(main, WM_KEYDOWN, 0x41, 0x1e0001, 3, 4, 0, keys);
    wm.postMessage(child, WM_MOUSEMOVE, 0, 0x00050006, 5, 6);
    wm.postMessage(main, 0x000f, 0, 0);
    return wm;
}

describe("window manager", () => {
    test("capture → restore → capture is byte-identical", () => {
        const wm = populatedWindowManager();
        const first = { wm: wm.captureState(), queue: wm.captureQueueState() };
        const fresh = new WindowManager();
        const copy = structuredClone(first);
        fresh.restoreState(copy.wm);
        fresh.restoreQueueState(copy.queue);
        expect(bytes({ wm: fresh.captureState(), queue: fresh.captureQueueState() })).toEqual(bytes(first));
    });

    test("restored queues hand out the same messages in the same order", () => {
        const wm = populatedWindowManager();
        const fresh = new WindowManager();
        fresh.restoreState(structuredClone(wm.captureState()));
        fresh.restoreQueueState(structuredClone(wm.captureQueueState()));
        const drain = (m: WindowManager) => {
            const out: unknown[] = [];
            for (let msg = m.getMessage(); msg; msg = m.getMessage()) {
                out.push([msg.hwnd, msg.message, msg.wParam, msg.lParam, msg.ptX, msg.ptY, msg.extraInfo ?? 0, msg.keyStatePacked ? [...msg.keyStatePacked] : null]);
            }
            return out;
        };
        const expected = drain(wm);
        expect(expected.length).toBeGreaterThan(2);
        expect(drain(fresh)).toEqual(expected);
    });

    test("a thread parked in GetMessage before the load cannot take a restored message", async () => {
        const wm = populatedWindowManager();
        const saved = { wm: wm.captureState(), queue: wm.captureQueueState() };
        const fresh = new WindowManager();
        void fresh.waitForMessage(0, 0, 0);
        fresh.restoreState(structuredClone(saved.wm));
        fresh.restoreQueueState(structuredClone(saved.queue));
        await new Promise(r => setTimeout(r, 15));
        expect(fresh.hasWaiters()).toBe(false);
        expect(bytes(fresh.captureQueueState())).toEqual(bytes(saved.queue));
    });

    test("a window keeps its shared class object", () => {
        const wm = populatedWindowManager();
        const fresh = new WindowManager();
        fresh.restoreState(structuredClone(wm.captureState()));
        const [a, b] = fresh.getAllWindows();
        expect(a!.wndClass).toBe(b!.wndClass);
        expect(a!.wndClass).toBe(fresh.getClass('GameClass')!);
    });
});

function windowInfo(handle: number, extra: Partial<WindowInfo> = {}): WindowInfo {
    return {
        handle, classId: 1, title: `w${handle}`, style: WS_VISIBLE, exStyle: 0, x: 1, y: 2, width: 300, height: 200,
        children: [], visible: true, wndProc: 0x401000, extraBytes: new Uint32Array([1, 2, 3]), ...extra,
    };
}

function resetUser32Stores(): void {
    windows.clear();
    buttonCheckStates.clear();
    resetHooks();
    resetMenuState();
    restorePaintRegions([]);
    activeDialogs.clear();
    setCursorClipRect(null);
    resetEditStatesForTests();
    resetRichEditStatesForTests();
    resetTabStatesForTests();
    resetListViewStatesForTests();
}

describe("user32 module state", () => {
    afterEach(resetUser32Stores);

    test("capture → restore → capture is byte-identical, restored over other state", () => {
        resetUser32Stores();
        windows.set(0x20001, windowInfo(0x20001, { children: [0x20002], hMenu: 0x50000 }));
        windows.set(0x20002, windowInfo(0x20002, { parent: 0x20001, controlId: 7, isSystemControl: true, systemControlClass: 'Button' }));
        buttonCheckStates.set(0x20002, 1);
        getOrCreateListState(0x20003).items.push({ text: 'a', data: 4 });
        getOrCreateTrackbarState(0x20004).pos = 33;
        invalidateWindow(0x20001, { left: 1, top: 2, right: 30, bottom: 40 }, true);
        installHook(2, 0x402000, 0x400000, 1);
        const menus = createMenuExports();
        const hMenu = menus.CreateMenu!({} as never, new Uint8Array(0), []);
        expect(hMenu).toBeGreaterThan(0);
        setCursorClipRect({ left: 0, top: 0, right: 100, bottom: 100 });

        const first = captureUser32State();
        const encoded = bytes(first);

        windows.set(0x29999, windowInfo(0x29999));
        installHook(3, 0x403000, 0, 0);
        buttonCheckStates.set(0x29999, 2);

        restoreUser32State(structuredClone(first));
        expect(bytes(captureUser32State())).toEqual(encoded);
        expect(windows.has(0x29999)).toBe(false);
    });

    test("every saved WindowInfo field reaches the capture", () => {
        resetUser32Stores();
        const base = windowInfo(0x20010);
        windows.set(base.handle, base);
        const before = JSON.stringify(bytes(captureUser32State()));
        for (const [field, policy] of Object.entries(WINDOW_INFO_FIELDS)) {
            if (policy !== 'save' || field === 'handle') continue;
            const changed = { ...base } as Record<string, unknown>;
            const v = changed[field];
            changed[field] = typeof v === 'number' ? v + 1 : typeof v === 'string' ? `${v}!` : Array.isArray(v) ? [...v, 9]
                : v instanceof Uint32Array ? new Uint32Array([9]) : typeof v === 'boolean' ? !v : field.endsWith('Bounds') ? { x: 1, y: 1, w: 1, h: 1 } : 1;
            windows.set(base.handle, changed as unknown as WindowInfo);
            expect({ field, same: JSON.stringify(bytes(captureUser32State())) === before }).toEqual({ field, same: false });
        }
    });

    test("refuses what v1 does not capture, and names it", () => {
        resetUser32Stores();
        activeDialogs.set(0x20020, { hwnd: 0x20020, dlgProc: 0, result: 0, closed: false });
        expect(() => captureUser32State()).toThrow('user32: a modal dialog is open');
        activeDialogs.clear();

        pushActiveHook(1);
        try {
            expect(() => captureUser32State()).toThrow('user32: a hook procedure is running');
        } finally {
            popActiveHook();
        }

        windows.set(0x20021, windowInfo(0x20021, { createInProgress: true }));
        expect(() => captureUser32State()).toThrow('is still being created');
    });

    test("each @refuse binding with a public way in makes the capture refuse", () => {
        resetUser32Stores();
        const control = windowInfo(0x20060, { isSystemControl: true });
        windows.set(control.handle, control);
        const cases: Array<[string, () => void, string]> = [
            ['list view', () => getOrCreateListViewState(control.handle), 'list view controls'],
            ['tab', () => getOrCreateTabState(control.handle), 'tab controls'],
            ['rich edit', () => setRichEditContent(control, 'x', []), 'rich edit controls'],
            ['edit', () => setEditControlText(control, 'x'), 'edit controls'],
        ];
        expect(() => captureUser32State()).not.toThrow();
        for (const [, arm, message] of cases) {
            arm();
            expect(() => captureUser32State()).toThrow(message);
            purgeControlState(control.handle);
            resetListViewStatesForTests();
            expect(() => captureUser32State()).not.toThrow();
        }
    });

    test("the participant turns a refusal into a CaptureRefusal", () => {
        resetUser32Stores();
        registerUser32Participants();
        const user32 = savestateParticipants.all().find(p => p.id === 'user32')!;
        activeDialogs.set(0x20030, { hwnd: 0x20030, dlgProc: 0, result: 0, closed: false });
        expect(() => user32.capture(newCaptureRun())).toThrow(CaptureRefusal);
        expect(user32.covers).toEqual(['user32']);
    });
});

describe("user32 export factories", () => {
    const flag = globalThis as { __savestates?: unknown };
    afterEach(() => { delete flag.__savestates; });

    const participant = (id: string): Participant => savestateParticipants.all().find(p => p.id === id)!;

    test("register their participants only while savestates are enabled", () => {
        const before = savestateParticipants.all().map(p => p.id);
        createInputExports();
        expect(savestateParticipants.all().map(p => p.id)).toEqual(before);
    });

    test("USER timers keep their ids, epochs and wheel ids through a fresh factory", () => {
        flag.__savestates = true;
        clearTimerHandler(TimerKind.USER32_TIMER);
        const api = createMessageExports();
        const ctx = {} as never, mem = new Uint8Array(0x1000);
        const wheel = System.getInstance().scheduler.timerWheel;
        expect(api.SetTimer!(ctx, mem, [0x20040, 5, 100, 0])).toBe(5);
        expect(api.SetTimer!(ctx, mem, [0, 0, 250, 0x401234])).toBeGreaterThan(0);
        try {
            const first = participant('user32-timers').capture(newCaptureRun());
            clearTimerHandler(TimerKind.USER32_TIMER);
            createMessageExports();
            const fresh = participant('user32-timers');
            fresh.restore(structuredClone(first), { object: () => null });
            expect(bytes(fresh.capture(newCaptureRun()))).toEqual(bytes(first));
            expect((first as { timers: unknown[] }).timers.length).toBe(2);
        } finally {
            for (const e of wheel.captureState().entries) wheel.cancel(e[0]!);
        }
    });

    test("window properties and SPI settings round-trip; a DDE instance does not refuse", () => {
        flag.__savestates = true;
        const input = createInputExports();
        createSystemExports();
        windows.set(0x20050, windowInfo(0x20050));
        const mem = new Uint8Array(0x1000);
        new TextEncoder().encodeInto('Prop\0', mem.subarray(0x100));
        expect(input.SetPropA!({} as never, mem, [0x20050, 0x100, 0x1234])).toBe(1);
        for (const id of ['user32-input', 'user32-system']) {
            const p = participant(id);
            const first = p.capture(newCaptureRun());
            p.restore(structuredClone(first), { object: () => null });
            expect(bytes(p.capture(newCaptureRun()))).toEqual(bytes(first));
        }
        windows.clear();
        expect(input.DdeInitializeA!({} as never, new Uint8Array(0x1000), [0x200, 0, 0, 0])).toBe(0);
        expect((participant('user32-input').capture(newCaptureRun()) as { ddeInstances: number[] }).ddeInstances).toEqual([1]);
    });
});

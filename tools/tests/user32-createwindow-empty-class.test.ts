/**
 * Class resolution at CreateWindowEx time, for windows created at run time rather than
 * from a dialog template.
 *
 * An empty class name names no registered class and fails with
 * ERROR_CANNOT_FIND_WND_CLASS (Wine WIN_CreateWindowEx). GTA2's network lobby creates a
 * fixed 30-slot control table per page and leaves the unused slots' class empty, relying
 * on the NULL HWND; a placeholder window there is an 800x600 top-level covering the
 * lobby, which swallowed every click on the chat box.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { windows } from '../../src/worker/modules/user32/shared-state';
import { System } from '../../src/worker/core/system';

// Above 0xFFFF: lower values are MAKEINTATOM class atoms, not string pointers.
const CLASS_PTR = 0x10100;
const NAME_PTR = 0x10200;
let mem: Uint8Array;
let api: Record<string, any>;
let lastError: number | undefined;
let savedSetLastError: unknown;

beforeEach(() => {
    mem = new Uint8Array(0x11000);
    windows.clear();
    api = createWindowExports();
    const scheduler = System.getInstance().scheduler as unknown as Record<string, unknown>;
    savedSetLastError = scheduler.setLastError;
    lastError = undefined;
    scheduler.setLastError = (code: number) => { lastError = code; };
});

afterEach(() => {
    (System.getInstance().scheduler as unknown as Record<string, unknown>).setLastError = savedSetLastError;
});

test('an empty class name fails with ERROR_CANNOT_FIND_WND_CLASS and creates nothing', () => {
    const before = windows.size;
    const hwnd = api.CreateWindowExA({} as never, mem,
        [0, CLASS_PTR, NAME_PTR, 0, 0, 0, 0, 0, 0x10001, 1050, 0x400000, 0]);
    expect(hwnd).toBe(0);
    expect(lastError).toBe(1407);
    expect(windows.size).toBe(before);
});

// The combobox class sizes itself at create time: cy budgets the dropped list, the
// window is the closed box. Without this a runtime-created combo (GTA2's map picker)
// painted a 130px sunken box over the controls below it.
test('a drop-down list combobox created at run time keeps its closed height', () => {
    mem.set(new TextEncoder().encode('ComboBox\0'), CLASS_PTR);
    const CBS_DROPDOWNLIST = 0x3, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000;
    api.CreateWindowExA({ esp: 0x10f00 } as never, mem,
        [0, CLASS_PTR, NAME_PTR, WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 298, 254, 270, 130, 0, 1026, 0x400000, 0]);
    const combo = [...windows.values()].find(w => w.controlId === 1026);
    expect(combo).toBeDefined();
    expect(combo!.height).toBeLessThan(40);
});

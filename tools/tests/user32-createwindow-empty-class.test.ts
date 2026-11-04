/**
 * CreateWindowEx with an empty class name names no registered class and fails with
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

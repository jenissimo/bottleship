import {expect, test} from 'bun:test';
import '../../src/worker/modules/user32/index';
import {System} from '../../src/worker/core/system';
import type {Process} from '../../src/worker/core/process';
import type {X86Context} from '../../src/worker/core/thunking/thunk-dispatcher';
import {createMessageExports} from '../../src/worker/modules/user32/message';
import {registerDialogItemExports} from '../../src/worker/modules/user32/dialog-items';
import {getOrCreateListState, purgeControlState, windows, type WindowInfo} from '../../src/worker/modules/user32/shared-state';
import type {ThunkImplementation} from '../../src/worker/core/thunking/thunk-dispatcher';

test('CB_SHOWDROPDOWN sent to a subclassed combo invokes its guest procedure', () => {
    const hwnd = 0x17420;
    const wndProc = 0x450000;
    const msg = 0x014f;
    const mem = new Uint8Array(1024);
    const sent: number[][] = [];
    const system = System.getInstance();
    const process = system.process;
    windows.set(hwnd, {
        handle: hwnd, wndProc, visible: true, style: 0x50000003, title: '',
        x: 0, y: 0, width: 100, height: 22, children: [],
        isSystemControl: true, systemControlClass: 'ComboBox', wndProcSubclassed: true,
    } as WindowInfo);
    system.process = {dispatcher: {callbackManager: {
        getStubPoolRange: () => ({base: 0x700000, end: 0x710000}),
        saveSuspendedThunkContext: () => 1,
        invokeCallback: (address: number, args: number[]) => {
            sent.push([address, ...args]);
            return {callbackId: 2};
        },
    }}} as unknown as Process;
    new DataView(mem.buffer).setUint32(32, 0x400000, true);
    try {
        const send = createMessageExports().SendMessageA!;
        const result = send({esp: 32} as X86Context, mem, [hwnd, msg, 0, 0]);
        expect(result).toMatchObject({suspendedForCallback: true, callbackId: 2, stackCleanup: 16});
        expect(sent).toEqual([[wndProc, hwnd, msg, 0, 0]]);
    } finally {
        windows.delete(hwnd);
        purgeControlState(hwnd);
        system.process = process;
    }
});

test('SendDlgItemMessage returns the selection from a subclassed listbox', () => {
    const dialog = 0x17421;
    const list = 0x17422;
    const controlId = 1363;
    const wndProc = 0x450000;
    const getSelection = 0x0188;
    const memory = new Uint8Array(1024);
    const ctx = {esp: 32} as X86Context;
    new DataView(memory.buffer).setUint32(ctx.esp, 0x400000, true);
    windows.set(dialog, {handle: dialog, children: [list]} as WindowInfo);
    const control = {
        handle: list, controlId, parent: dialog, wndProc, children: [],
        isSystemControl: true, systemControlClass: 'ListBox', wndProcSubclassed: true,
    } as WindowInfo;
    windows.set(list, control);
    getOrCreateListState(list).selectedIndex = 0;
    const system = System.getInstance();
    const process = system.process;
    const calls: {address: number; args: number[]; complete: (value: number) => number}[] = [];
    system.process = {dispatcher: {callbackManager: {
        getStubPoolRange: () => ({base: 0x700000, end: 0x710000}),
        saveSuspendedThunkContext: () => 1,
        invokeCallback: (address: number, args: number[], _flags: number, complete: (value: number) => number) => {
            calls.push({address, args, complete});
            return {callbackId: 2};
        },
    }}} as unknown as Process;
    const api: Record<string, ThunkImplementation> = {};
    registerDialogItemExports(api);
    const args = [dialog, controlId, getSelection, 0, 0];
    try {
        for (const send of [api.SendDlgItemMessageA!, api.SendDlgItemMessageW!]) {
            expect(send(ctx, memory, args)).toMatchObject({suspendedForCallback: true, callbackId: 2, stackCleanup: 20});
            const call = calls.pop()!;
            expect([call.address, ...call.args]).toEqual([wndProc, list, getSelection, 0, 0]);
            expect(call.complete(9)).toBe(9);
            expect(call.complete(-1)).toBe(0xffffffff);
        }
        control.wndProcSubclassed = false;
        expect(api.SendDlgItemMessageA!(ctx, memory, args)).toBe(0);
        expect(calls).toHaveLength(0);
    } finally {
        purgeControlState(list);
        windows.delete(list);
        windows.delete(dialog);
        system.process = process;
    }
});

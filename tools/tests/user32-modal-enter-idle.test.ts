import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { activeDialogs, resetDialogPumps } from '../../src/worker/modules/user32/modal-dialog-state';
import { windows } from '../../src/worker/modules/user32/shared-state';
import { createDialogExports } from '../../src/worker/modules/user32/dialog';
import { System } from '../../src/worker/core/system';

const tick = (ms = 20) => new Promise<void>(r => setTimeout(r, ms));
const WM_INITDIALOG = 0x0110;
const WM_ENTERIDLE = 0x0121;
const WM_USER = 0x0400;
const OWNER = 0x7f001;
const OWNER_PROC = 0x405000;

interface Invocation { wndProc: number; args: number[]; complete?: (ret: number) => number | null }

// runOwnedDialog installs a stand-in process; later test files must not inherit it.
const systemSlot = System.getInstance() as unknown as { process: unknown };
const realProcess = systemSlot.process;
afterAll(() => { systemSlot.process = realProcess; });

function runOwnedDialog(withOwner: boolean) {
    const invocations: Invocation[] = [];
    const system = System.getInstance();
    (system as unknown as { process: unknown }).process = {
        getModule: () => undefined,
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 91,
                abandonSuspendedFrame: () => true,
                invokeCallback: (wndProc: number, args: number[], _c: number, complete?: (ret: number) => number | null) => {
                    invocations.push({ wndProc, args, complete });
                    return { callbackId: 0x3000 + invocations.length };
                },
            },
        },
    };
    if (withOwner) {
        windows.set(OWNER, { handle: OWNER, wndProc: OWNER_PROC, style: 0x10000000, children: [] } as never);
    }
    const api = createDialogExports();
    api['DialogBoxIndirectParamA']!(
        { esp: 0x800, returnAddr: 0x401000 } as never, new Uint8Array(0x1000),
        [0x400000, 0, withOwner ? OWNER : 0, 0x402000, 0],
    );
    const dialogHwnd = [...activeDialogs.keys()][0]!;
    system.windowManager.postMessage(dialogHwnd, WM_USER, 0, 0);
    invocations[0]!.complete!(0);
    return { invocations, dialogHwnd };
}

async function settle(inv: Invocation[]): Promise<void> {
    let done = 1;
    for (let i = 0; i < 15; i++) {
        await tick(15);
        while (done < inv.length) inv[done++]!.complete?.(0);
    }
}

describe('a modal dialog loop that runs out of messages', () => {
    beforeEach(() => {
        resetDialogPumps();
        windows.delete(OWNER);
        const wm = System.getInstance().windowManager;
        while (wm.getMessage()) { /* drain */ }
    });

    test('sends WM_ENTERIDLE(MSGF_DIALOGBOX, hDlg) to the owner once per idle stretch', async () => {
        const { invocations, dialogHwnd } = runOwnedDialog(true);
        await settle(invocations);
        const idle = invocations.filter(i => i.args[1] === WM_ENTERIDLE);
        expect(idle.length).toBe(1);
        expect(idle[0]!.wndProc).toBe(OWNER_PROC);
        expect(idle[0]!.args).toEqual([OWNER, WM_ENTERIDLE, 0, dialogHwnd]);
        System.getInstance().windowManager.postMessage(dialogHwnd, WM_USER, 0, 0);
        await settle(invocations);
        expect(invocations.filter(i => i.args[1] === WM_ENTERIDLE).length).toBe(2);
    });

    test('negative control: a dialog without an owner sends nothing', async () => {
        const { invocations } = runOwnedDialog(false);
        await settle(invocations);
        expect(invocations.some(i => i.args[1] === WM_ENTERIDLE)).toBe(false);
    });
});

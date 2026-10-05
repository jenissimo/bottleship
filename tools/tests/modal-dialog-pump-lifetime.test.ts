/**
 * The modal-dialog pump is bound to the process that armed it.
 *
 * A pump dispatches through a suspended thunk frame that dies with its process,
 * but it re-arms itself from setTimeout, which does not. These tests pin the rule
 * that a pump armed against process A is inert after A is torn down — otherwise a
 * surviving pump fires into the next guest loaded into the same worker, where its
 * frame does not exist.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    activeDialogs,
    createPumpScheduler,
    resetDialogPumps,
} from '../../src/worker/modules/user32/modal-dialog-state';
import { createDialogExports } from '../../src/worker/modules/user32/dialog';
import { System } from '../../src/worker/core/system';

const tick = (ms = 20) => new Promise<void>(r => setTimeout(r, ms));

describe('modal dialog pump lifetime', () => {
    beforeEach(() => resetDialogPumps());

    test('a step armed before teardown never runs after it', async () => {
        const pump = createPumpScheduler();
        let steps = 0;
        pump.schedule(() => { steps++; }, 0);

        resetDialogPumps(); // process A torn down / next bundle loaded

        await tick();
        expect(steps).toBe(0);
        expect(pump.isLive()).toBe(false);
    });

    test('an idle-yield step (the 8 ms poll) is cancelled by teardown', async () => {
        const pump = createPumpScheduler();
        let steps = 0;
        pump.schedule(() => { steps++; }, 8);

        resetDialogPumps();

        await tick(40);
        expect(steps).toBe(0);
    });

    test('a torn-down pump cannot re-arm itself', async () => {
        const pump = createPumpScheduler();
        let steps = 0;
        const step = () => { steps++; pump.schedule(step, 0); };
        pump.schedule(step, 0);

        await tick();
        expect(steps).toBeGreaterThan(0);
        const before = steps;

        resetDialogPumps();
        await tick();
        expect(steps).toBe(before);
    });

    test('a pump armed after teardown still runs', async () => {
        resetDialogPumps();
        const pump = createPumpScheduler();
        let steps = 0;
        pump.schedule(() => { steps++; }, 0);

        await tick();
        expect(steps).toBe(1);
        expect(pump.isLive()).toBe(true);
    });

    test('abandon() is terminal — no further step is ever armed', async () => {
        const pump = createPumpScheduler();
        let steps = 0;
        pump.abandon();
        pump.schedule(() => { steps++; }, 0);

        await tick();
        expect(steps).toBe(0);
        expect(pump.isLive()).toBe(false);
    });

    test('teardown clears the active-dialog registry', () => {
        activeDialogs.set(0x1234, { hwnd: 0x1234, dlgProc: 0x401000, result: 0, closed: false });
        resetDialogPumps();
        expect(activeDialogs.size).toBe(0);
    });
});

describe('modal dialog pump wiring', () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8');
    const dialogSrc = read('../../src/worker/modules/user32/dialog.ts');

    test('the pump only re-arms through the lifetime-bound scheduler', () => {
        expect(dialogSrc).not.toMatch(/setTimeout\(\s*pumpStep/);
    });

    test('a step observing a dead process stops instead of re-arming', () => {
        const idx = dialogSrc.indexOf('const pumpStep = ()');
        expect(idx).toBeGreaterThan(0);
        const head = dialogSrc.slice(idx, idx + 400);
        expect(head).toContain('system.isExiting');
        expect(head).toContain('pumpScheduler.abandon()');
    });

    test('a user32 reset makes every armed pump inert', () => {
        const indexSrc = read('../../src/worker/modules/user32/index.ts');
        expect(indexSrc).toContain('resetDialogPumps()');
    });
});

/**
 * What a pump that cannot dispatch owes the guest.
 *
 * DialogBoxParam is SUSPENDED in a thunk frame for the dialog's whole life: the guest
 * thread sits at the spin loop and only the dialog's own teardown ever hands it a return
 * value. So "the pump gives up" is not a local decision — a pump that stops without
 * ending the dialog strands that thread for good, and with the registry entry gone
 * nothing can end it afterwards either.
 */
const FRAME_ID = 77;
const WM_INITDIALOG = 0x0110;

interface Invocation { wndProc: number; args: number[]; complete?: (ret: number) => number | null }

/** Drive DialogBoxIndirectParam with no template (400x300, no children) over a stub
 *  callback manager, so every x86 dispatch is a value this test chooses. */
function runDialog(dispatchAnswers: () => number, pendingMessages = 64) {
    const invocations: Invocation[] = [];
    const abandonedFrames: number[] = [];
    const system = System.getInstance();
    (system as unknown as { process: unknown }).process = {
        getModule: () => undefined,
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => FRAME_ID,
                abandonSuspendedFrame: (id: number) => { abandonedFrames.push(id); return true; },
                invokeCallback: (
                    wndProc: number, args: number[], _cleanup: number,
                    complete?: (ret: number) => number | null,
                ) => {
                    invocations.push({ wndProc, args, complete });
                    // WM_INITDIALOG must get through, or the pump never starts.
                    const isInit = args[1] === WM_INITDIALOG;
                    return { callbackId: isInit ? 0x1000 : dispatchAnswers() };
                },
            },
        },
    };

    const api = createDialogExports();
    const mem = new Uint8Array(0x1000);
    const result = api['DialogBoxIndirectParamA']!(
        { esp: 0x800, returnAddr: 0x401000 } as never, mem,
        [0x400000, 0 /* no template */, 0, 0x402000 /* dlgProc */, 0],
    ) as { suspendedForCallback?: boolean };

    const dialogHwnd = [...activeDialogs.keys()][0]!;
    // Something for the pump to deliver on every step; without a message it just polls.
    for (let i = 0; i < pendingMessages; i++) {
        system.windowManager.postMessage(dialogHwnd, 0x0400 /* WM_USER */, 0, 0);
    }
    // WM_INITDIALOG returns → initCompleteThunk arms the pump.
    invocations[0]!.complete!(0);
    return { result, invocations, abandonedFrames, dialogHwnd };
}

const pumpDispatches = (inv: Invocation[]): Invocation[] =>
    inv.filter((i) => i.args[1] !== WM_INITDIALOG);

describe('a modal pump that cannot dispatch', () => {
    beforeEach(() => {
        resetDialogPumps();
        const wm = System.getInstance().windowManager;
        while (wm.getMessage()) { /* drain the previous case's queue */ }
    });

    test('a callbackId of 0 is retried, not taken as the end of the dialog', async () => {
        // The nesting limit refuses the dispatch and then unwinds — the dialog is alive
        // and the very next step gets through. Treating the first refusal as terminal
        // kills a healthy dialog (and, before this, stranded its caller).
        let refusals = 3;
        const { invocations, dialogHwnd } = runDialog(() => (refusals-- > 0 ? 0 : 0x2000));

        await tick(300);

        expect(pumpDispatches(invocations).length).toBeGreaterThan(3);
        expect(activeDialogs.has(dialogHwnd)).toBe(true);   // still a live dialog
    });

    test('a permanently refused dispatch ends the dialog and completes the frame', async () => {
        const { invocations, abandonedFrames, dialogHwnd } = runDialog(() => 0);

        await tick(500);

        // Bounded: it gives up, but only after the transient case has had its chances.
        expect(pumpDispatches(invocations).length).toBeGreaterThan(1);
        // And giving up ENDS the dialog: registry entry gone AND the suspended
        // DialogBoxParam frame released, rather than a guest thread parked forever.
        expect(activeDialogs.has(dialogHwnd)).toBe(false);
        expect(abandonedFrames).toEqual([FRAME_ID]);
    });
});

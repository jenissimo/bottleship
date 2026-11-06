import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import {
    postActivationTransition, resetPostedActivations, WA_ACTIVE, WA_INACTIVE, WM_ACTIVATE,
} from '../../src/worker/modules/user32/activation-messages';

const CONSOLE = 0x10003, GAME = 0x10005, OTHER = 0x10007;
const wm = System.getInstance().windowManager;

function queued(): Array<[number, number, number, number]> {
    const out: Array<[number, number, number, number]> = [];
    wm.removePostedMessages((m) => {
        out.push([m.hwnd, m.message, m.wParam, m.lParam]);
        return false;
    });
    return out;
}

const activations = () => queued().filter(([, msg]) => msg === WM_ACTIVATE);

beforeEach(() => {
    wm.removePostedMessages(() => true);
    resetPostedActivations();
});

afterEach(() => {
    wm.removePostedMessages(() => true);
    resetPostedActivations();
});

test('a later switch removes the activation USER queued for the window it no longer activates', () => {
    postActivationTransition(CONSOLE, OTHER);
    postActivationTransition(GAME, CONSOLE);
    expect(activations()).toEqual([
        [OTHER, WM_ACTIVATE, WA_INACTIVE, CONSOLE],
        [CONSOLE, WM_ACTIVATE, WA_INACTIVE, GAME],
        [GAME, WM_ACTIVATE, WA_ACTIVE, CONSOLE],
    ]);
});

test('a WM_ACTIVATE the application posted itself is never removed', () => {
    wm.postMessage(CONSOLE, WM_ACTIVATE, WA_ACTIVE, 0);
    postActivationTransition(GAME, CONSOLE);
    expect(activations()).toEqual([
        [CONSOLE, WM_ACTIVATE, WA_ACTIVE, 0],
        [CONSOLE, WM_ACTIVATE, WA_INACTIVE, GAME],
        [GAME, WM_ACTIVATE, WA_ACTIVE, CONSOLE],
    ]);
});

test('the activation of the window that stays active is kept', () => {
    postActivationTransition(GAME, OTHER);
    postActivationTransition(GAME, GAME);
    expect(activations().filter(([h, , w]) => h === GAME && w === WA_ACTIVE).length).toBe(2);
});

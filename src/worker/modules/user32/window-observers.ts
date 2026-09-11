/**
 * Everything user32 hangs off the WindowManager's chokepoints, in one place.
 *
 * The manager owns the events (a window became active, the foreground queue switched, the
 * mouse needs a Z-order or a visibility answer); user32 owns the STATE those events act on
 * (the owner chain, the sibling list, WS_VISIBLE, the cursor clip). Registering them one by
 * one at each call site is how a second, drifting copy of that state grows next to user32's.
 */
import type { WindowManager } from '../../runtime/windowing/window-manager';
import { recordLastActive } from './activation-messages';
import { getChildZOrder, getWindowHitTestState, releaseCursorClipOnForegroundSwitch } from './shared-state';

export function installUser32WindowObservers(wm: WindowManager): void {
    // WindowFromPoint hit-tests siblings in Z-order, and user32 owns that list.
    wm.registerChildZOrderProvider(getChildZOrder);
    // ...and it owns visible/enabled too; a copy in the manager only the mouse reads goes
    // stale silently (EnableWindow never mirrored it).
    wm.registerWindowStateProvider(getWindowHitTestState);
    // ...and the owner chain, so "last active popup" is recorded wherever activation
    // happens (click-activate included), not only in the SetActiveWindow export.
    wm.registerActivationObserver(recordLastActive);
    // The cursor clip is a global input mode Windows drops when the foreground input queue
    // switches; without this the pointer stays trapped in the rect of an app that is no
    // longer in front.
    wm.registerForegroundQueueObserver(releaseCursorClipOnForegroundSwitch);
}

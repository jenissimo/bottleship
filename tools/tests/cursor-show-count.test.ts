/**
 * ShowCursor's display count belongs to the GUEST.
 *
 * NT zzzShowCursor (ntuser/kernel/cursor.c) is a plain counter — `pq->iCursorLevel`
 * incremented on TRUE, decremented on FALSE, no floor — and the value it returns is what
 * the app reads back to decide whether it still owes a matching call. Windows changes it
 * for nobody else: it does not re-show the pointer because a dialog appeared, and it does
 * not clamp a nested hide.
 *
 * Both rules were broken here at once, and the pair is what made Worms World Party draw
 * two pointers in its menu: the game hides the OS cursor with ShowCursor(FALSE) twice in
 * InitInstance (w2.exe FUN_0057cb20, statically confirmed) and then draws its own — but a
 * `#32770` overlay paint reset the count to 0 on every repaint, so our host kept drawing
 * an arrow next to the game's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describePointerPolicy, resetPointerPolicy, setExclusiveMouseOwner } from "../../src/worker/core/pointer-policy";
import { serializeCursor } from "../../src/worker/harness/serialize";
import { createWindowExports } from "../../src/worker/modules/user32/window";
import {
    getCursorDisplayCount, isGuestCursorVisible, resetUser32SharedState,
} from "../../src/worker/modules/user32/shared-state";

let api: Record<string, any>;
const showCursor = (show: number) => api.ShowCursor({} as any, new Uint8Array(), [show]);

beforeEach(() => {
    resetUser32SharedState();
    api = createWindowExports();
});

afterEach(() => {
    resetUser32SharedState();
    resetPointerPolicy();
});

describe("ShowCursor display count", () => {
    test("is a running total, and a nested hide is not clamped", () => {
        expect(showCursor(0)).toBe(-1);
        expect(showCursor(0)).toBe(-2);
        expect(getCursorDisplayCount()).toBe(-2);
        expect(isGuestCursorVisible()).toBe(false);
        expect(describePointerPolicy().outputs.pointerShown).toBe(false);

        // One TRUE cancels ONE FALSE. A clamped counter would report 0 here and re-show a
        // pointer the outer level still wants hidden.
        expect(showCursor(1)).toBe(-1);
        expect(isGuestCursorVisible()).toBe(false);
        expect(describePointerPolicy().outputs.pointerShown).toBe(false);

        expect(showCursor(1)).toBe(0);
        expect(isGuestCursorVisible()).toBe(true);
        expect(describePointerPolicy().outputs.pointerShown).toBe(true);
    });

    test("the idiomatic force-hide loop terminates at the level it reached", () => {
        // `while (ShowCursor(FALSE) >= 0);` — a clamp turns this into an infinite loop's
        // worth of calls collapsing onto one level.
        let n = 0;
        for (let i = 0; i < 5; i++) n = showCursor(0);
        expect(n).toBe(-5);
        expect(showCursor(1)).toBe(-4);
    });
});

describe("state([\"cursor\"]) reports the host's decision, not a second derivation", () => {
    test("an exclusive DirectInput mouse hides the pointer with no Win32 call", () => {
        const owner = {};
        setExclusiveMouseOwner(owner, true);
        try {
            const c = serializeCursor() as any;
            // The Win32 half never moved — a serializer that re-derives visibility from
            // it reports a pointer the host was told not to draw.
            expect(c.win32Visible).toBe(true);
            expect(c.visible).toBe(false);
            expect(c.pointerPolicy.facts.exclusiveMouse).toBe(true);
        } finally {
            setExclusiveMouseOwner(owner, false);
        }
    });
});

/**
 * A behavioural test cannot reach the overlay painter without a live GDI context, so the
 * rule is pinned where it is actually enforceable: the count and the installed handle have
 * exactly ONE mutator each, and both live in the module that owns them. Anything that
 * wants a pointer of its own goes through core/pointer-policy's host override instead.
 */
describe("cursor state has one owner", () => {
    const src = readFileSync("src/worker/modules/user32/shared-state.ts", "utf8");
    const enclosingFunction = (assignmentRegex: RegExp): string[] => {
        const owners: string[] = [];
        let current = "<module scope>";
        for (const line of src.split(/\r?\n/)) {
            const fn = /^(?:export )?function ([A-Za-z0-9_]+)/.exec(line);
            if (fn) current = fn[1];
            if (/^\s*(?:export\s+)?(?:let|const|var)\s/.test(line)) continue; // the declaration
            if (assignmentRegex.test(line)) owners.push(current);
        }
        return owners;
    };

    // An assignment ANYWHERE on the line, not just at its start: the write that made this
    // necessary was `if (cursorDisplayCount < 0) cursorDisplayCount = 0;`, which a
    // start-anchored census reads as no write at all.
    const assignedIn = (name: string) => enclosingFunction(new RegExp(`${name}\\s*(?:\\+=|-=|=(?!=))`));

    test("cursorDisplayCount is written only by its update and the reset", () => {
        expect(new Set(assignedIn("cursorDisplayCount")))
            .toEqual(new Set(["updateCursorDisplayCount", "resetUser32SharedState"]));
    });

    test("currentCursorHandle is written only by SetCursor's setter and the reset", () => {
        expect(new Set(assignedIn("currentCursorHandle")))
            .toEqual(new Set(["setCurrentCursorHandle", "resetUser32SharedState"]));
    });

    test("no module outside user32 shared-state can force the guest's cursor state", () => {
        // The mutators above are module-private `let`s, so the only reachable override
        // would be a shared-state export that resets them. There is none.
        expect(src).not.toMatch(/export function \w*[Ee]nsure\w*Cursor\w*\(/);
    });
});

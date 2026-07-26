// The latch has to answer BEFORE a game boots, so the cases that matter are the
// ones where nothing has touched the canvas yet: a tap on the library screen, and
// a fresh page load that has to fall back on what it remembered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    getPointerKind,
    installPointerKindWatcher,
    kindOfPointerType,
    notePointerKind,
    resetPointerKind,
    subscribePointerKind,
} from "../../src/input/pointer-kind";

/** Minimal EventTarget stand-in — the watcher only needs add/removeEventListener. */
class FakeTarget implements EventTarget {
    private handlers = new Map<string, Set<EventListener>>();

    addEventListener(type: string, fn: EventListenerOrEventListenerObject | null): void {
        if (typeof fn !== "function") return;
        let set = this.handlers.get(type);
        if (!set) this.handlers.set(type, (set = new Set()));
        set.add(fn);
    }

    removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null): void {
        if (typeof fn !== "function") return;
        this.handlers.get(type)?.delete(fn);
    }

    dispatchEvent(event: Event): boolean {
        for (const fn of this.handlers.get(event.type) ?? []) fn(event);
        return true;
    }

    get listenerCount(): number {
        let n = 0;
        for (const set of this.handlers.values()) n += set.size;
        return n;
    }

    emit(type: string, pointerType: string): void {
        this.dispatchEvent({ type, pointerType } as unknown as Event);
    }
}

beforeEach(() => resetPointerKind());
afterEach(() => resetPointerKind());

describe("the latch", () => {
    test("starts empty when nothing was ever used", () => {
        expect(getPointerKind()).toBeNull();
    });

    test("notifies subscribers synchronously, so a downstream handler sees the new value", () => {
        let seenDuringDispatch: string | null = null;
        subscribePointerKind(() => { seenDuringDispatch = getPointerKind(); });
        notePointerKind("touch");
        expect(seenDuringDispatch).toBe("touch");
    });

    test("an unchanged kind does not re-notify", () => {
        let calls = 0;
        subscribePointerKind(() => { calls++; });
        notePointerKind("touch");
        notePointerKind("touch");
        expect(calls).toBe(1);
    });

    test("flips back to mouse — a tablet with a Bluetooth mouse switches both ways", () => {
        notePointerKind("touch");
        notePointerKind("mouse");
        expect(getPointerKind()).toBe("mouse");
    });

    test("unsubscribing stops delivery", () => {
        let calls = 0;
        const off = subscribePointerKind(() => { calls++; });
        notePointerKind("touch");
        off();
        notePointerKind("mouse");
        expect(calls).toBe(1);
    });
});

describe("kindOfPointerType", () => {
    test("maps the three DOM values", () => {
        expect(kindOfPointerType("touch")).toBe("touch");
        expect(kindOfPointerType("pen")).toBe("pen");
        expect(kindOfPointerType("mouse")).toBe("mouse");
    });

    test("an unknown or empty pointerType is a mouse, as the DOM defaults", () => {
        expect(kindOfPointerType("")).toBe("mouse");
        expect(kindOfPointerType("wand")).toBe("mouse");
    });
});

describe("the document watcher", () => {
    test("a tap anywhere counts — the library screen never mounts the emulator", () => {
        const target = new FakeTarget();
        installPointerKindWatcher(target);
        target.emit("pointerdown", "touch");
        expect(getPointerKind()).toBe("touch");
    });

    test("a hovering mouse latches without any click", () => {
        const target = new FakeTarget();
        installPointerKindWatcher(target);
        target.emit("pointermove", "mouse");
        expect(getPointerKind()).toBe("mouse");
    });

    test("uninstall detaches every listener it added", () => {
        const target = new FakeTarget();
        const uninstall = installPointerKindWatcher(target);
        expect(target.listenerCount).toBeGreaterThan(0);
        uninstall();
        expect(target.listenerCount).toBe(0);
        target.emit("pointerdown", "touch");
        expect(getPointerKind()).toBeNull();
    });

    test("an event with no pointerType is ignored rather than counted as a mouse", () => {
        const target = new FakeTarget();
        installPointerKindWatcher(target);
        target.dispatchEvent({ type: "pointerdown" } as Event);
        expect(getPointerKind()).toBeNull();
    });
});

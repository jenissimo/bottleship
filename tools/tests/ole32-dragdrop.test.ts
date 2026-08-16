import { describe, expect, test } from "bun:test";
import {
    DragDropRegistry,
    DRAGDROP_E_ALREADYREGISTERED,
    DRAGDROP_E_INVALIDHWND,
    DRAGDROP_E_NOTREGISTERED,
    E_INVALIDARG,
    E_OUTOFMEMORY,
    S_OK,
} from "../../src/worker/modules/ole32-dragdrop";
import { ole32Module } from "../../src/worker/api/ole32.api";

describe("ole32 drag-and-drop registration", () => {
    test("publishes the documented stdcall signatures", () => {
        const register = ole32Module.functions.find(({ name }) => name === "RegisterDragDrop");
        const revoke = ole32Module.functions.find(({ name }) => name === "RevokeDragDrop");

        expect(register?.callingConvention).toBe("stdcall");
        expect(register?.params.map(({ name, type }) => [name, type])).toEqual([
            ["hwnd", "handle"], ["pDropTarget", "ptr"],
        ]);
        expect(revoke?.callingConvention).toBe("stdcall");
        expect(revoke?.params.map(({ name, type }) => [name, type])).toEqual([["hwnd", "handle"]]);
    });

    test("requires OleInitialize, validates inputs, and owns one COM reference", () => {
        let oleInitialized = false;
        const windows = new Set([0x100]);
        const calls: string[] = [];
        const registry = new DragDropRegistry({
            isOleInitialized: () => oleInitialized,
            isWindowValid: (hwnd) => windows.has(hwnd),
            addRef: (target) => calls.push(`add:${target}`),
            release: (target) => calls.push(`release:${target}`),
        });

        expect(registry.register(0x100, 0x200)).toBe(E_OUTOFMEMORY);
        expect(calls).toEqual([]);

        oleInitialized = true;
        expect(registry.register(0x100, 0)).toBe(E_INVALIDARG);
        expect(registry.register(0, 0x200)).toBe(DRAGDROP_E_INVALIDHWND);
        expect(registry.register(0x100, 0x200)).toBe(S_OK);
        expect(registry.register(0x100, 0x300)).toBe(DRAGDROP_E_ALREADYREGISTERED);
        expect(calls).toEqual(["add:512"]);

        expect(registry.revoke(0x100)).toBe(S_OK);
        expect(registry.revoke(0x100)).toBe(DRAGDROP_E_NOTREGISTERED);
        expect(registry.revoke(0)).toBe(DRAGDROP_E_INVALIDHWND);
        expect(calls).toEqual(["add:512", "release:512"]);
    });

    test("window destruction revokes the registration, so a recycled HWND registers again", () => {
        const calls: string[] = [];
        let windowAlive = true;
        const registry = new DragDropRegistry({
            isOleInitialized: () => true,
            isWindowValid: () => windowAlive,
            addRef: (target) => calls.push(`add:${target}`),
            release: (target) => calls.push(`release:${target}`),
        });

        expect(registry.register(0x100, 0x200)).toBe(S_OK);
        windowAlive = false;
        registry.windowDestroyed(0x100);
        expect(calls).toEqual(["add:512", "release:512"]);

        // The handle is recycled by a new window: registration must be available again.
        windowAlive = true;
        expect(registry.register(0x100, 0x300)).toBe(S_OK);
        expect(calls).toEqual(["add:512", "release:512", "add:768"]);

        // An unregistered window destroyed is not an error and releases nothing.
        registry.windowDestroyed(0x999);
        expect(calls).toEqual(["add:512", "release:512", "add:768"]);
    });

    test("reset releases every outstanding target and removes every registration", () => {
        const calls: string[] = [];
        const registry = new DragDropRegistry({
            isOleInitialized: () => true,
            isWindowValid: () => true,
            addRef: (target) => calls.push(`add:${target}`),
            release: (target) => calls.push(`release:${target}`),
        });

        expect(registry.register(0x100, 0x200)).toBe(S_OK);
        expect(registry.register(0x101, 0x201)).toBe(S_OK);
        registry.reset();

        expect(calls).toEqual(["add:512", "add:513", "release:512", "release:513"]);
        expect(registry.revoke(0x100)).toBe(DRAGDROP_E_NOTREGISTERED);
        registry.reset();
        expect(calls).toEqual(["add:512", "add:513", "release:512", "release:513"]);
    });
});

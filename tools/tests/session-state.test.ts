import { describe, expect, test } from "bun:test";
import { SessionStateRegistry } from "../../src/worker/core/session-state";
import { System } from "../../src/worker/core/system";
import { sessionState } from "../../src/worker/core/session-state";

describe("session state registry", () => {
    test("resets one phase in registration order and keeps going past a failure", () => {
        const reg = new SessionStateRegistry();
        const order: string[] = [];
        reg.register({ id: 'a', phase: 'subsystems', reset: () => order.push('a') });
        reg.register({ id: 'x', phase: 'game-switch', reset: () => order.push('x') });
        reg.register({ id: 'b', phase: 'subsystems', reset: () => { throw new Error('boom'); } });
        reg.register({ id: 'c', phase: 'subsystems', reset: () => order.push('c') });
        const failures = reg.resetPhase('subsystems');
        expect(order).toEqual(['a', 'c']);
        expect(failures.map(f => f.id)).toEqual(['b']);
    });

    test("re-registering an id replaces the entry in place; the disposer removes it", () => {
        const reg = new SessionStateRegistry();
        const seen: number[] = [];
        reg.register({ id: 'a', phase: 'subsystems', reset: () => seen.push(1) });
        reg.register({ id: 'b', phase: 'subsystems', reset: () => seen.push(2) });
        const dispose = reg.register({ id: 'a', phase: 'subsystems', reset: () => seen.push(3) });
        reg.resetPhase('subsystems');
        expect(seen).toEqual([3, 2]);
        dispose();
        expect(reg.ids()).toEqual(['b']);
    });

    test("System registers its per-session stores in reset order", () => {
        System.getInstance();
        expect(sessionState.ids('game-switch')).toEqual(['time', 'video-engine', 'lib-hle', 'hooks', 'gpu-resources', 'hypercall-tables', 'implicit-tls']);
        expect(sessionState.ids('subsystems')).toEqual([
            'load-diagnostics', 'window-manager', 'gdi', 'input', 'services', 'video-routing', 'com-resources', 'scheduler',
            'memory-watch', 'leases', 'memory-events', 'seh-dispatch', 'named-objects', 'profiler', 'frame-profiler',
        ]);
    });
});

import { censusOf } from "../validate-session-state";

describe("session-state census", () => {
    test("counts module-scope and factory-scope mutable bindings, skips annotated ones", () => {
        const src = [
            "let counter = 0;",
            "export const cache = new Map<number, string>();",
            "const TABLE = { a: 1 };",
            "const list = [];",
            "// @transient(diagnostics ring)",
            "const ring = new Array(64);",
            "let seen = new Set(); // @session-state",
            "export function createFooExports(ctx: unknown) {",
            "    const handles = new Map();",
            "    let next = 1;",
            "    const fixed = 3;",
            "    function inner() { let x = 0; }",
            "}",
            "function helper() {",
            "    let local = 1;",
            "}",
        ].join("\n");
        expect(censusOf(src)).toBe(5);
    });
});

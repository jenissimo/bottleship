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
            'load-diagnostics', 'crt-binding', 'window-manager', 'gdi', 'input', 'services', 'video-routing', 'com-resources', 'scheduler',
            'memory-watch', 'leases', 'memory-events', 'seh-dispatch', 'named-objects', 'profiler', 'frame-profiler',
            'process-startup-info',
        ]);
    });
});

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { censusOf, coveredModulesOf, moduleOfFile, runCensus, statelessModulesOf, stripNonCode } from "../validate-session-state";

describe("session-state census", () => {
    test("names module-scope and factory-scope mutable bindings, skips ones with a stated reason", () => {
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
        expect(censusOf(src).names).toEqual(["counter", "cache", "list", "seen", "createFooExports.handles", "createFooExports.next"]);
    });

    test("sees arrow factories, class singletons, static fields, => in types, any indentation", () => {
        const src = [
            "export const registry = new HandleRegistry();",
            "const h: Map<number, () => void> = new Map();",
            "const scratch = new DataView(new ArrayBuffer(8)); // @transient(scratch)",
            "export const createBarExports = (ctx: { a: number }): Record<string, unknown> => {",
            "  let next = 1;",
            "  const byId = new Map<number, string>();",
            "  const helper = () => { let inner = 0; };",
            "  return {};",
            "};",
            "export const createBazExports = function () {",
            "\tlet count = 0;",
            "};",
            "export class Cache {",
            "    private static instance: Cache | null = null;",
            "    private static readonly map = new Map<string, number>();",
            "    static readonly LIMIT = 4;",
            "    static get(): Cache { return Cache.instance!; }",
            "}",
            "const doc = `let notBinding = 1; ${`nested ${'{'}`}`;",
            "const re = /[{]let x/g;",
        ].join("\n");
        expect(censusOf(src).names).toEqual([
            "registry", "h", "createBarExports.next", "createBarExports.byId", "createBazExports.count",
            "static Cache.instance", "static Cache.map",
        ]);
    });

    test("@transient() with an empty reason is reported and does not exempt", () => {
        const c = censusOf(["let a = 0; // @transient()", "// @transient(   )", "let b = 0;"].join("\n"));
        expect(c.names).toEqual(["a", "b"]);
        expect(c.emptyReasons).toEqual([1, 3]);
    });

    test("@participant and @refuse classify a binding like @transient; empty arguments are reported", () => {
        const c = censusOf([
            "// @participant(user32)", "const windows = new Map();",
            "let open = 0; // @refuse(a dialog is open)",
            "// @participant()", "let x = 0;",
            "// @refuse( )", "let y = 0;",
        ].join("\n"));
        expect(c.names).toEqual(["x", "y"]);
        expect(c.emptyReasons).toEqual([5, 7]);
        expect(c.participants).toEqual([{ line: 2, id: "user32" }]);
    });

    test("maps files to the DLL they implement and reads covered DLLs from covers lists", () => {
        expect(moduleOfFile("modules/user32/window.ts")).toBe("user32");
        expect(moduleOfFile("modules/kernelbase.ts")).toBe("kernelbase");
        expect(moduleOfFile("modules/winmm-joystick.ts")).toBe("winmm");
        expect(moduleOfFile("runtime/windowing/message-queue.ts")).toBeNull();
        expect([...coveredModulesOf(["add({ id: 'k', covers: ['kernel32', 'NTDLL.dll'] })", "// covers: ['gdi32']"])].sort())
            .toEqual(["kernel32", "ntdll"]);
    });

    test("stripping keeps every src/worker file brace-balanced", () => {
        const files: string[] = [];
        const walk = (d: string) => {
            for (const n of readdirSync(d)) {
                const f = join(d, n);
                if (statSync(f).isDirectory()) walk(f); else if (n.endsWith(".ts")) files.push(f);
            }
        };
        walk(join(import.meta.dir, "..", "..", "src", "worker"));
        const unbalanced = files.filter(f => {
            let depth = 0;
            for (const ch of stripNonCode(readFileSync(f, "utf8"))) {
                if (ch === "{") depth++;
                else if (ch === "}" && --depth < 0) return true;
            }
            return depth !== 0;
        });
        expect(unbalanced).toEqual([]);
    });
});

describe("session-state census gate", () => {
    const setup = (files: Record<string, string>, pin: Record<string, string[]>) => {
        const base = mkdtempSync(join(tmpdir(), "session-census-"));
        const root = join(base, "src");
        mkdirSync(root);
        for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
        const pinPath = join(base, "pin.json");
        writeFileSync(pinPath, JSON.stringify(pin));
        return { base, root, pin: pinPath, done: () => rmSync(base, { recursive: true, force: true }) };
    };
    const run = (files: Record<string, string>, pin: Record<string, string[]>) => {
        const t = setup(files, pin);
        try { return runCensus(t); } finally { t.done(); }
    };

    test("passes when the tree matches the pin exactly", () => {
        expect(run({ "a.ts": "let x = 0;\nlet y = 0;\n" }, { "src/a.ts": ["x", "y"] }).ok).toBe(true);
    });

    test("fails on growth", () => {
        const r = run({ "a.ts": "let x = 0;\nlet y = 0;\n", "b.ts": "let z = 0;\n" }, { "src/a.ts": ["x"] });
        expect(r.ok).toBe(false);
        expect(r.lines.join("\n")).toContain("NEW: src/a.ts — y");
        expect(r.lines.join("\n")).toContain("NEW: src/b.ts — z");
    });

    test("fails on drift below the pin", () => {
        const r = run({ "a.ts": "let x = 0;\n" }, { "src/a.ts": ["x", "y"] });
        expect(r.ok).toBe(false);
        expect(r.lines.join("\n")).toContain("DRIFT: src/a.ts — pinned but gone: y");
    });

    test("fails when one binding is swapped for another at the same count", () => {
        const r = run({ "a.ts": "let x = 0;\nlet w = 0;\n" }, { "src/a.ts": ["x", "y"] });
        expect(r.ok).toBe(false);
        expect(r.lines.join("\n")).toMatch(/NEW: src\/a\.ts — w[\s\S]*DRIFT: src\/a\.ts — pinned but gone: y/);
    });

    test("fails on a stale pin", () => {
        const r = run({ "a.ts": "let x = 0;\n", "b.ts": "const fixed = 1;\n" }, { "src/a.ts": ["x"], "src/b.ts": ["gone"] });
        expect(r.ok).toBe(false);
        expect(r.lines.join("\n")).toContain("STALE PIN: src/b.ts");
    });

    test("fails on an empty @transient() reason", () => {
        const r = run({ "a.ts": "let x = 0; // @transient()\n" }, { "src/a.ts": ["x"] });
        expect(r.ok).toBe(false);
        expect(r.lines.join("\n")).toContain("EMPTY REASON: src/a.ts:1");
    });

    test("a module some participant covers must classify every binding", () => {
        const files = {
            "modules/user32/a.ts": "let pinned = 0;\n// @participant(user32)\nlet saved = 0;\n",
            "modules/gdi32/b.ts": "let free = 0;\n",
            "savestate/participant-ids.ts": "export const PARTICIPANT_IDS = ['user32'] as const;\n",
            "savestate/user32.ts": "savestateParticipants.add({ id: 'user32', covers: ['user32'] });\n",
        };
        const t = setup({}, {});
        try {
            for (const [name, body] of Object.entries(files)) {
                mkdirSync(join(t.root, name, ".."), { recursive: true });
                writeFileSync(join(t.root, name), body);
            }
            writeFileSync(t.pin, JSON.stringify({ "src/modules/user32/a.ts": ["pinned"], "src/modules/gdi32/b.ts": ["free"] }));
            const r = runCensus(t);
            expect(r.ok).toBe(false);
            expect(r.lines.join("\n")).toContain("UNCLASSIFIED: src/modules/user32/a.ts — pinned (user32 is covered");
            expect(r.lines.join("\n")).not.toContain("UNCLASSIFIED: src/modules/gdi32");
            writeFileSync(join(t.root, "modules/user32/a.ts"), "// @transient(diagnostics)\nlet pinned = 0;\n// @participant(usr32)\nlet saved = 0;\n");
            writeFileSync(t.pin, JSON.stringify({ "src/modules/gdi32/b.ts": ["free"] }));
            const r2 = runCensus(t);
            expect(r2.ok).toBe(false);
            expect(r2.lines.join("\n")).toContain("UNKNOWN PARTICIPANT: src/modules/user32/a.ts:4 — usr32");
            writeFileSync(join(t.root, "modules/user32/a.ts"), "// @transient(diagnostics)\nlet pinned = 0;\n// @participant(user32)\nlet saved = 0;\n");
            expect(runCensus(t).ok).toBe(true);
        } finally { t.done(); }
    });

    test("a module declared stateless may only hold @transient bindings, with a reason that says why", () => {
        const write = (root: string, files: Record<string, string>) => {
            for (const [name, body] of Object.entries(files)) {
                mkdirSync(join(root, name, ".."), { recursive: true });
                writeFileSync(join(root, name), body);
            }
        };
        const t = setup({}, {});
        try {
            write(t.root, {
                "savestate/participant-ids.ts": "export const PARTICIPANT_IDS = ['user32'] as const;\n",
                "savestate/stateless-modules.ts": "export const STATELESS_MODULES = {\n    shlwapi: 'path helpers over guest buffers; nothing kept between calls',\n    psapi: 'stateless',\n} as const;\n",
                "modules/shlwapi.ts": "let loose = 0;\n// @participant(user32)\nlet saved = 0;\n// @refuse(open thing)\nlet refused = 0;\n// @transient(constant table)\nconst table = [];\n",
            });
            writeFileSync(t.pin, JSON.stringify({ "src/modules/shlwapi.ts": ["loose"] }));
            const out = runCensus(t).lines.join("\n");
            expect(out).toContain("UNCLASSIFIED: src/modules/shlwapi.ts — loose (shlwapi is declared stateless");
            expect(out).toContain("STATEFUL: src/modules/shlwapi.ts:3,5 — shlwapi is declared stateless");
            expect(out).toContain("STATELESS REASON: savestate/stateless-modules.ts:3: psapi needs a reason");
            write(t.root, {
                "savestate/stateless-modules.ts": "export const STATELESS_MODULES = {\n    shlwapi: 'path helpers over guest buffers; nothing kept between calls',\n    user32: 'windows',\n} as const;\n",
                "savestate/user32.ts": "savestateParticipants.add({ id: 'user32', covers: ['user32'] });\n",
                "modules/shlwapi.ts": "// @transient(constant table)\nconst table = [];\n",
            });
            writeFileSync(t.pin, JSON.stringify({}));
            const both = runCensus(t);
            expect(both.lines.join("\n")).toContain("STATELESS AND COVERED: user32");
            write(t.root, { "savestate/stateless-modules.ts": "export const STATELESS_MODULES = {\n    shlwapi: 'path helpers over guest buffers; nothing kept between calls',\n} as const;\n" });
            expect(runCensus(t).ok).toBe(true);
        } finally { t.done(); }
    });

    test("statelessModulesOf reads names and reasons and rejects a bare reason", () => {
        const { modules, bad } = statelessModulesOf("export const STATELESS_MODULES = {\n    \"Shlwapi\": \"path helpers; nothing kept\",\n    version: 'none',\n} as const;\n");
        expect([...modules]).toEqual([["shlwapi", "path helpers; nothing kept"], ["version", "none"]]);
        expect(bad).toEqual(["3: version needs a reason that says why nothing survives a call"]);
    });

    test("--update writes a pin the check then accepts", () => {
        const t = setup({ "a.ts": "let y = 0;\nlet x = 0;\n" }, {});
        try {
            expect(runCensus({ ...t, update: true }).ok).toBe(true);
            expect(JSON.parse(readFileSync(t.pin, "utf8"))).toEqual({ "src/a.ts": ["x", "y"] });
            expect(runCensus(t).ok).toBe(true);
        } finally { t.done(); }
    });
});

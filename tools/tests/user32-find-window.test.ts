import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { WindowManager } from "../../src/worker/runtime/windowing/window-manager";
import { windows, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { createClassExports, captureUser32Classes, restoreUser32Classes } from "../../src/worker/modules/user32/class";
import { createWindowExports } from "../../src/worker/modules/user32/window";
import { registerWindowQueryExports } from "../../src/worker/modules/user32/window-query";

const CLASS = 0x11000, TITLE = 0x11200, WC = 0x12000, OUT = 0x13000;
let mem: Uint8Array, api: Record<string, any>, atom: number;
let oldProcess: unknown, oldManager: WindowManager, oldWindows: Map<number, WindowInfo>;
let oldClasses: ReturnType<typeof captureUser32Classes>, oldMem: any;
function ansi(p: number, s: string): number { mem.set(new TextEncoder().encode(s + "\0"), p); return p; }
function wide(p: number, s: string): number {
    const view = new DataView(mem.buffer);
    for (let i = 0; i <= s.length; i++) view.setUint16(p + i * 2, s.charCodeAt(i) || 0, true);
    return p;
}
beforeEach(() => {
    const system = System.getInstance();
    oldProcess = system.process; oldManager = system.windowManager;
    oldWindows = new Map(windows); oldClasses = captureUser32Classes();
    oldMem = (Mem as any).memoryGetter;
    mem = new Uint8Array(0x20000); Mem.bind(() => mem); windows.clear();
    system.windowManager = new WindowManager();
    system.process = { getModule: () => undefined, getCurrentMemory: () => mem } as never;
    api = { ...createClassExports(), ...createWindowExports() };
    registerWindowQueryExports(api);
    ansi(CLASS, "LookupContractClass");
    new DataView(mem.buffer).setUint32(WC + 36, CLASS, true);
    atom = api.RegisterClassA({} as never, mem, [WC]);
});
afterEach(() => {
    restoreUser32Classes(oldClasses);
    windows.clear(); for (const [h, w] of oldWindows) windows.set(h, w);
    const system = System.getInstance(); system.process = oldProcess as never; system.windowManager = oldManager;
    Mem.bind(oldMem);
});
function create(classArg = CLASS, parent = 0, style = 0): number {
    ansi(TITLE, "Lookup Contract");
    const r = api.CreateWindowExA({ esp: 0x18000 } as never, mem,
        [0, classArg, TITLE, style, 0, 0, 20, 20, parent, 0, 0, 0]);
    return typeof r === "number" ? r : r.value;
}
test("a window created by class name retains the registered class atom", () => {
    const hwnd = create();
    expect(hwnd).toBeGreaterThan(0);
    expect(windows.get(hwnd)!.classId).toBe(atom);
    expect(api.FindWindowA({}, mem, [CLASS, 0])).toBe(hwnd);
    expect(api.FindWindowA({}, mem, [atom, 0])).toBe(hwnd);
    expect(api.GetClassNameA({}, mem, [hwnd, OUT, 64])).toBe("LookupContractClass".length);
});
test("A/W class names and captions compare without case", () => {
    const hwnd = create();
    expect(api.FindWindowA({}, mem, [ansi(CLASS, "LOOKUPCONTRACTCLASS"), ansi(TITLE, "lookup contract")])).toBe(hwnd);
    expect(api.FindWindowW({}, mem, [wide(CLASS, "lookupcontractclass"), wide(TITLE, "LOOKUP CONTRACT")])).toBe(hwnd);
    expect(api.FindWindowW({}, mem, [0, TITLE])).toBe(hwnd);
    expect(api.FindWindowW({}, mem, [CLASS, wide(TITLE, "different")])).toBe(0);
});
test("atom-based creation and child lookup preserve class identity", () => {
    const parent = create(atom);
    const child = create(CLASS, parent, 0x40000000);
    expect(windows.get(child)!.classId).toBe(atom);
    expect(api.FindWindowA({}, mem, [atom, 0])).toBe(parent);
    expect(api.FindWindowExA({}, mem, [parent, 0, atom, 0])).toBe(child);
});
test("native class names remain discoverable without a registered atom", () => {
    const hwnd = create();
    windows.get(hwnd)!.classId = undefined;
    windows.get(hwnd)!.nativeClassName = "LookupNative";
    expect(api.FindWindowA({}, mem, [ansi(CLASS, "lookupnative"), 0])).toBe(hwnd);
});

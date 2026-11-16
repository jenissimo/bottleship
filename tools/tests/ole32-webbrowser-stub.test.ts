import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { coCreateWebBrowser, CLSID_WEBBROWSER } from '../../src/worker/modules/ole32-webbrowser';
import { checkComGuard, resetComMemory, snapshotComVtableOwners } from '../../src/worker/core/com/com-memory';
import type { Process } from '../../src/worker/core/process';
import type { ThunkImplementation } from '../../src/worker/core/thunking/thunk-dispatcher';

const IOLEOBJECT = '00000112-0000-0000-c000-000000000046';
const IIDS: Record<string, string> = {
    unknown: '00000000-0000-0000-c000-000000000046', inplace: '00000113-0000-0000-c000-000000000046',
    control: 'b196b288-bab4-101a-b69c-00aa00341d07', persist: '7fd52380-4e07-101b-ae2d-08002b2ec713',
    dispatch: '00020400-0000-0000-c000-000000000046', browser2: 'd30c1661-cdaf-11d0-8a3e-00c04fc9e26e',
    cpc: 'b196b284-bab4-101a-b69c-00aa00341d07',
};
const system = System.getInstance(), savedProcess = system.process;
let restoreVtableOwners: () => void = () => {};
let memory: Uint8Array, process: Process, nextData: number, nextCode: number;
const handlers = new Map<string, ThunkImplementation>();
const namesByStub = new Map<number, string>();
let shapes: Array<{ name: string; argCount: number; stackCleanupBytes: number }>;
const view = () => new DataView(memory.buffer);
function guid(ptr: number, text: string) {
    const [a, b, c, d, e] = text.split('-');
    view().setUint32(ptr, parseInt(a, 16), true); view().setUint16(ptr + 4, parseInt(b, 16), true); view().setUint16(ptr + 6, parseInt(c, 16), true);
    const tail = d + e; for (let i = 0; i < 8; i++) memory[ptr + 8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16);
}
function alloc(size: number) { const p = nextData; nextData += (size + 15) & ~15; return p; }
function call(ptr: number, method: string, args: number[] = []) {
    const table = view().getUint32(ptr, true);
    for (let slot = 0; slot < 80; slot++) {
        const stub = view().getUint32(table + slot * 4, true), name = namesByStub.get(stub);
        if (name?.endsWith('_' + method)) return handlers.get(name)!(null as never, memory, [ptr, ...args]) >>> 0;
    }
    throw new Error('no method ' + method);
}
beforeEach(() => {
    restoreVtableOwners = snapshotComVtableOwners();
    memory = new Uint8Array(0x40000); nextData = 0x10000; nextCode = 0x20000;
    handlers.clear(); namesByStub.clear(); shapes = []; resetComMemory();
    Mem.bind(() => memory, (p, n) => p >= 0 && p + n <= memory.length);
    process = { resetGeneration: 0, getCurrentMemory: () => memory,
        memory: { alloc, allocAt() {}, allocSystemBlock: alloc, freeSystemBlock() {}, systemPoolGeneration: 0 },
        dispatcher: { registerModule(_n: string, ex: Record<string, ThunkImplementation>) { for (const [k, v] of Object.entries(ex)) handlers.set(k, v); }, applyPendingRegistrations() {} },
        thunkGenerator: { generateStubDll(_n: string, methods: typeof shapes) {
            shapes.push(...methods);
            const baseAddress = nextCode; nextCode += methods.length * 16;
            const stubCode = new Uint8Array(methods.length * 16), exportTable = new Map<string, number>();
            methods.forEach((m, i) => { stubCode[i * 16] = 0xb8; exportTable.set(m.name.toLowerCase(), baseAddress + i * 16); namesByStub.set(baseAddress + i * 16, m.name); });
            return { baseAddress, stubCode, exportTable };
        } },
    } as unknown as Process;
    system.process = process;
    let at = 1024; for (const v of Object.values(IIDS)) { guid(at, v); at += 16; }
});
afterEach(() => { restoreVtableOwners(); resetComMemory(); system.process = savedProcess; Mem.bind(() => savedProcess?.getCurrentMemory() ?? new Uint8Array()); });
const iidAt = (key: string) => 1024 + Object.keys(IIDS).indexOf(key) * 16;

test('WebBrowser stand-in serves the interfaces a hosting control asks for, invisible at runtime, balanced refs', () => {
    expect(coCreateWebBrowser(process, CLSID_WEBBROWSER, IOLEOBJECT, 2048)).toBe(0);
    const obj = view().getUint32(2048, true);
    expect(checkComGuard(memory, obj)).toBe(true);
    expect(shapes.find(s => s.name.endsWith('IOleObject_DoVerb'))).toMatchObject({ argCount: 7, stackCleanupBytes: 28 });
    expect(shapes.find(s => s.name.endsWith('IWebBrowser2_Navigate'))).toMatchObject({ argCount: 6, stackCleanupBytes: 24 });
    expect(shapes.find(s => s.name.endsWith('IWebBrowser2_PutProperty'))).toMatchObject({ argCount: 6, stackCleanupBytes: 24 });
    expect(shapes.filter(s => s.name.startsWith('WebBrowser_IWebBrowser2_')).length).toBe(71);
    expect(shapes.filter(s => s.name.startsWith('WebBrowser_IOleObject_')).length).toBe(24);
    expect(call(obj, 'GetMiscStatus', [1, 2100])).toBe(0);
    expect(view().getUint32(2100, true) & 0x400).toBe(0x400);
    expect(call(obj, 'GetUserClassID', [2200])).toBe(0);
    expect(memory[2200]).toBe(0x61); expect(memory[2215]).toBe(0xa2);
    expect(call(obj, 'SetClientSite', [0x3000])).toBe(0);
    const faces: Record<string, number> = {};
    for (const key of ['unknown', 'inplace', 'control', 'persist', 'dispatch', 'browser2']) {
        expect(call(obj, 'QueryInterface', [iidAt(key), 2300])).toBe(0);
        faces[key] = view().getUint32(2300, true);
        expect(faces[key]).not.toBe(0);
    }
    expect(faces.unknown).toBe(obj);
    expect(faces.dispatch).toBe(faces.browser2);
    view().setUint32(2304, 0x1234, true);
    expect(call(obj, 'QueryInterface', [iidAt('cpc'), 2304])).toBe(0x80004002);
    expect(view().getUint32(2304, true)).toBe(0);
    expect(call(faces.persist, 'InitNew')).toBe(0);
    expect(call(faces.persist, 'Load', [0x3100])).toBe(0);
    expect(call(faces.control, 'GetControlInfo', [2400])).toBe(0);
    expect(call(faces.browser2, 'Navigate', [0, 0, 0, 0, 0])).toBe(0);
    expect(call(faces.browser2, 'put_Width', [320])).toBe(0);
    expect(call(faces.browser2, 'get_Width', [2500])).toBe(0);
    expect(view().getUint32(2500, true)).toBe(320);
    expect(call(faces.browser2, 'get_ReadyState', [2504])).toBe(0);
    expect(view().getUint32(2504, true)).toBe(4);
    memory.fill(0xcc, 2600, 2616);
    expect(call(faces.browser2, 'Invoke', [0x7ffffffe, 2700, 0, 1, 2720, 2600, 0, 0])).toBe(0x80020003);
    expect(call(faces.browser2, 'Invoke', [0, 2700, 0, 1, 2720, 2600, 0, 0])).toBe(0x80020003);
    expect(call(faces.browser2, 'Invoke', [0x7ffffffe, iidAt('unknown'), 0, 1, 2720, 2600, 0, 0])).toBe(0x80020001);
    expect([...memory.slice(2600, 2616)].every(b => b === 0xcc)).toBe(true);
    let refs = call(obj, 'AddRef');
    expect(refs).toBe(8);
    for (let i = 0; i < 7; i++) refs = call(obj, 'Release');
    expect(refs).toBe(1);
    expect(call(obj, 'Release')).toBe(0);
});

function browser() {
    expect(coCreateWebBrowser(process, CLSID_WEBBROWSER, IOLEOBJECT, 2048)).toBe(0);
    const obj = view().getUint32(2048, true);
    expect(call(obj, 'QueryInterface', [iidAt('browser2'), 2300])).toBe(0);
    return { obj, b2: view().getUint32(2300, true) };
}

test('VARIANT_BOOL getters write two bytes, accepted puts are kept, VARIANT_TRUE reads back as -1', () => {
    const { b2 } = browser();
    const bools = ['Visible', 'StatusBar', 'MenuBar', 'FullScreen', 'Offline', 'Silent', 'RegisterAsBrowser',
        'RegisterAsDropTarget', 'TheaterMode', 'AddressBar', 'Resizable', 'Busy', 'TopLevelContainer'];
    for (const name of bools) {
        memory.fill(0xcc, 2800, 2808);
        expect(call(b2, 'get_' + name, [2800])).toBe(0);
        expect([...memory.slice(2800, 2808)]).toEqual([0, 0, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc]);
    }
    expect(call(b2, 'put_Silent', [0xffff])).toBe(0);
    memory.fill(0xcc, 2800, 2804);
    expect(call(b2, 'get_Silent', [2800])).toBe(0);
    expect(view().getInt16(2800, true)).toBe(-1);
    expect(memory[2802]).toBe(0xcc);
    expect(call(b2, 'put_Visible', [1])).toBe(0);
    expect(call(b2, 'get_Visible', [2800])).toBe(0);
    expect(view().getInt16(2800, true)).toBe(-1);
    expect(call(b2, 'put_Visible', [0])).toBe(0);
    expect(call(b2, 'get_Visible', [2800])).toBe(0);
    expect(view().getInt16(2800, true)).toBe(0);
    expect(call(b2, 'get_Silent', [2800])).toBe(0);
    expect(view().getInt16(2800, true)).toBe(-1);
    expect(call(b2, 'put_ToolBar', [2])).toBe(0);
    memory.fill(0xcc, 2800, 2808);
    expect(call(b2, 'get_ToolBar', [2800])).toBe(0);
    expect(view().getInt32(2800, true)).toBe(2);
    expect(memory[2804]).toBe(0xcc);
    for (const name of ['get_Document', 'get_LocationURL', 'get_HWND', 'get_ReadyState', 'get_Width']) {
        memory.fill(0xcc, 2800, 2808);
        expect(call(b2, name.slice(0), [2800])).toBe(0);
        expect(memory[2804]).toBe(0xcc);
    }
});

test('the client site is kept with a reference, handed out with one, and released on replace, clear and final release', () => {
    const queue: Array<{ fn: number; args: number[]; done: () => number | null }> = [];
    const log: string[] = [];
    (process as unknown as { dispatcher: Record<string, unknown> }).dispatcher.callbackManager = {
        saveSuspendedThunkContext: () => 1,
        invokeCallback: (fn: number, args: number[], _cleanup: number, done: () => number | null) => {
            queue.push({ fn, args, done });
            return { callbackId: queue.length };
        },
    };
    const site = (at: number, table: number) => {
        view().setUint32(at, table, true);
        view().setUint32(table + 4, 0x30004 + at, true);
        view().setUint32(table + 8, 0x30008 + at, true);
        return at;
    };
    const A = site(0x3800, 0x3900), B = site(0x3a00, 0x3b00);
    const name = (fn: number) => (fn === 0x30004 + A ? 'AddRef A' : fn === 0x30008 + A ? 'Release A'
        : fn === 0x30004 + B ? 'AddRef B' : fn === 0x30008 + B ? 'Release B' : 'fn ' + fn.toString(16));
    const run = (ptr: number, method: string, args: number[]) => {
        const table = view().getUint32(ptr, true);
        for (let slot = 0; slot < 80; slot++) {
            const n = namesByStub.get(view().getUint32(table + slot * 4, true));
            if (n?.endsWith('_' + method)) {
                const r = handlers.get(n)!(null as never, memory, [ptr, ...args]) as number | { value: number; suspendedForCallback?: boolean; stackCleanup?: number };
                let value = typeof r === 'number' ? r : r.value;
                while (queue.length) {
                    const c = queue.shift()!;
                    log.push(name(c.fn) + '(' + c.args.map(x => x.toString(16)).join(',') + ')');
                    const v = c.done();
                    if (v !== null) value = v;
                }
                return { value: value >>> 0, cleanup: typeof r === 'number' ? null : r.stackCleanup };
            }
        }
        throw new Error('no method ' + method);
    };
    const { obj } = browser();
    expect(run(obj, 'SetClientSite', [A])).toEqual({ value: 0, cleanup: 8 });
    expect(log.splice(0)).toEqual(['AddRef A(3800)']);
    view().setUint32(2900, 0x1234, true);
    expect(run(obj, 'GetClientSite', [2900])).toEqual({ value: 0, cleanup: 8 });
    expect(view().getUint32(2900, true)).toBe(A);
    expect(log.splice(0)).toEqual(['AddRef A(3800)']);
    expect(run(obj, 'SetClientSite', [A]).value).toBe(0);
    expect(log.splice(0)).toEqual([]);
    expect(run(obj, 'SetClientSite', [B])).toEqual({ value: 0, cleanup: 8 });
    expect(log.splice(0)).toEqual(['AddRef B(3a00)', 'Release A(3800)']);
    expect(run(obj, 'SetClientSite', [0])).toEqual({ value: 0, cleanup: 8 });
    expect(log.splice(0)).toEqual(['Release B(3a00)']);
    expect(run(obj, 'GetClientSite', [2900]).value).toBe(0);
    expect(view().getUint32(2900, true)).toBe(0);
    expect(log.splice(0)).toEqual([]);
    expect(run(obj, 'SetClientSite', [A]).value).toBe(0);
    expect(log.splice(0)).toEqual(['AddRef A(3800)']);
    expect(run(obj, 'AddRef', []).value).toBe(3);
    expect(run(obj, 'Release', []).value).toBe(2);
    expect(run(obj, 'Release', []).value).toBe(1);
    expect(log.splice(0)).toEqual([]);
    expect(run(obj, 'Release', [])).toEqual({ value: 0, cleanup: 4 });
    expect(log.splice(0)).toEqual(['Release A(3800)']);
});

test('other classes and unknown first interfaces are left to the generic path', () => {
    expect(coCreateWebBrowser(process, '00021401-0000-0000-c000-000000000046', IOLEOBJECT, 2048)).toBeNull();
    view().setUint32(2048, 0x55, true);
    expect(coCreateWebBrowser(process, CLSID_WEBBROWSER, '11111111-2222-3333-4444-555555555555', 2048)).toBe(0x80004002);
    expect(view().getUint32(2048, true)).toBe(0);
});

test('a refused or throwing site callback leaves the site, the references and no suspended frame behind', () => {
    const E_OUTOFMEMORY = 0x8007000e;
    type Mode = 'accept' | 'refuse' | 'throw';
    let modes: Mode[] = [], frames = 0;
    const abandoned: number[] = [], queue: Array<{ fn: number; done: () => number | null }> = [], log: string[] = [];
    (process as unknown as { dispatcher: Record<string, unknown> }).dispatcher.callbackManager = {
        saveSuspendedThunkContext: () => (frames < 32 ? ++frames : 0),
        abandonSuspendedFrame: (id: number) => { abandoned.push(id); frames--; return true; },
        invokeCallback: (fn: number, _args: number[], _c: number, done: () => number | null) => {
            const mode = modes.shift() ?? 'accept';
            if (mode === 'throw') throw new Error('CallbackError: return-stub pool exhausted');
            if (mode === 'refuse') return { callbackId: 0 };
            queue.push({ fn, done });
            return { callbackId: queue.length };
        },
    };
    const site = (at: number, table: number) => {
        view().setUint32(at, table, true);
        view().setUint32(table + 4, 0x30004 + at, true);
        view().setUint32(table + 8, 0x30008 + at, true);
        return at;
    };
    const A = site(0x3800, 0x3900), B = site(0x3a00, 0x3b00);
    const name = (fn: number) => (fn === 0x30004 + A ? 'AddRef A' : fn === 0x30008 + A ? 'Release A'
        : fn === 0x30004 + B ? 'AddRef B' : fn === 0x30008 + B ? 'Release B' : '?');
    const run = (ptr: number, method: string, args: number[]) => {
        const table = view().getUint32(ptr, true);
        for (let slot = 0; slot < 80; slot++) {
            const n = namesByStub.get(view().getUint32(table + slot * 4, true));
            if (!n?.endsWith('_' + method)) continue;
            const r = handlers.get(n)!(null as never, memory, [ptr, ...args]) as number | { value: number };
            let value = typeof r === 'number' ? r : r.value;
            while (queue.length) {
                const c = queue.shift()!;
                log.push(name(c.fn));
                const v = c.done();
                if (v !== null) { value = v; frames--; }
            }
            return value >>> 0;
        }
        throw new Error('no method ' + method);
    };
    const siteNow = (obj: number) => { modes = ['accept']; run(obj, 'GetClientSite', [2900]); log.splice(0); return view().getUint32(2900, true); };
    const { obj } = browser();

    frames = 31;
    expect(run(obj, 'SetClientSite', [A])).toBe(0);
    expect(log.splice(0)).toEqual(['AddRef A']);
    frames = 32;
    expect(run(obj, 'SetClientSite', [B])).toBe(E_OUTOFMEMORY);
    expect(log.splice(0)).toEqual([]);
    expect(frames).toBe(32);
    frames = 0;
    log.splice(0);
    expect(siteNow(obj)).toBe(A);

    modes = ['refuse'];
    expect(run(obj, 'SetClientSite', [B])).toBe(E_OUTOFMEMORY);
    expect(abandoned.length).toBe(1);
    expect(frames).toBe(0);
    expect(log.splice(0)).toEqual([]);
    expect(siteNow(obj)).toBe(A);

    modes = ['throw'];
    expect(() => run(obj, 'SetClientSite', [B])).toThrow('return-stub pool exhausted');
    expect(abandoned.length).toBe(2);
    expect(frames).toBe(0);
    expect(siteNow(obj)).toBe(A);

    modes = ['accept', 'refuse'];
    expect(run(obj, 'SetClientSite', [B])).toBe(E_OUTOFMEMORY);
    expect(log.splice(0)).toEqual(['AddRef B']);
    expect(frames).toBe(0);
    expect(siteNow(obj)).toBe(B);
    log.splice(0);

    modes = ['refuse'];
    view().setUint32(2900, 0x1234, true);
    expect(run(obj, 'GetClientSite', [2900])).toBe(E_OUTOFMEMORY);
    expect(view().getUint32(2900, true)).toBe(0);

    modes = [];
    while (run(obj, 'Release', []) !== 0) { /* drop the extra references GetClientSite left */ }
    expect(log.filter(l => l.startsWith('Release'))).toEqual(['Release B', 'Release A']);
});

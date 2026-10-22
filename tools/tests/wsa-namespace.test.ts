import { afterEach, beforeEach, expect, test } from 'bun:test';
import { makeNamespaceExports, type NamespaceHost } from '../../src/worker/modules/wsa-namespace';
import { WsaSocketTable } from '../../src/worker/modules/wsa-network';
import { LanNetwork } from '../../src/worker/net/lan-network';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import type { Process } from '../../src/worker/core/process';
import type { ThunkImplementation, ThunkResult, X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';
import type { WsaErrorSetter } from '../../src/worker/modules/wsa-network-api';

let ram: Uint8Array, owner: Process, table: WsaSocketTable, methods: Record<string, ThunkImplementation>, resets: Set<() => void>;
let startup: { started: boolean }, thread: number, errors: Array<[number, number]>, resolver: (name: string, signal?: AbortSignal, family?: 0 | 4 | 6) => NamespaceHost | Promise<NamespaceHost>;
const word = (p: number) => new DataView(ram.buffer).getUint32(p, true);
const put = (p: number, value: number) => new DataView(ram.buffer).setUint32(p, value, true);
const call = (name: string, args: number[]) => methods[name]({} as X86Context, ram, args);
const host = (): NamespaceHost => ({ canonicalName: 'example.test', addresses: [Uint8Array.of(127,0,0,1)] });
function begin(wide = true) {
    ram.set(wide ? new Uint8Array(new Uint16Array([...('example.test\0')].map(c => c.charCodeAt(0))).buffer) : new TextEncoder().encode('example.test\0'), 0x2000);
    put(0x1000, 60); put(0x1004, 0x2000); put(0x1008, 0x2400); put(0x1014, 12);
    ram.set(Uint8Array.of(3,0xa8,2,0,0,0,0,0,0xc0,0,0,0,0,0,0,0x46), 0x2400);
    put(0x1020, 1); put(0x1024, 0x2100); put(0x2100, 2); put(0x2104, 6);
    expect(call('WSALookupServiceBegin' + (wide ? 'W' : 'A'), [0x1000, 0x330, 0x2200])).toBe(0); return word(0x2200);
}
beforeEach(() => {
    ram = new Uint8Array(0x10000); Mem.bind(() => ram); resets = new Set(); errors = []; thread = 7;
    owner = { resetGeneration: 0, addressSpace: { validateRange: (p: number, n: number) => p >= 0x1000 && p + n <= ram.length },
        onReset: (fn: () => void) => { resets.add(fn); return () => resets.delete(fn); } } as unknown as Process;
    table = new WsaSocketTable(new LanNetwork(Uint8Array.of(2,0,0,3,4,5))); startup = { started: true }; resolver = host;
    const error: WsaErrorSetter = code => errors.push([thread, code]);
    error.capture = () => { const id = thread, epoch = owner.resetGeneration; return code => { if (owner.resetGeneration === epoch) errors.push([id, code]); }; };
    methods = makeNamespaceExports(owner, table, startup, error, (...args) => resolver(...args), () => 11001);
});
afterEach(() => { owner.resetGeneration++; for (const reset of resets) reset(); table.reset(); });
test('namespace enumeration preserves capacity and confines identifier pointers to its buffer', () => {
    startup.started = false; put(0x1100, 0); expect(call('WSAEnumNameSpaceProvidersW', [0x1100, 0])).toBe(-1); expect(errors.at(-1)).toEqual([7,10093]);
    startup.started = true; expect(call('WSAEnumNameSpaceProvidersW', [0x1100, 0])).toBe(-1); const need = word(0x1100); expect(need).toBeGreaterThan(32);
    put(0x1100, need + 20); ram.fill(0xcc, 0x3000, 0x3000 + need + 20);
    expect(call('WSAEnumNameSpaceProvidersW', [0x1100, 0x3000])).toBe(1); expect(word(0x1100)).toBe(need + 20);
    expect(word(0x3010)).toBe(12); expect(word(0x3014)).toBe(1); expect(word(0x301c)).toBe(0x3020); expect(ram[0x3000 + need]).toBe(0xcc);
});
test('short lookup buffers preserve the result; returned CSADDR_INFO and self-relative HOSTENT are valid', () => {
    const handle = begin(); put(0x2300, 0); expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0])).toBe(-1);
    const need = word(0x2300); expect(need).toBeGreaterThan(60); put(0x2300, need - 1); ram.fill(0xcc, 0x4000, 0x5000);
    expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(-1); expect(word(0x2300)).toBe(need); expect(ram[0x4000]).toBe(0xcc);
    put(0x2300, need + 20); expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(0);
    expect(word(0x2300)).toBe(need + 20); expect(word(0x4000)).toBe(60); expect(word(0x4014)).toBe(12);
    expect(word(0x402c)).toBe(1); const addresses = word(0x4030), remote = word(addresses + 8);
    expect(word(addresses + 16)).toBe(1); expect(word(addresses + 20)).toBe(6);
    expect([...ram.slice(remote + 4, remote + 8)]).toEqual([127,0,0,1]);
    const blob = word(0x4038), data = word(blob + 4), name = data + word(data), list = data + word(data + 12);
    expect(new TextDecoder().decode(ram.slice(name, name + 12))).toBe('example.test');
    expect([...ram.slice(data + word(list), data + word(list) + 4)]).toEqual([127,0,0,1]); expect(word(list + 4)).toBe(0);
    expect(ram[0x4000 + need]).toBe(0xcc);
    expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(-1); expect(errors.at(-1)).toEqual([7,10110]);
    expect(call('WSALookupServiceEnd', [handle])).toBe(0); expect(call('WSALookupServiceEnd', [handle])).toBe(-1); expect(errors.at(-1)).toEqual([7,6]);
});
test('ANSI lookup materializes a packet with ANSI names', () => {
    const handle = begin(false); put(0x2300, 4096);
    expect(call('WSALookupServiceNextA', [handle, 0, 0x2300, 0x4000])).toBe(0);
    const pointer = word(0x4004); expect(new TextDecoder().decode(ram.slice(pointer, pointer + 12))).toBe('example.test');
});
test('async DNS produces owner-deferred writes and reports error to the issuing thread', async () => {
    let resolve!: (host: NamespaceHost) => void;
    resolver = () => new Promise(done => { resolve = done; }); const handle = begin(); put(0x2300, 4096);
    const pending = call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000]) as Promise<ThunkResult>;
    const foreign = new Uint8Array(ram.length); Mem.bind(() => foreign); thread = 11;
    resolve(host()); const answer = await pending; expect(answer.value).toBe(0); expect(word(0x4000)).toBe(0); expect(foreign[0x4000]).toBe(0);
    expect(answer.deferredWrites?.length).toBeGreaterThan(15); expect(errors.at(-1)).toEqual([7,0]);
});
test('ending a pending lookup cancels its resolver and never consumes another query', async () => {
    let resolve!: (host: NamespaceHost) => void, signal!: AbortSignal;
    resolver = (_name, value) => { signal = value!; return new Promise(done => { resolve = done; }); };
    const handle = begin(); put(0x2300, 4096);
    const pending = call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000]) as Promise<ThunkResult>;
    expect(call('WSALookupServiceEnd', [handle])).toBe(0); expect(signal.aborted).toBe(true); resolve(host());
    expect((await pending).value).toBe(-1); expect(errors.at(-1)).toEqual([7,10103]); expect(word(0x4000)).toBe(0);
});
test('generation reset rejects old handles and discards a late DNS result', async () => {
    let resolve!: (host: NamespaceHost) => void; resolver = () => new Promise(done => { resolve = done; });
    const handle = begin(); put(0x2300, 4096); const pending = call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000]) as Promise<ThunkResult>;
    owner.resetGeneration++; for (const reset of resets) reset(); table.reset(); resolve(host());
    const answer = await pending; expect(answer.value).toBe(-1); expect(answer.deferredWrites).toBeUndefined();
    expect(call('WSALookupServiceEnd', [handle])).toBe(-1); expect(errors.at(-1)).toEqual([7,6]);
});

test('lookup validation matches native structure, class and protocol selection without leaking handles', () => {
    const retained = begin();
    const again = () => { put(0x2200, 0x11223344); return call('WSALookupServiceBeginW', [0x1000, 0x330, 0x2200]); };
    put(0x1000, 59); expect(again()).toBe(-1); expect(errors.at(-1)).toEqual([7,10014]); expect(word(0x2200)).toBe(0);
    put(0x1000, 64); put(0x1008, 0);
    expect(again()).toBe(-1); expect(errors.at(-1)).toEqual([7,87]); expect(word(0x2200)).toBe(0);
    put(0x1008, 0x2400); put(0x1018, 0x2500);
    expect(again()).toBe(-1); expect(errors.at(-1)).toEqual([7,10022]); expect(word(0x2200)).toBe(0);
    put(0x1018, 0); put(0x2104, 0);
    expect(again()).toBe(-1); expect(errors.at(-1)).toEqual([7,11004]); expect(word(0x2200)).toBe(0);
    put(0x2104, 6); put(0x1024, 0);
    expect(again()).toBe(0); expect(word(0x2200)).not.toBe(retained);
    expect(call('WSALookupServiceEnd', [retained])).toBe(0);
});
test('null instance names resolve this host and a copied service class survives guest reuse', () => {
    begin(); put(0x1004, 0); ram.fill(0, 0x2400, 0x2410); put(0x2400, 0x12345678);
    let queried = 'untouched'; resolver = name => { queried = name; return host(); };
    expect(call('WSALookupServiceBeginW', [0x1000, 0x330, 0x2200])).toBe(0);
    const handle = word(0x2200); ram.fill(0xcc, 0x2400, 0x2410); put(0x2300, 4096);
    expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(0);
    expect(queried).toBe(''); expect(word(word(0x4008))).toBe(0x12345678);
});
test('LUP_FLUSHPREVIOUS discards a result retained after a short buffer', () => {
    const handle = begin(); put(0x2300, 0);
    expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0])).toBe(-1);
    put(0x2300, 4096); ram.fill(0xcc, 0x4000, 0x5000);
    expect(call('WSALookupServiceNextW', [handle, 0x2000, 0x2300, 0x4000])).toBe(-1);
    expect(errors.at(-1)).toEqual([7,10110]); expect(ram[0x4000]).toBe(0xcc);
    expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(-1);
    expect(errors.at(-1)).toEqual([7,10110]);
});
test('IPv6 CSADDR_INFO retains the selected scope and UDP protocol', () => {
    begin(); put(0x2100, 23); put(0x2104, 17);
    let family: number | undefined;
    const ip = Uint8Array.of(0xfe,0x80,0,0,0,0,0,0,0,0,0,0,0,0,0,1);
    resolver = (_name, _signal, selected) => { family = selected; return { canonicalName: 'scoped.test', addresses: [ip], scopeIds: [12] }; };
    expect(call('WSALookupServiceBeginW', [0x1000, 0x130, 0x2200])).toBe(0); const handle = word(0x2200);
    put(0x2300, 4096); expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(0);
    expect(family).toBe(6); expect(word(0x402c)).toBe(1);
    const entry = word(0x4030), remote = word(entry + 8);
    expect(word(entry + 12)).toBe(28); expect(word(entry + 16)).toBe(2); expect(word(entry + 20)).toBe(17);
    expect([...ram.slice(remote + 8, remote + 24)]).toEqual([...ip]); expect(word(remote + 24)).toBe(12);
});
test('concurrent Next calls share resolution and consume one result with issuer-local errors', async () => {
    let resolve!: (value: NamespaceHost) => void, calls = 0;
    resolver = () => { calls++; return new Promise(done => { resolve = done; }); };
    const handle = begin(); put(0x2300, 4096); put(0x2304, 4096);
    const first = call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000]) as Promise<ThunkResult>;
    thread = 8; const second = call('WSALookupServiceNextW', [handle, 0, 0x2304, 0x6000]) as Promise<ThunkResult>;
    thread = 9; resolve(host()); const [one, two] = await Promise.all([first, second]);
    expect(calls).toBe(1); expect(one.value).toBe(0); expect(one.deferredWrites?.length).toBeGreaterThan(0);
    expect(two.value).toBe(-1); expect(two.deferredWrites).toBeUndefined();
    expect(errors.slice(-2)).toEqual([[7,0],[8,10110]]); expect(word(0x4000)).toBe(0); expect(word(0x6000)).toBe(0);
});

test('Internet service-class GUIDs populate only the matching TCP or UDP remote port', () => {
    begin();
    for (const [kind, port, selected] of [[9,80,6],[10,53,17],[9,80,17],[10,53,6]]) {
        put(0x2400, (kind << 16) | port); put(0x2104, selected);
        expect(call('WSALookupServiceBeginW', [0x1000, 0x120, 0x2200])).toBe(0);
        const handle = word(0x2200); put(0x2300, 4096);
        expect(call('WSALookupServiceNextW', [handle, 0, 0x2300, 0x4000])).toBe(0);
        const entry = word(0x4030), remote = word(entry + 8);
        expect(word(entry + 20)).toBe(selected);
        expect(new DataView(ram.buffer).getUint16(remote + 2, false)).toBe(selected === (kind === 9 ? 6 : 17) ? port : 0);
        expect(word(word(0x4008))).toBe((kind << 16) | port);
        expect(call('WSALookupServiceEnd', [handle])).toBe(0);
    }
});

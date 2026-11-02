import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Process } from "../../src/worker/core/process";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { lanNetwork } from "../../src/worker/net/lan-network";
import { createDnsStubs, createAddrInfoStubs, createAsyncLookupStubs, getWsaProcessState } from "../../src/worker/modules/wsa-stub-shared";
const disposers: Array<() => void> = [];
afterEach(() => { for (const fn of disposers.splice(0).reverse()) fn(); });
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture() {
    let memory = new Uint8Array(0x100000), allocation = 0x10000, tid = 1;
    const process = Object.create(Process.prototype) as Process;
    (process as any).resetGeneration = 0;
    (process as any).memory = { alloc(size: number) { const ptr = allocation; allocation += size + 16; return ptr; }, free() {} };
    (process as any).addressSpace = {
        validateRange: (ptr: number, length: number) => ptr > 0 && ptr + length <= memory.length,
        write: (ptr: number, bytes: Uint8Array) => { memory.set(bytes, ptr); return bytes.length; },
    };
    const state = getWsaProcessState(process); state.counter.startup();
    const spy = spyOn(System.getInstance().scheduler, "getCurrentThreadId").mockImplementation(() => tid);
    const threadErrors = new Map<number, number>(), scheduler = System.getInstance().scheduler;
    const errorRead = spyOn(scheduler, "getLastError").mockImplementation(() => threadErrors.get(tid) ?? 0);
    const errorWrite = spyOn(scheduler, "setLastError").mockImplementation(code => { threadErrors.set(tid, code); });
    const errorOwnerWrite = spyOn(scheduler, "setLastErrorForThread").mockImplementation((id, code) => { threadErrors.set(id, code); return true; });
    const messages: number[][] = [];
    const post = spyOn(System.getInstance().windowManager, "postMessage").mockImplementation((...args) => { messages.push(args as number[]); });
    const wake = spyOn(System.getInstance().scheduler, "wakeMessageWaiters").mockImplementation(() => {});
    disposers.push(() => { state.reset(); spy.mockRestore(); errorRead.mockRestore(); errorWrite.mockRestore(); errorOwnerWrite.mockRestore(); post.mockRestore(); wake.mockRestore(); });
    const api = { ...createDnsStubs(process, state.setError), ...createAddrInfoStubs(process, state.setError), ...createAsyncLookupStubs(state.setError, process) };
    Mem.bind(() => memory);
    const call = (name: keyof typeof api, args: number[]) => (api[name] as any)({}, memory, args);
    const put = (ptr: number, value: string) => memory.set(new TextEncoder().encode(value + "\0"), ptr);
    const get = (ptr: number) => new DataView(memory.buffer).getUint32(ptr, true);
    const set = (ptr: number, value: number) => new DataView(memory.buffer).setUint32(ptr, value, true);
    const apply = (result: any) => { for (const write of result.deferredWrites ?? []) {
        if (write.size === 4) set(write.address, write.value); else memory[write.address] = write.value;
    } };
    return { process, state, call, put, get, set, apply, messages, memory: () => memory,
        thread(value: number) { tid = value; }, grow() { const next = new Uint8Array(memory.length * 2); next.set(memory); memory = next; } };
}
describe("Winsock DNS gateway ABI and asynchronous publication", () => {
    test("gethostbyname copies the name, retains all returned IPv4 addresses, and defers owner-memory outputs", async () => {
        const h = fixture(); let finish!: (answer: any) => void; let observed = "";
        const resolver = spyOn(lanNetwork, "resolve").mockImplementation(name => { observed = name; return new Promise(resolve => { finish = resolve; }); });
        disposers.push(() => resolver.mockRestore());
        h.put(0x100, "echo.allowed"); const args = [0x100], pending = h.call("gethostbyname", args);
        args[0] = 0; h.put(0x100, "overwritten"); h.thread(2); h.state.setError(99);
        const foreign = new Uint8Array(h.memory().length).fill(0x55); Mem.bind(() => foreign); h.grow();
        finish({ canonicalName: "canonical.allowed", addresses: [{ address: "192.0.2.7", family: 4 }, { address: "192.0.2.8", family: 4 }] });
        const result = await pending;
        expect(observed).toBe("echo.allowed"); expect(result.value).toBeGreaterThan(0); expect(h.get(result.value)).toBe(0);
        expect(foreign[result.value]).toBe(0x55); h.apply(result);
        const list = h.get(result.value + 12);
        expect([...h.memory().slice(h.get(list), h.get(list) + 4)]).toEqual([192, 0, 2, 7]);
        expect([...h.memory().slice(h.get(list + 4), h.get(list + 4) + 4)]).toEqual([192, 0, 2, 8]);
        expect(h.get(list + 8)).toBe(0); expect(h.state.getError()).toBe(99); h.thread(1); expect(h.state.getError()).toBe(0);
    });
    test("getaddrinfo resolves remotely and returns a complete independent result chain with canonical name", async () => {
        const h = fixture();
        const resolver = spyOn(lanNetwork, "resolve").mockResolvedValue({ canonicalName: "server.allowed", addresses: [{ address: "198.51.100.11", family: 4 }] });
        disposers.push(() => resolver.mockRestore());
        h.put(0x100, "alias.allowed"); h.put(0x180, "1234"); h.set(0x200, 2);
        const result = await h.call("getaddrinfo", [0x100, 0x180, 0x200, 0x300]); expect(result.value).toBe(0); h.apply(result);
        const head = h.get(0x300), next = h.get(head + 28), sa = h.get(head + 24);
        expect(h.get(head + 4)).toBe(2); expect(h.get(head + 8)).toBe(1); expect(h.get(next + 8)).toBe(2);
        expect(h.get(next + 20)).toBe(0); expect(h.get(next + 28)).toBe(0);
        expect([...h.memory().slice(sa + 2, sa + 8)]).toEqual([4, 210, 198, 51, 100, 11]);
        expect(h.call("freeaddrinfo", [head])).toBe(0);
    });
    test("getaddrinfo keeps distinct interface scopes for identical IPv6 DNS addresses", async () => {
        const h = fixture();
        const resolver = spyOn(lanNetwork, "resolve").mockResolvedValue({ canonicalName: "link.allowed", addresses: [
            { address: "fe80::1234", family: 6, scopeId: 11 }, { address: "fe80::1234", family: 6, scopeId: 12 },
        ] });
        disposers.push(() => resolver.mockRestore());
        h.put(0x100, "link.allowed"); h.put(0x180, "1234"); h.set(0x204, 23); h.set(0x208, 2);
        const result = await h.call("getaddrinfo", [0x100, 0x180, 0x200, 0x300]); expect(result.value).toBe(0); h.apply(result);
        const head = h.get(0x300), next = h.get(head + 28), first = h.get(head + 24), second = h.get(next + 24);
        expect(h.get(first + 24)).toBe(11); expect(h.get(second + 24)).toBe(12);
        expect([...h.memory().slice(first + 8, first + 24)]).toEqual([...h.memory().slice(second + 8, second + 24)]);
        expect(h.get(next + 28)).toBe(0); expect(h.call("freeaddrinfo", [head])).toBe(0);
    });
    test("WSAAsync lookup returns before completion, publishes before posting, and uses copied inputs", async () => {
        const h = fixture();
        const resolver = spyOn(lanNetwork, "resolve").mockResolvedValue({ canonicalName: "server.allowed", addresses: [{ address: "203.0.113.2", family: 4 }] });
        disposers.push(() => resolver.mockRestore());
        h.put(0x100, "alias.allowed"); const args = [10, 0x500, 0x100, 0x2000, 512];
        const task = h.call("WSAAsyncGetHostByName", args); args.fill(0);
        expect(task).toBeGreaterThan(0); expect(h.messages).toEqual([]); h.grow(); Mem.bind(() => new Uint8Array(h.memory().length));
        await tick(); expect(h.get(0x2000)).toBeGreaterThan(0);
        expect(h.messages.length).toBe(1); expect(h.messages[0].slice(0, 3)).toEqual([10, 0x500, task]); expect(h.messages[0][3] >>> 16).toBe(0);
    });
    test("CancelAsyncRequest is shared between DLL factories and suppresses writes and completion", async () => {
        const h = fixture(); let finish!: (answer: any) => void; let signal: AbortSignal | undefined;
        const resolver = spyOn(lanNetwork, "resolve").mockImplementation((_name, _family, received) => { signal = received; return new Promise(resolve => { finish = resolve; }); });
        disposers.push(() => resolver.mockRestore());
        h.put(0x100, "alias.allowed"); const task = h.call("WSAAsyncGetHostByName", [10, 0x500, 0x100, 0x2000, 512]);
        await Promise.resolve();
        const other = createAsyncLookupStubs(h.state.setError, h.process);
        expect(other.WSACancelAsyncRequest({} as any, h.memory(), [task])).toBe(0); expect(signal?.aborted).toBe(true);
        finish({ canonicalName: "server.allowed", addresses: [{ address: "203.0.113.2", family: 4 }] });
        await tick(); expect(h.messages).toEqual([]); expect(h.get(0x2000)).toBe(0);
        expect(h.call("WSACancelAsyncRequest", [task])).toBe(-1); expect(h.state.getError()).toBe(10022);
    });
    test("reset invalidates resolver requests before publication and last-error updates", async () => {
        const h = fixture(); let finish!: (answer: any) => void;
        const resolver = spyOn(lanNetwork, "resolve").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        disposers.push(() => resolver.mockRestore());
        h.put(0x100, "alias.allowed"); const pending = h.call("gethostbyname", [0x100]);
        h.state.reset(); h.state.setError(71);
        finish({ canonicalName: "server.allowed", addresses: [{ address: "203.0.113.2", family: 4 }] });
        const result = await pending; expect(result.value).toBe(0); expect(result.deferredWrites).toBeUndefined(); expect(h.state.getError()).toBe(71);
    });
    test("getaddrinfo returns IPv6 sockaddr_in6 records and getnameinfo retains the scope", async () => {
        const h = fixture(); h.put(0x100, "fe80::1234%7"); h.put(0x180, "1234"); h.set(0x204, 23); h.set(0x208, 2);
        const answer = h.call("getaddrinfo", [0x100, 0x180, 0x200, 0x300]); expect(answer).toBe(0);
        const head = h.get(0x300), sa = h.get(head + 24); expect(h.get(head + 16)).toBe(28); expect(h.get(head + 4)).toBe(23); expect(h.get(sa + 24)).toBe(7);
        expect(h.call("getnameinfo", [sa, 28, 0x400, 128, 0x500, 16, 2 | 8])).toBe(0);
        let end = 0x400; while (h.memory()[end]) end++;
        expect(new TextDecoder().decode(h.memory().slice(0x400, end))).toBe("fe80::1234%7");
    });
    test("short async buffers report the required size without partial pointer writes", async () => {
        const h = fixture(); h.put(0x100, "localhost");
        h.call("WSAAsyncGetHostByName", [10, 0x500, 0x100, 0x2000, 1]); await tick();
        expect(h.get(0x2000)).toBe(0); expect(h.messages[0][3] >>> 16).toBe(10055); expect(h.messages[0][3] & 0xffff).toBeGreaterThan(1);
    });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Wsock32 } from "../../src/worker/modules/wsock32";
import { Ws2_32 } from "../../src/worker/modules/ws2_32";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { lanNetwork } from "../../src/worker/net/lan-network";
import { getWsaProcessState, parseInetAddr } from "../../src/worker/modules/wsa-stub-shared";
import type { Process } from "../../src/worker/core/process";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
    const memory = new Uint8Array(0x8000);
    let allocation = 0x1000, tid = 1;
    const process = { memory: { alloc(size: number) { const ptr = allocation; allocation += size + 16; return ptr; }, free() {} } } as unknown as Process;
    const spy = spyOn(System.getInstance().scheduler, "getCurrentThreadId").mockImplementation(() => tid);
    const threadErrors = new Map<number, number>(), scheduler = System.getInstance().scheduler;
    const errorRead = spyOn(scheduler, "getLastError").mockImplementation(() => threadErrors.get(tid) ?? 0);
    const errorWrite = spyOn(scheduler, "setLastError").mockImplementation(code => { threadErrors.set(tid, code); });
    const errorOwnerWrite = spyOn(scheduler, "setLastErrorForThread").mockImplementation((id, code) => { threadErrors.set(id, code); return true; });
    Mem.bind(() => memory);
    const v1 = new Wsock32(), v2 = new Ws2_32();
    v1.initialize(process); v2.initialize(process);
    const state = getWsaProcessState(process);
    cleanup.push(() => { state.reset(); spy.mockRestore(); errorRead.mockRestore(); errorWrite.mockRestore(); errorOwnerWrite.mockRestore(); });
    const call = (module: Wsock32 | Ws2_32, name: string, args: number[] = []) => module.exports[name]({} as never, memory, args);
    const string = (ptr: number, value: string) => memory.set(new TextEncoder().encode(value + "\0"), ptr);
    const readString = (ptr: number) => { let end = ptr; while (memory[end]) end++; return new TextDecoder().decode(memory.slice(ptr, end)); };
    return { memory, process, v1, v2, state, call, string, readString, thread(value: number) { tid = value; } };
}
describe("Winsock provider ownership and thread semantics", () => {
    test("both DLLs share socket handles and startup reference counting", () => {
        const h = fixture();
        expect(h.call(h.v1, "WSAStartup", [0x101, 128])).toBe(0);
        expect(h.call(h.v2, "WSAStartup", [0x202, 128])).toBe(0);
        const s = h.call(h.v1, "socket", [2, 2, 17]) as number;
        expect(h.state.table.isValid(s)).toBe(true);
        expect(h.call(h.v2, "closesocket", [s])).toBe(0); expect(h.state.table.isValid(s)).toBe(false);
        const last = h.call(h.v2, "socket", [2, 2, 17]) as number;
        h.call(h.v1, "WSACleanup"); expect(h.state.table.isValid(last)).toBe(true);
        h.call(h.v2, "WSACleanup"); expect(h.state.table.isValid(last)).toBe(false);
        expect(h.call(h.v1, "socket", [2, 2, 17])).toBe(-1);
        expect(h.call(h.v2, "WSAGetLastError")).toBe(10093);
        expect(h.call(h.v1, "select", [0, 0, 0, 0, 0])).toBe(-1);
        expect(h.call(h.v2, "WSAGetLastError")).toBe(10093);
    });
    test("WSAGetLastError is per guest thread and shared across DLLs; socket success clears it", () => {
        const h = fixture();
        h.call(h.v1, "WSAStartup", [0x101, 128]);
        h.call(h.v1, "WSASetLastError", [12345]);
        expect(h.call(h.v2, "WSAGetLastError")).toBe(12345);
        h.thread(2); expect(h.call(h.v1, "WSAGetLastError")).toBe(0);
        h.call(h.v2, "closesocket", [999]); expect(h.call(h.v1, "WSAGetLastError")).toBe(10038);
        h.call(h.v1, "socket", [2, 2, 17]); expect(h.call(h.v2, "WSAGetLastError")).toBe(0);
        h.thread(1); expect(h.call(h.v2, "WSAGetLastError")).toBe(12345);
    });
    test("an async cancellation records the issuing thread's error after another thread runs", async () => {
        const h = fixture(); h.call(h.v1, "WSAStartup", [0x101, 128]);
        h.thread(2);
        const listener = h.call(h.v2, "socket", [2, 1, 6]) as number;
        expect(h.call(h.v1, "listen", [listener, 5])).toBe(0);
        const pending = h.call(h.v2, "accept", [listener, 0, 0]);
        expect(pending).toBeInstanceOf(Promise);
        h.thread(1); h.call(h.v1, "closesocket", [listener]); h.call(h.v1, "WSASetLastError", [42]);
        expect((await pending as any).value).toBe(-1);
        expect(h.call(h.v2, "WSAGetLastError")).toBe(42);
        h.thread(2); expect(h.call(h.v1, "WSAGetLastError")).toBe(10004);
    });
    test("processes do not share startup counts, socket tables or errors", () => {
        const h = fixture(), second = { memory: (h.process as any).memory } as Process;
        const state2 = getWsaProcessState(second);
        cleanup.push(() => state2.reset());
        h.call(h.v1, "WSAStartup", [0x101, 128]); h.call(h.v2, "WSASetLastError", [31]);
        expect(state2.counter.started).toBe(false); h.thread(2); expect(state2.getError()).toBe(0); h.thread(1);
        const s = h.call(h.v1, "socket", [2, 2, 0]) as number;
        expect(state2.table.isValid(s)).toBe(false);
    });
    test("active LAN hostname resolves to its virtual IPv4 and numeric peers retain their address", async () => {
        const h = fixture(); lanNetwork.setConnected(true); cleanup.push(() => lanNetwork.setConnected(false));
        h.call(h.v1, "WSAStartup", [0x101, 128]);
        expect(h.call(h.v2, "gethostname", [512, 128])).toBe(0);
        const name = h.readString(512); expect(name.startsWith("bottleship-")).toBe(true);
        const host = h.call(h.v1, "gethostbyname", [512]) as number;
        const list = Mem.readUint32(host + 12)!; const ip = Mem.readUint32(list)!;
        expect([...h.memory.slice(ip, ip + 4)]).toEqual([...lanNetwork.ipv4]);
        h.string(512, "10.4.5.6"); const numeric = h.call(h.v2, "gethostbyname", [512]) as number;
        const numericIP = Mem.readUint32(Mem.readUint32(numeric + 12)!)!;
        expect([...h.memory.slice(numericIP, numericIP + 4)]).toEqual([10, 4, 5, 6]);
        h.string(512, "unknown.invalid"); expect((await h.call(h.v1, "gethostbyname", [512]) as any).value).toBe(0);
        expect(h.call(h.v2, "WSAGetLastError")).toBe(10050);
    });
    test("DNS hostent scratch buffers and inet_ntoa strings belong to each guest thread", () => {
        const h = fixture(); h.call(h.v1, "WSAStartup", [0x101, 128]);
        h.string(512, "10.1.1.1"); const first = h.call(h.v1, "gethostbyname", [512]) as number;
        const firstIP = Mem.readUint32(Mem.readUint32(first + 12)!)!;
        h.thread(2); h.string(512, "10.2.2.2"); const second = h.call(h.v1, "gethostbyname", [512]) as number;
        expect(first).not.toBe(second); expect([...h.memory.slice(firstIP, firstIP + 4)]).toEqual([10, 1, 1, 1]);
    });
    test("IPX adapter/max packet queries use the actual interface and reject nonzero adapter indices", () => {
        const h = fixture(); h.call(h.v1, "WSAStartup", [0x101, 128]);
        const s = h.call(h.v1, "socket", [6, 2, 1000]) as number;
        Mem.writeUint32(600, 24); Mem.writeUint32(640, 0);
        expect(h.call(h.v1, "getsockopt", [s, 1000, 0x4007, 640, 600])).toBe(0);
        expect([...h.memory.slice(648, 654)]).toEqual([...lanNetwork.node]);
        expect(Mem.readUint32(656)).toBe(546);
        Mem.writeUint32(600, 24); Mem.writeUint32(640, 1);
        expect(h.call(h.v2, "getsockopt", [s, 1000, 0x4007, 640, 600])).toBe(-1);
        expect(h.call(h.v1, "WSAGetLastError")).toBe(10022);
    });
    test("inet_addr rejects overflow before truncating to uint32", () => {
        expect(parseInetAddr("4294967296")).toBe(0xffffffff);
        expect(parseInetAddr("1.4294967296")).toBe(0xffffffff);
    });
});

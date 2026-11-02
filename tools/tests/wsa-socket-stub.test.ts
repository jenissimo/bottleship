import { afterEach, describe, expect, test } from "bun:test";
import { WsaSocketTable, WSAEWOULDBLOCK, WSAENOTSOCK, WSAEINVAL, INVALID_SOCKET,
    makeSocketExports, WsaStartupCount } from "../../src/worker/modules/wsa-stub-shared";
import { WsaFailure } from "../../src/worker/modules/wsa-network";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const tables: WsaSocketTable[] = [];
afterEach(() => { for (const table of tables.splice(0)) table.reset(); });
function make() {
    const table = new WsaSocketTable(new LanNetwork()); tables.push(table);
    const counter = new WsaStartupCount(); counter.startup();
    let lastError = 0;
    const exports = makeSocketExports(table, value => { lastError = value; }, counter);
    const memory = new Uint8Array(256); Mem.bind(() => memory);
    const call = (name: string, args: number[]) => exports[name]({} as never, memory, args);
    return { table, exports, call, memory, error: () => lastError };
}
describe("WsaSocketTable provider boundary", () => {
    test("invalid socket and missing destination are real failures", () => {
        const h = make();
        expect(h.call("send", [999, 8, 4, 0])).toBe(-1); expect(h.error()).toBe(WSAENOTSOCK);
        const s = h.table.socket();
        expect(h.call("connect", [s, 0, 0])).toBe(-1); expect(h.error()).toBe(10014);
    });
    test("empty nonblocking accept returns WSAEWOULDBLOCK and never allocates connections", () => {
        const h = make(), listener = h.table.socket();
        h.table.listen(listener); h.table.setNonBlocking(listener, true);
        for (let i = 0; i < 1000; i++) {
            expect(h.call("accept", [listener, 0, 0])).toBe(INVALID_SOCKET);
            expect(h.error()).toBe(WSAEWOULDBLOCK);
        }
        expect(h.table.socket()).toBe(listener + 1);
    });
    test("accept rejects non-listening, datagram and closed sockets", () => {
        const h = make(), stream = h.table.socket(), datagram = h.table.socket(2);
        expect(h.call("accept", [stream, 0, 0])).toBe(INVALID_SOCKET); expect(h.error()).toBe(WSAEINVAL);
        expect(h.call("accept", [datagram, 0, 0])).toBe(INVALID_SOCKET); expect(h.error()).toBe(10045);
        expect(h.call("listen", [datagram, 5])).toBe(-1); expect(h.error()).toBe(10045);
        h.table.closesocket(stream);
        expect(h.call("accept", [stream, 0, 0])).toBe(INVALID_SOCKET); expect(h.error()).toBe(WSAENOTSOCK);
    });
    test("protocol-selected sockets retain stream/datagram semantics", () => {
        const h = make();
        const udp = h.call("socket", [2, 0, 17]) as number;
        expect(h.call("listen", [udp, 5])).toBe(-1); expect(h.error()).toBe(10045);
        const tcp = h.call("socket", [2, 0, 6]) as number;
        expect(h.call("listen", [tcp, 5])).toBe(0); h.table.setNonBlocking(tcp, true);
        expect(h.call("accept", [tcp, 0, 0])).toBe(INVALID_SOCKET); expect(h.error()).toBe(WSAEWOULDBLOCK);
    });
    test("blocking accept stays parked until cancellation", async () => {
        const h = make();
        for (const reset of [false, true]) {
            const listener = h.table.socket(); h.table.listen(listener);
            let completed = false;
            const pending = h.call("accept", [listener, 0, 0]) as Promise<any>;
            pending.then(() => { completed = true; });
            await Promise.resolve(); expect(completed).toBe(false);
            if (reset) h.table.reset(); else h.table.closesocket(listener);
            expect((await pending).value).toBe(INVALID_SOCKET); expect(h.error()).toBe(10004);
        }
    });
});

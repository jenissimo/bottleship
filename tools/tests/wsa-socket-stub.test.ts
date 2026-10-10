import { describe, expect, test } from "bun:test";
import { WsaSocketTable, WSAEWOULDBLOCK, WSAENOTSOCK, WSAEINVAL, INVALID_SOCKET,
    makeSocketExports, WsaStartupCount } from "../../src/worker/modules/wsa-stub-shared";

describe("WsaSocketTable", () => {
    test("socket/connect/send/recv offline semantics", () => {
        const table = new WsaSocketTable();
        const s = table.socket();
        expect(s).toBeGreaterThan(0);
        expect(table.connect(s)).toBe(0);
        expect(table.send(s, 128)).toBe(128);
        expect(table.recv(s)).toBe(-1);
        expect(table.closesocket(s)).toBe(0);
        expect(table.isValid(s)).toBe(false);
    });

    test("invalid socket returns errors via table helpers", () => {
        const table = new WsaSocketTable();
        expect(table.send(999, 4)).toBe(-1);
        expect(table.isValid(999)).toBe(false);
        void WSAEWOULDBLOCK;
        void WSAENOTSOCK;
    });

    test("empty nonblocking accept returns WSAEWOULDBLOCK and never allocates connections", () => {
        const table = new WsaSocketTable();
        const counter = new WsaStartupCount();
        counter.startup();
        let error = 0;
        const exports = makeSocketExports(table, value => { error = value; }, counter);
        const listener = table.socket();
        table.listen(listener);
        table.setNonBlocking(listener, true);
        const memory = new Uint8Array(32).fill(0x5a);
        for (let i = 0; i < 1000; i++) {
            expect(exports.accept(null as never, memory, [listener, 8, 24])).toBe(INVALID_SOCKET);
            expect(error).toBe(WSAEWOULDBLOCK);
        }
        expect(table.socket()).toBe(listener + 1);
        expect(memory.every(value => value === 0x5a)).toBe(true);
    });

    test("accept rejects non-listening, datagram and closed sockets", () => {
        const table = new WsaSocketTable();
        const stream = table.socket();
        expect(table.acceptError(stream)).toBe(WSAEINVAL);
        expect(table.accept(stream)).toBe(INVALID_SOCKET);
        const datagram = table.socket(2);
        expect(table.listen(datagram)).toBe(-1);
        expect(table.acceptError(datagram)).toBe(10045);
        const raw = table.socket(3);
        expect(table.listen(raw)).toBe(-1);
        expect(table.acceptError(raw)).toBe(10045);
        table.closesocket(stream);
        expect(table.acceptError(stream)).toBe(WSAENOTSOCK);
    });

    test("protocol-selected socket type retains stream or datagram listening semantics", () => {
        const table = new WsaSocketTable();
        const counter = new WsaStartupCount();
        counter.startup();
        let error = 0;
        const exports = makeSocketExports(table, value => { error = value; }, counter);
        const memory = new Uint8Array(32);
        const udp = exports.socket(null as never, memory, [2, 0, 17]) as number;
        expect(table.listen(udp)).toBe(-1);
        expect(exports.accept(null as never, memory, [udp, 0, 0])).toBe(INVALID_SOCKET);
        expect(error).toBe(10045);
        const tcp = exports.socket(null as never, memory, [2, 0, 6]) as number;
        expect(table.listen(tcp)).toBe(0);
        table.setNonBlocking(tcp, true);
        expect(exports.accept(null as never, memory, [tcp, 0, 0])).toBe(INVALID_SOCKET);
        expect(error).toBe(WSAEWOULDBLOCK);
    });

    test("blocking accept stays pending until the listener closes or the table resets", async () => {
        const table = new WsaSocketTable();
        for (const reset of [false, true]) {
            const listener = table.socket();
            table.listen(listener);
            let completed = false;
            const pending = table.accept(listener) as Promise<number>;
            pending.then(() => { completed = true; });
            await Promise.resolve();
            expect(completed).toBe(false);
            if (reset) table.reset(); else table.closesocket(listener);
            expect(await pending).toBe(INVALID_SOCKET);
        }
    });
});

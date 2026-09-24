/**
 * Winsock startup reference counting and socket() argument checks.
 *
 * Ground truth: Wine ws2_32 socket.c — WSAStartup counts only successful calls and returns
 * its error directly, WSACleanup decrements and fails with WSANOTINITIALISED at zero, and
 * WSASocketW refuses before WSAStartup and resolves (af, type, protocol) against the
 * provider catalog.
 */

import { describe, expect, test } from "bun:test";
import {
    WsaStartupCount, WsaSocketTable, makeWsaStartup, makeWsaCleanup, makeSocketExports,
    validateSocketTriple, SOCKET_ERROR, INVALID_SOCKET, WSAEFAULT, WSANOTINITIALISED,
    WSAVERNOTSUPPORTED, WSAEINVAL, WSAEAFNOSUPPORT, WSAESOCKTNOSUPPORT, WSAEPROTONOSUPPORT,
} from "../../src/worker/modules/wsa-stub-shared";

const AF_INET = 2, AF_INET6 = 23, AF_IPX = 6, AF_APPLETALK = 16;
const SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_RAW = 3;
const IPPROTO_TCP = 6, IPPROTO_UDP = 17;

function harness() {
    const counter = new WsaStartupCount();
    let lastError = -1;
    const setError = (code: number) => { lastError = code; };
    const mem = new Uint8Array(0x1000);
    const startup = makeWsaStartup(setError, WSAEFAULT, SOCKET_ERROR, counter);
    const cleanup = makeWsaCleanup(counter, setError);
    const sockets = makeSocketExports(new WsaSocketTable(), setError, counter);
    const call = (fn: any, args: number[]) => fn({}, mem, args) as number;
    return { counter, call, startup, cleanup, sockets, lastError: () => lastError };
}

describe("WSAStartup / WSACleanup", () => {
    test("each successful startup needs its own cleanup", () => {
        const h = harness();
        expect(h.call(h.startup, [0x0202, 0x100])).toBe(0);
        expect(h.call(h.startup, [0x0101, 0x100])).toBe(0);
        expect(h.call(h.cleanup, [])).toBe(0);
        expect(h.counter.started).toBe(true);
        expect(h.call(h.cleanup, [])).toBe(0);
        expect(h.counter.started).toBe(false);
        expect(h.call(h.cleanup, [])).toBe(SOCKET_ERROR);
        expect(h.lastError()).toBe(WSANOTINITIALISED);
    });

    test("a failed startup returns its error and is not counted", () => {
        const h = harness();
        expect(h.call(h.startup, [0x0202, 0])).toBe(WSAEFAULT);
        expect(h.call(h.startup, [0x0000, 0x100])).toBe(WSAVERNOTSUPPORTED);
        expect(h.counter.started).toBe(false);
        expect(h.call(h.cleanup, [])).toBe(SOCKET_ERROR);
    });
});

describe("socket()", () => {
    test("refuses before WSAStartup and after the last WSACleanup", () => {
        const h = harness();
        const socket = h.sockets.socket!;
        expect(h.call(socket, [AF_INET, SOCK_STREAM, IPPROTO_TCP])).toBe(INVALID_SOCKET);
        expect(h.lastError()).toBe(WSANOTINITIALISED);
        h.call(h.startup, [0x0202, 0x100]);
        const s = h.call(socket, [AF_INET, SOCK_STREAM, IPPROTO_TCP]);
        expect(s).not.toBe(INVALID_SOCKET);
        expect(h.lastError()).toBe(0);
        h.call(h.cleanup, []);
        expect(h.call(socket, [AF_INET, SOCK_DGRAM, 0])).toBe(INVALID_SOCKET);
    });

    test("the triple is checked against the provider catalog", () => {
        expect(validateSocketTriple(AF_INET, SOCK_STREAM, 0)).toBe(0);
        expect(validateSocketTriple(AF_INET, SOCK_DGRAM, IPPROTO_UDP)).toBe(0);
        expect(validateSocketTriple(AF_INET, SOCK_RAW, 255)).toBe(0);
        expect(validateSocketTriple(AF_INET6, SOCK_STREAM, IPPROTO_TCP)).toBe(0);
        expect(validateSocketTriple(AF_IPX, SOCK_DGRAM, 1000)).toBe(0);
        expect(validateSocketTriple(0, 0, IPPROTO_TCP)).toBe(0);

        expect(validateSocketTriple(0, SOCK_STREAM, 0)).toBe(WSAEINVAL);
        expect(validateSocketTriple(AF_APPLETALK, SOCK_STREAM, 0)).toBe(WSAEAFNOSUPPORT);
        expect(validateSocketTriple(AF_INET6, SOCK_RAW, 0)).toBe(WSAESOCKTNOSUPPORT);
        expect(validateSocketTriple(AF_INET, SOCK_STREAM, IPPROTO_UDP)).toBe(WSAEPROTONOSUPPORT);
    });

    test("a refused triple sets the error and hands out no socket", () => {
        const h = harness();
        h.call(h.startup, [0x0202, 0x100]);
        expect(h.call(h.sockets.socket!, [AF_APPLETALK, SOCK_STREAM, 0])).toBe(INVALID_SOCKET);
        expect(h.lastError()).toBe(WSAEAFNOSUPPORT);
    });
});

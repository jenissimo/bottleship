import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NetworkConsent, networkConsent, gateNetworkThunk, type NetworkConsentRequest } from "../../src/worker/net/network-consent";
import { restartableCheck } from "../../src/worker/core/thunking/restartable";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { WsaSocketTable, WSA, ipv4Address, ipv6Address } from "../../src/worker/modules/wsa-network";
import { wsaDestinationLeavesSession, wsaListenerLeavesSession } from "../../src/worker/modules/wsa-network-consent";
import { makeSocketExports, WsaStartupCount } from "../../src/worker/modules/wsa-stub-shared";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import type { ThunkResult } from "../../src/worker/core/thunking/thunk-dispatcher";

const self = { node: Uint8Array.of(2, 0, 0, 1, 1, 7), ipv4: Uint8Array.of(10, 1, 1, 7), ipv6: new LanNetwork(Uint8Array.of(2, 0, 0, 1, 1, 7)).ipv6 };
const v6 = (text: string) => { const out = new Uint8Array(16); if (text === "::1") out[15] = 1; return out; };

describe("network permission state", () => {
    test("off allows everything without asking (the embedding contract)", () => {
        const consent = new NetworkConsent(), posted: NetworkConsentRequest[] = [];
        consent.post = r => posted.push(r);
        expect(consent.check({ api: "winsock", operation: "connect" })).toBe("allow");
        expect(posted).toHaveLength(0);
    });
    test("ask posts ONE request for concurrent callers, each parked on its own restartable promise", async () => {
        const consent = new NetworkConsent(), posted: NetworkConsentRequest[] = [];
        consent.post = r => posted.push(r); consent.configure("ask");
        const waits: boolean[] = []; consent.onWaitingChange(w => waits.push(w));
        const a = consent.check({ api: "winsock", operation: "connect", target: "10.1.2.3:80" });
        const b = consent.check({ api: "directplay", operation: "EnumSessions" });
        expect(a).toBeInstanceOf(Promise); expect(b).toBeInstanceOf(Promise); expect(a).not.toBe(b);
        expect(posted).toEqual([{ id: 1, api: "winsock", operation: "connect", target: "10.1.2.3:80" }]);
        expect(restartableCheck(a as Promise<unknown>)?.()).toBe(true);
        expect(consent.state.waiting?.id).toBe(1);
        consent.answer(99, true);                       // stale id: ignored
        expect(consent.state.decision).toBe("undecided");
        consent.answer(1, true);
        expect(await a).toEqual({ value: 0, reissue: true });
        expect(await b).toEqual({ value: 0, reissue: true });
        expect(waits).toEqual([true, false]);
        expect(consent.check({ api: "winsock", operation: "sendto" })).toBe("allow");
        expect(posted).toHaveLength(1);
    });
    test("a refusal holds for the session; a later explicit connect grants", async () => {
        const consent = new NetworkConsent();
        consent.configure("ask");
        const parked = consent.check({ api: "winsock", operation: "connect" }) as Promise<ThunkResult>;
        consent.answer(1, false);
        expect((await parked).reissue).toBe(true);
        expect(consent.check({ api: "winsock", operation: "connect" })).toBe("deny");
        consent.decide("granted");
        expect(consent.check({ api: "winsock", operation: "connect" })).toBe("allow");
    });
    test("the parked callers wait for the relay before they are released", async () => {
        const consent = new NetworkConsent(); consent.configure("ask");
        let ready!: () => void; const relay = new Promise<void>(r => { ready = r; });
        consent.beforeRelease = () => relay;
        let released = false;
        void (consent.check({ api: "winsock", operation: "connect" }) as Promise<ThunkResult>).then(() => { released = true; });
        consent.answer(1, true); await Promise.resolve(); await Promise.resolve();
        expect(released).toBe(false);
        ready(); await relay; await new Promise(r => setTimeout(r, 0));
        expect(released).toBe(true);
    });
    test("gateNetworkThunk runs the real call for local traffic and the deny result after a refusal", () => {
        const consent = new NetworkConsent(); consent.configure("ask"); consent.decide("denied");
        const impl = () => 7;
        const gated = gateNetworkThunk(impl, a => a[0] ? { api: "winsock", operation: "connect" } : null, () => -1, consent);
        expect(gated({} as never, new Uint8Array(), [0])).toBe(7);
        expect(gated({} as never, new Uint8Array(), [1])).toBe(-1);
        const proceeds = gateNetworkThunk(impl, () => ({ api: "winsock", operation: "listen" }), undefined, consent);
        expect(proceeds({} as never, new Uint8Array(), [1])).toBe(7);
    });
});

describe("what leaves the guest session", () => {
    test("IPv4: loopback, own address and unspecified stay local", () => {
        for (const ip of [[127, 0, 0, 1], [127, 9, 9, 9], [10, 1, 1, 7], [0, 0, 0, 0]])
            expect(wsaDestinationLeavesSession(ipv4Address(Uint8Array.from(ip), 80), self)).toBe(false);
        for (const ip of [[10, 1, 1, 8], [255, 255, 255, 255], [10, 1, 255, 255], [239, 1, 2, 3], [8, 8, 8, 8]])
            expect(wsaDestinationLeavesSession(ipv4Address(Uint8Array.from(ip), 80), self)).toBe(true);
    });
    test("IPv6 and IPX", () => {
        expect(wsaDestinationLeavesSession(ipv6Address(v6("::1"), 80), self)).toBe(false);
        expect(wsaDestinationLeavesSession(ipv6Address(self.ipv6, 80), self)).toBe(false);
        const mapped = new Uint8Array(16); mapped[10] = mapped[11] = 255; mapped.set([127, 0, 0, 1], 12);
        expect(wsaDestinationLeavesSession(ipv6Address(mapped, 80), self)).toBe(false);
        mapped.set([10, 1, 1, 9], 12);
        expect(wsaDestinationLeavesSession(ipv6Address(mapped, 80), self)).toBe(true);
        const other = self.ipv6.slice(); other[15] ^= 1;
        expect(wsaDestinationLeavesSession(ipv6Address(other, 80), self)).toBe(true);
        expect(wsaDestinationLeavesSession({ family: 6, node: self.node, port: 1 }, self)).toBe(false);
        expect(wsaDestinationLeavesSession({ family: 6, node: new Uint8Array(6).fill(255), port: 1 }, self)).toBe(true);
        expect(wsaDestinationLeavesSession({ family: 0, node: new Uint8Array(6), port: 0 }, self)).toBe(false);
    });
    test("a listener is reachable unless bound to loopback", () => {
        expect(wsaListenerLeavesSession(ipv4Address(Uint8Array.of(127, 0, 0, 1), 1), 2)).toBe(false);
        expect(wsaListenerLeavesSession(ipv4Address(Uint8Array.of(0, 0, 0, 0), 1), 2)).toBe(true);
        expect(wsaListenerLeavesSession(null, 2)).toBe(true);
        expect(wsaListenerLeavesSession(ipv6Address(v6("::1"), 1), 23)).toBe(false);
        expect(wsaListenerLeavesSession(null, 6)).toBe(false);
    });
});

describe("Winsock gate", () => {
    let memory: Uint8Array, lastError: number, posted: NetworkConsentRequest[], table: WsaSocketTable;
    let call: (name: string, args: number[]) => unknown;
    const sockaddr = (ptr: number, ip: number[], port: number) => {
        memory.set([2, 0, port >> 8, port & 255, ...ip], ptr);
        return [ptr, 16];
    };
    beforeEach(() => {
        memory = new Uint8Array(65536); lastError = 0; posted = [];
        Mem.bind(() => memory);
        table = new WsaSocketTable(new LanNetwork(self.node.slice()));
        const counter = new WsaStartupCount(); counter.startup();
        const exports = makeSocketExports(table, code => { lastError = code; }, counter);
        call = (name, args) => exports[name]({} as never, memory, args);
        networkConsent.reset(); networkConsent.post = r => posted.push(r); networkConsent.configure("ask");
    });
    afterEach(() => { table.reset(); networkConsent.reset(); networkConsent.post = () => {}; });

    test("socket(), bind() and loopback traffic never ask", () => {
        const udp = call("socket", [2, 2, 17]) as number;
        expect(call("bind", [udp, ...sockaddr(0x100, [0, 0, 0, 0], 0)])).toBe(0);
        expect(call("sendto", [udp, 0x200, 4, 0, ...sockaddr(0x100, [127, 0, 0, 1], 5000)])).toBe(4);
        const tcp = call("socket", [2, 1, 6]) as number;
        expect(call("bind", [tcp, ...sockaddr(0x100, [127, 0, 0, 1], 6000)])).toBe(0);
        expect(call("listen", [tcp, 5])).toBe(0);
        expect(posted).toHaveLength(0);
    });
    test("connect, sendto to another host or broadcast, and listen on any address ask", () => {
        const tcp = call("socket", [2, 1, 6]) as number;
        expect(call("connect", [tcp, ...sockaddr(0x100, [10, 1, 1, 9], 80)])).toBeInstanceOf(Promise);
        expect(posted[0]).toMatchObject({ api: "winsock", operation: "connect", target: "10.1.1.9:80" });
        const udp = call("socket", [2, 2, 17]) as number;
        expect(call("sendto", [udp, 0x200, 4, 0, ...sockaddr(0x100, [255, 255, 255, 255], 27910)])).toBeInstanceOf(Promise);
        const server = call("socket", [2, 1, 6]) as number;
        expect(call("listen", [server, 5])).toBeInstanceOf(Promise);
        expect(posted).toHaveLength(1);
    });
    test("refused: connect and sendto fail with WSAENETUNREACH; listen still listens", async () => {
        const tcp = call("socket", [2, 1, 6]) as number;
        const parked = call("connect", [tcp, ...sockaddr(0x100, [10, 1, 1, 9], 80)]) as Promise<ThunkResult>;
        networkConsent.answer(posted[0].id, false);
        expect((await parked).reissue).toBe(true);
        // The dispatcher re-enters the stub: the same call, now answered.
        expect(call("connect", [tcp, ...sockaddr(0x100, [10, 1, 1, 9], 80)])).toBe(-1);
        expect(lastError).toBe(WSA.ENETUNREACH);
        expect(call("WSAConnect", [tcp, ...sockaddr(0x100, [10, 1, 1, 9], 80), 0, 0, 0, 0])).toBe(-1);
        expect(lastError).toBe(WSA.ENETUNREACH);
        const udp = call("socket", [2, 2, 17]) as number;
        lastError = 0;
        expect(call("sendto", [udp, 0x200, 4, 0, ...sockaddr(0x100, [10, 1, 255, 255], 27910)])).toBe(-1);
        expect(lastError).toBe(WSA.ENETUNREACH);
        expect(call("sendto", [udp, 0x200, 4, 0, ...sockaddr(0x100, [127, 0, 0, 1], 27910)])).toBe(4);
        const server = call("socket", [2, 1, 6]) as number;
        expect(call("listen", [server, 5])).toBe(0);
        expect(posted).toHaveLength(1);
    });
});

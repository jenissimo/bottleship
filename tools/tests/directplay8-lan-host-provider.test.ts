import { afterEach, expect, test } from "bun:test";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP } from "../../src/worker/net/netplay-wire";
import { lanDirectPlay8HostProvider } from "../../src/worker/modules/dpnet/lan-host-provider";
import type { DirectPlay8HostRequest } from "../../src/worker/modules/dpnet/backend";
const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });
function scene() {
    const network = new LanNetwork(Uint8Array.of(2,0,0,0,0,91));
    network.attach({ send: () => true, close() {} }); clean.push(() => network.reset());
    network.configureDirectPlay8({ provider: "native", hostListener: "game-host" });
    const endpoint = { deliver() {} }; expect(network.bind(2308, endpoint, PROTO_UDP)).toBe(true);
    const request: DirectPlay8HostRequest = { localPort: 2308, bindingGeneration: network.bindingGeneration(2308, PROTO_UDP),
        localAddress: { node: [...network.node], port: 2308 }, signal: new AbortController().signal };
    let releases = 0, live = true, close!: (reason: { code: number; message: string }) => void;
    const lease = { address: { node: [2,1,127,0,0,1], port: 45001 }, allowedNodes: [[2,1,127,0,0,1]],
        isLive: () => live, closed: new Promise<{ code: number; message: string }>(resolve => close = resolve),
        release() { expect(this).toBe(lease); releases++; live = false; } };
    const calls: unknown[][] = [];
    network.openUdpHost = async (...args) => { calls.push(args); return lease; };
    return { network, request, calls, lease, get releases() { return releases; }, close: () => { live = false; close({ code: 10054, message: "listener lost" }); } };
}
test("native Host policy is explicit and preparation uses the exact reserved binding", async () => {
    const s = scene(); s.network.configureDirectPlay8(); expect(lanDirectPlay8HostProvider(s.network)).toBeUndefined();
    s.network.configureDirectPlay8({ provider: "native", hostListener: "game-host" });
    const ready = await lanDirectPlay8HostProvider(s.network)!.prepare(s.request);
    expect(s.calls).toEqual([[2308, "game-host", s.request.signal]]);
    expect(ready.address).toEqual(s.lease.address); expect(ready.isLive!()).toBe(true); expect(ready.closed).toBe(s.lease.closed);
    expect(ready.allowIncoming({ node: [2,1,127,0,0,1], port: 1 })).toBe(true);
    expect(ready.allowIncoming({ node: [2,1,127,0,0,1], port: 65535 })).toBe(true);
    for (const port of [0,65536,1.5]) expect(ready.allowIncoming({ node: [2,1,127,0,0,1], port })).toBe(false);
    expect(ready.allowIncoming({ node: [2,1,127,0,0,2], port: 2309 })).toBe(false);
    expect(ready.url({ node: [2,1,127,0,0,1], port: 2309 })).toContain("hostname=127.0.0.1;port=2309");
    s.lease.address.port = 45099; s.lease.allowedNodes[0][5] = 2;
    expect(ready.address.port).toBe(45001); expect(ready.allowIncoming({ node: [2,1,127,0,0,1], port: 2309 })).toBe(true);
    ready.release(); ready.release(); expect(s.releases).toBe(1); expect(ready.isLive!()).toBe(false);
});
test("stale binding or cancelled READY never becomes an admitted native Host lease", async () => {
    const s = scene(), provider = lanDirectPlay8HostProvider(s.network)!;
    await expect(provider.prepare({ ...s.request, bindingGeneration: s.request.bindingGeneration + 1 })).rejects.toBeDefined();
    expect(s.calls).toEqual([]);
    const abort = new AbortController(); let finish!: (value: typeof s.lease) => void;
    s.network.openUdpHost = () => new Promise(resolve => finish = resolve);
    const pending = provider.prepare({ ...s.request, signal: abort.signal }); abort.abort(); finish(s.lease);
    await expect(pending).rejects.toBeDefined(); expect(s.releases).toBe(1);
});
test("listener terminal state refuses ingress immediately and notifies the attached backend", async () => {
    const s = scene(), ready = await lanDirectPlay8HostProvider(s.network)!.prepare(s.request);
    s.close(); expect(ready.isLive!()).toBe(false);
    expect(ready.allowIncoming({ node: [2,1,127,0,0,1], port: 2309 })).toBe(false);
    expect(await ready.closed).toEqual({ code: 10054, message: "listener lost" }); ready.release(); expect(s.releases).toBe(1);
});

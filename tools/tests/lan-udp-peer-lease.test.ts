import { expect, test } from "bun:test";
import { LanNetwork, type NetTransport } from "../../src/worker/net/lan-network";
import { PROTO_UDP } from "../../src/worker/net/netplay-wire";
const node = Uint8Array.of(2, 1, 127, 0, 0, 1);
const endpoint = { deliver() {} };
function setup(leaseUdpPeer: NonNullable<NetTransport["leaseUdpPeer"]>) {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 1)); let sends = 0;
    network.attach({ send() { sends++; return true; }, leaseUdpPeer, close() {} });
    expect(network.bind(2302, endpoint, PROTO_UDP)).toBe(true);
    return { network, sends: () => sends };
}
test("native UDP peer readiness waits for an explicit ACK and emits no dummy datagram", async () => {
    let ready!: (lease: { release(): void }) => void, released = 0, request: unknown, completed = false;
    const { network, sends } = setup(value => { request = value; return new Promise(resolve => { ready = resolve; }); });
    const promise = network.leaseUdpPeer(2302, node, 56584).then(lease => { completed = true; return lease; });
    await Promise.resolve(); expect(completed).toBe(false); expect(sends()).toBe(0);
    expect(request).toEqual({ proto: 1, localPort: 2302, bindingGeneration: network.bindingGeneration(2302, 1), node: [...node], remotePort: 56584 });
    ready({ release() { released++; } }); const lease = await promise; expect(completed).toBe(true); expect(sends()).toBe(0);
    lease.release(); lease.release(); network.reset(); expect(released).toBe(1);
});
test("cancelled readiness rejects immediately and a late ACK releases its old ownership once", async () => {
    let ready!: (lease: { release(): void }) => void, released = 0;
    const { network } = setup(() => new Promise(resolve => { ready = resolve; })), controller = new AbortController();
    const result = network.leaseUdpPeer(2302, node, 56584, controller.signal).catch(error => error);
    controller.abort(); expect(await result).toBeInstanceOf(Error);
    ready({ release() { released++; } }); await Promise.resolve(); await Promise.resolve();
    expect(released).toBe(1); network.reset(); expect(released).toBe(1);
});
test("unbind and adapter replacement fence pending and active leases from a reused UDP port", async () => {
    const waiting: ((lease: { release(): void }) => void)[] = []; let released = 0;
    const { network } = setup(() => new Promise(resolve => waiting.push(resolve)));
    const first = network.leaseUdpPeer(2302, node, 1).catch(error => error);
    network.unbind(2302, endpoint, 1); expect(await first).toBeInstanceOf(Error);
    expect(network.bind(2302, endpoint, 1)).toBe(true);
    const second = network.leaseUdpPeer(2302, node, 2);
    waiting[0]({ release() { released++; } }); waiting[1]({ release() { released++; } });
    const lease = await second; expect(released).toBe(1);
    network.attach({ send() { return true; }, close() {} }); expect(released).toBe(2);
    lease.release(); network.reset(); expect(released).toBe(2);
});
test("pending and active native UDP leases have finite admission and unsupported native transport fails", async () => {
    const { network } = setup((_request, signal) => new Promise((_ok, reject) => signal!.addEventListener("abort", () => reject(Error("cancelled")), { once: true })));
    const pending = Array.from({ length: 16 }, (_, i) => network.leaseUdpPeer(2302, node, i + 1).catch(error => error));
    expect(await network.leaseUdpPeer(2302, node, 99).catch(error => error)).toBeInstanceOf(Error);
    network.reset(); expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true);
    expect(network.bind(2302, endpoint, 1)).toBe(true);
    network.attach({ send() { return true; }, close() {} });
    expect(await network.leaseUdpPeer(2302, node, 1).catch(error => error)).toBeInstanceOf(Error);
    network.reset();
});

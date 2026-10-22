import { expect, test } from "bun:test";
import {
    ChildProcessNetworkNamespace, RootNetworkNamespace, type ChildNetworkNamespace,
} from "../../src/worker/core/network-namespace";
import { LanNetwork, type LanDatagram, type LanSocketError, type NetTransport } from "../../src/worker/net/lan-network";
import { PROTO_TCP, PROTO_RAW4, SYN, DATA, FIN, RST, encodeDatagram, decodeDatagram, decodeTcpFrame, encodeTcpFrame } from "../../src/worker/net/netplay-wire";

// Only the actor's lifecycle control channel is needed here. No socket actor,
// relay connection, native socket, or helper process is started by these tests.
class MemoryControlWorker extends EventTarget {
    private readonly ports: MessagePort[] = [];
    postMessage(message: { control: MessagePort; network: { port: MessagePort } }): void {
        const control = message.control;
        this.ports.push(control, message.network.port);
        control.onmessage = event => {
            const request = event.data;
            if (request.type === "shutdown" || request.type === "barrier" || request.type === "finish") {
                control.postMessage({ type: request.type === "shutdown" ? "shutdownDone"
                    : request.type === "finish" ? "finished" : "barrierDone", id: request.id });
            }
        };
        control.start();
    }
    unref(): void {}
    terminate(): void {
        for (const port of this.ports) port.close();
        this.dispatchEvent(new Event("close"));
    }
}
interface BrokerProbe {
    backplane: LanNetwork;
    clients: Map<number, { pending: { kind: string }[] }>;
    tcp: Map<string, { id: number }>;
}
type Sent = { kind: "frame"; tcpKind: number; id: number; generation: number; data: number[] }
    | { kind: "release"; port: number; proto: number; generation: number };
async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out: " + what);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}
function fixture() {
    const network = new LanNetwork(Uint8Array.of(2, 0, 0, 12, 13, 14));
    const savedWorker = globalThis.Worker;
    let host: RootNetworkNamespace;
    try {
        globalThis.Worker = MemoryControlWorker as unknown as typeof Worker;
        host = new RootNetworkNamespace(network, 16, 81001);
    } finally { globalThis.Worker = savedWorker; }
    const broker = host! as unknown as BrokerProbe;
    const sent: Sent[] = [], children: { namespace: ChildProcessNetworkNamespace; lease: ChildNetworkNamespace }[] = [];
    let writable = false;
    const transport: NetTransport = {
        connected: true,
        send(frame, generation = 0) {
            if (!writable) return false;
            const datagram = decodeDatagram(frame)!, packet = decodeTcpFrame(datagram.payload)!;
            sent.push({ kind: "frame", tcpKind: packet.kind, id: packet.srcId, generation, data: [...packet.data] });
            return true;
        },
        releasePort(port, proto, generation) { sent.push({ kind: "release", port, proto, generation }); },
        close() {},
    };
    broker.backplane.attach(transport);
    return {
        host: host!, network, broker, sent,
        remote: Uint8Array.of(2, 0, 0, 90, 91, 92),
        child(pid: number) {
            const lease = host!.createChild(pid), childNetwork = new LanNetwork();
            const namespace = new ChildProcessNetworkNamespace(childNetwork, lease.boot);
            children.push({ namespace, lease });
            return { namespace, network: childNetwork, lease };
        },
        admit() { return Promise.all(children.map(child => child.namespace.barrier())); },
        drain() { writable = true; broker.backplane.notifyWritable(); },
        disconnect() { broker.backplane.setConnected(false, "in-memory link loss"); },
        async close() {
            for (const child of children) { child.namespace.close(); child.lease.close(); }
            await host!.close();
        },
    };
}

test("queued TCP DATA and FIN precede release; the old release preserves a rebound stream", async () => {
    const h = fixture(), child = h.child(81002), port = 7200;
    const before = { deliver() {} }, after = { deliver() {} };
    const departures: number[] = [], errors: LanSocketError[] = [];
    h.network.onPortDisconnect(event => departures.push(event.port));
    h.network.onSocketError(error => errors.push(error));
    try {
        await until(() => child.network.connected, "child connected state");
        expect(child.network.bind(port, before, PROTO_TCP)).toBe(true);
        const old = child.network.bindingGeneration(port, PROTO_TCP);
        expect(child.network.send(port, h.remote, 9000, encodeTcpFrame(SYN, 101, 0, 65536), PROTO_TCP)).toBe(true);
        expect(child.network.send(port, h.remote, 9000, encodeTcpFrame(DATA, 101, 901, 0, Uint8Array.of(4, 5, 6)), PROTO_TCP)).toBe(true);
        expect(child.network.send(port, h.remote, 9000, encodeTcpFrame(FIN, 101, 901), PROTO_TCP)).toBe(true);
        child.network.unbind(port, before, PROTO_TCP);
        expect(child.network.bind(port, after, PROTO_TCP)).toBe(true);
        const fresh = child.network.bindingGeneration(port, PROTO_TCP);
        expect(fresh).not.toBe(old);
        expect(child.network.send(port, h.remote, 9000, encodeTcpFrame(SYN, 102, 0, 65536), PROTO_TCP)).toBe(true);
        await until(() => h.broker.clients.get(child.lease.boot.slot)?.pending.length === 5, "DATA/FIN/release/rebind queued");
        expect(h.sent).toEqual([]);
        expect(departures).toEqual([]);
        h.drain();
        expect(h.sent).toEqual([
            { kind: "frame", tcpKind: SYN, id: 101, generation: old, data: [] },
            { kind: "frame", tcpKind: DATA, id: 101, generation: old, data: [4, 5, 6] },
            { kind: "frame", tcpKind: FIN, id: 101, generation: old, data: [] },
            { kind: "release", port, proto: PROTO_TCP, generation: old },
            { kind: "frame", tcpKind: SYN, id: 102, generation: fresh, data: [] },
        ]);
        expect([...h.broker.tcp.values()].some(flow => flow.id === 102)).toBe(true);
        expect(errors).toEqual([]);
        expect(departures).toEqual([]);
    } finally { await h.close(); }
}, 10000);

test("a reuse owner leaving preserves the shared binding and the other owner's local TCP flow", async () => {
    const h = fixture(), a = h.child(81003), b = h.child(81004), port = 7201, sourcePort = 7301;
    const atA: LanDatagram[] = [], atB: LanDatagram[] = [];
    const endpointA = { deliver: (packet: LanDatagram) => atA.push(packet) };
    const endpointB = { deliver: (packet: LanDatagram) => atB.push(packet) };
    const departures: number[] = [], errors: LanSocketError[] = [];
    h.network.onPortDisconnect(event => departures.push(event.port));
    h.network.onSocketError(error => errors.push(error));
    try {
        expect(a.network.bind(port, endpointA, PROTO_TCP, true)).toBe(true);
        expect(b.network.bind(port, endpointB, PROTO_TCP, true)).toBe(true);
        const generation = a.network.bindingGeneration(port, PROTO_TCP);
        expect(b.network.bindingGeneration(port, PROTO_TCP)).toBe(generation);
        expect(h.network.bind(sourcePort, { deliver() {} }, PROTO_TCP)).toBe(true);
        expect(h.network.send(sourcePort, h.network.node, port, encodeTcpFrame(SYN, 201, 0, 65536), PROTO_TCP)).toBe(true);
        await until(() => atA.length === 1 && atB.length === 1, "both reusable endpoints receive");
        a.network.unbind(port, endpointA, PROTO_TCP);
        await a.namespace.barrier();
        expect(h.sent).toEqual([]);
        expect(departures).toEqual([]);
        expect(errors).toEqual([]);
        expect([...h.broker.tcp.values()].some(flow => flow.id === 201)).toBe(true);
        expect(h.network.send(sourcePort, h.network.node, port, encodeTcpFrame(DATA, 201, 801, 0, Uint8Array.of(7)), PROTO_TCP)).toBe(true);
        await until(() => atB.length === 2, "remaining owner receives");
        expect(atA).toHaveLength(1);
        b.network.unbind(port, endpointB, PROTO_TCP);
        await b.namespace.barrier();
        expect(h.sent).toEqual([{ kind: "release", port, proto: PROTO_TCP, generation }]);
        expect(departures).toEqual([port]);
        expect(errors.map(error => [error.localPort, error.code, error.wireId])).toEqual([[sourcePort, 10054, 201]]);
    } finally { await h.close(); }
}, 10000);

test("relay loss discards queued remote frames while completing queued local port departure", async () => {
    const h = fixture(), child = h.child(81005), port = 7202, sourcePort = 7302;
    const endpoint = { deliver() {} }, departures: number[] = [], errors: LanSocketError[] = [];
    h.network.onPortDisconnect(event => departures.push(event.port));
    h.network.onSocketError(error => errors.push(error));
    try {
        await until(() => child.network.connected, "child connected state");
        expect(child.network.bind(port, endpoint, PROTO_TCP)).toBe(true);
        expect(h.network.bind(sourcePort, { deliver() {} }, PROTO_TCP)).toBe(true);
        h.network.send(sourcePort, h.network.node, port, encodeTcpFrame(SYN, 301, 0, 65536), PROTO_TCP);
        child.network.send(port, h.remote, 9000, encodeTcpFrame(SYN, 302, 0, 65536), PROTO_TCP);
        child.network.send(port, h.remote, 9000, encodeTcpFrame(FIN, 302, 902), PROTO_TCP);
        child.network.unbind(port, endpoint, PROTO_TCP);
        await until(() => h.broker.clients.get(child.lease.boot.slot)?.pending.length === 3, "pending release behind remote FIN");
        h.disconnect();
        expect(h.broker.clients.get(child.lease.boot.slot)?.pending).toEqual([]);
        expect(departures).toEqual([port]);
        expect(errors.map(error => error.wireId)).toEqual([301]);
        const meta = new Int32Array(child.lease.boot.shared, 16 * 4, child.lease.boot.capacity * 8);
        expect(meta[child.lease.boot.slot * 8 + 2]).toBe(0);
        expect(meta[child.lease.boot.slot * 8 + 3]).toBe(0);
        h.drain();
        expect(h.sent.some(item => item.kind === "frame")).toBe(false);
    } finally { await h.close(); }
}, 10000);

test("bounded pending releases are retained for cleanup when the client exceeds its queue", async () => {
    const h = fixture(), child = h.child(81006), endpoint = { deliver() {} };
    try {
        await until(() => child.network.connected, "child connected state");
        for (let index = 0; index < 512; index++) {
            const port = 8000 + index;
            expect(child.network.bind(port, endpoint, PROTO_TCP)).toBe(true);
            if (!index) expect(child.network.send(port, h.remote, 9000, encodeTcpFrame(SYN, 401, 0, 65536), PROTO_TCP)).toBe(true);
            child.network.unbind(port, endpoint, PROTO_TCP);
        }
        await until(() => !h.broker.clients.has(child.lease.boot.slot), "bounded queue closes the client");
        const releases = h.sent.filter((item): item is Extract<Sent, { kind: "release" }> => item.kind === "release");
        expect(releases).toHaveLength(512);
        expect(new Set(releases.map(item => item.port)).size).toBe(512);
        expect(releases.every(item => item.generation > 0)).toBe(true);
        expect(h.sent.some(item => item.kind === "frame" && item.tcpKind !== RST)).toBe(false);
    } finally { await h.close(); }
}, 10000);


function rawReceiver() {
    const packets: LanDatagram[] = [];
    return { packets, endpoint: { deliver: (packet: LanDatagram) => packets.push(packet) } };
}
function rawCapture(protocol = 1): Uint8Array {
    // dstPort fences the native protocol-255 owner; payload[0] is the actual IP protocol.
    return encodeDatagram(PROTO_RAW4, Uint8Array.of(2, 1, 203, 0, 113, 7), 256, protocol + 1, Uint8Array.of(protocol, 0, 41, 42));
}

test("RAW4 capture owner and actual/wildcard recipients in separate slots use one exact delivery per slot", async () => {
    const h = fixture(), owner = h.child(81101), recipient = h.child(81102), aliases = h.child(81103);
    const atOwner = rawReceiver(), actual = rawReceiver(), zero = rawReceiver(), shared = rawReceiver();
    const rootActual = rawReceiver(), rootUdp = rawReceiver();
    const snapshots: { port: number; generation: number }[][] = [];
    let aliasMessages = 0;
    const receive = recipient.network.receiveRawFrame.bind(recipient.network);
    recipient.network.receiveRawFrame = (frame, targets) => { snapshots.push(targets.map(item => ({ ...item }))); receive(frame, targets); };
    const receiveAliases = aliases.network.receiveRawFrame.bind(aliases.network);
    aliases.network.receiveRawFrame = (frame, targets) => { aliasMessages++; receiveAliases(frame, targets); };
    try {
        expect(owner.network.bind(256, atOwner.endpoint, PROTO_RAW4, true)).toBe(true);
        expect(recipient.network.bind(2, actual.endpoint, PROTO_RAW4, true)).toBe(true);
        expect(recipient.network.bind(1, zero.endpoint, PROTO_RAW4, true)).toBe(true);
        expect(aliases.network.bind(1, shared.endpoint, PROTO_RAW4, true)).toBe(true);
        expect(aliases.network.bind(256, shared.endpoint, PROTO_RAW4, true)).toBe(true);
        expect(h.network.bind(2, rootActual.endpoint, PROTO_RAW4, true)).toBe(true);
        expect(h.network.bind(18, rootUdp.endpoint, PROTO_RAW4)).toBe(true);
        const generation = owner.network.bindingGeneration(256, PROTO_RAW4);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, generation);
        await Promise.all([owner.namespace.barrier(), recipient.namespace.barrier(), aliases.namespace.barrier()]);
        expect(atOwner.packets).toHaveLength(1);
        expect(actual.packets).toHaveLength(1);
        expect(zero.packets).toHaveLength(1);
        expect(shared.packets).toHaveLength(1);
        expect(rootActual.packets).toHaveLength(1);
        expect(rootUdp.packets).toHaveLength(0);
        expect(snapshots).toEqual([[
            { port: 2, generation: recipient.network.deliveryGeneration(2, PROTO_RAW4) },
            { port: 1, generation: recipient.network.deliveryGeneration(1, PROTO_RAW4) },
        ]]);
        expect(recipient.network.bindingGeneration(256, PROTO_RAW4)).toBe(0);
        expect(aliasMessages).toBe(1);
        // Identical datagrams are legitimate independent IP packets, not a deduplication key.
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(17), false, generation);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(17), false, generation);
        await Promise.all([owner.namespace.barrier(), recipient.namespace.barrier(), aliases.namespace.barrier()]);
        expect(actual.packets).toHaveLength(1);
        expect(rootActual.packets).toHaveLength(1);
        expect(rootUdp.packets).toHaveLength(2);
        expect(zero.packets).toHaveLength(3);
        expect(shared.packets).toHaveLength(3);
        expect(snapshots).toHaveLength(3);
        expect(aliasMessages).toBe(3);
    } finally { await h.close(); }
}, 10000);

test("a RAW owner tombstone or old incarnation cannot publish to still-live sibling recipients", async () => {
    const h = fixture(), owner = h.child(81104), recipient = h.child(81105);
    const oldOwner = rawReceiver(), freshOwner = rawReceiver(), actual = rawReceiver(), zero = rawReceiver();
    try {
        owner.network.bind(256, oldOwner.endpoint, PROTO_RAW4);
        recipient.network.bind(2, actual.endpoint, PROTO_RAW4);
        recipient.network.bind(1, zero.endpoint, PROTO_RAW4);
        const old = owner.network.bindingGeneration(256, PROTO_RAW4);
        owner.network.unbind(256, oldOwner.endpoint, PROTO_RAW4);
        // The shared generation cell still contains old; owner liveness must also be checked.
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, old);
        await recipient.namespace.barrier();
        expect(actual.packets).toHaveLength(0);
        expect(zero.packets).toHaveLength(0);
        owner.network.bind(256, freshOwner.endpoint, PROTO_RAW4);
        const fresh = owner.network.bindingGeneration(256, PROTO_RAW4);
        expect(fresh).not.toBe(old);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, old);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, fresh);
        await Promise.all([owner.namespace.barrier(), recipient.namespace.barrier()]);
        expect(actual.packets).toHaveLength(1);
        expect(zero.packets).toHaveLength(1);
        expect(oldOwner.packets).toHaveLength(0);
        expect(freshOwner.packets).toHaveLength(1);
    } finally { await h.close(); }
}, 10000);

test("a queued RAW recipient snapshot cannot deliver to a rebound handle in another slot", async () => {
    const h = fixture(), owner = h.child(81106), recipient = h.child(81107);
    const ownerEndpoint = rawReceiver(), oldActual = rawReceiver(), freshActual = rawReceiver(), zero = rawReceiver();
    try {
        owner.network.bind(256, ownerEndpoint.endpoint, PROTO_RAW4);
        recipient.network.bind(2, oldActual.endpoint, PROTO_RAW4);
        recipient.network.bind(1, zero.endpoint, PROTO_RAW4);
        const ownerGeneration = owner.network.bindingGeneration(256, PROTO_RAW4);
        const old = recipient.network.bindingGeneration(2, PROTO_RAW4);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, ownerGeneration);
        recipient.network.unbind(2, oldActual.endpoint, PROTO_RAW4);
        recipient.network.bind(2, freshActual.endpoint, PROTO_RAW4);
        expect(recipient.network.bindingGeneration(2, PROTO_RAW4)).not.toBe(old);
        await recipient.namespace.barrier();
        expect(oldActual.packets).toHaveLength(0);
        expect(freshActual.packets).toHaveLength(0);
        expect(zero.packets).toHaveLength(1);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, ownerGeneration);
        await recipient.namespace.barrier();
        expect(freshActual.packets).toHaveLength(1);
        expect(zero.packets).toHaveLength(2);
    } finally { await h.close(); }
}, 10000);

test("closing the RAW owner after broker acceptance preserves already queued live recipients", async () => {
    const h = fixture(), owner = h.child(81108), recipient = h.child(81109);
    const ownerEndpoint = rawReceiver(), actual = rawReceiver();
    try {
        owner.network.bind(256, ownerEndpoint.endpoint, PROTO_RAW4);
        recipient.network.bind(2, actual.endpoint, PROTO_RAW4);
        const generation = owner.network.bindingGeneration(256, PROTO_RAW4);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, generation);
        owner.network.unbind(256, ownerEndpoint.endpoint, PROTO_RAW4);
        await recipient.namespace.barrier();
        expect(actual.packets).toHaveLength(1);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, generation);
        await recipient.namespace.barrier();
        expect(actual.packets).toHaveLength(1);
    } finally { await h.close(); }
}, 10000);

test("shared RAW capture ownership survives one reuse close and ends at the last owner", async () => {
    const h = fixture(), first = h.child(81110), second = h.child(81111), recipient = h.child(81112);
    const a = rawReceiver(), b = rawReceiver(), actual = rawReceiver();
    try {
        first.network.bind(256, a.endpoint, PROTO_RAW4, true);
        second.network.bind(256, b.endpoint, PROTO_RAW4, true);
        recipient.network.bind(2, actual.endpoint, PROTO_RAW4);
        const generation = first.network.bindingGeneration(256, PROTO_RAW4);
        expect(second.network.bindingGeneration(256, PROTO_RAW4)).toBe(generation);
        first.network.unbind(256, a.endpoint, PROTO_RAW4);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, generation);
        await Promise.all([first.namespace.barrier(), second.namespace.barrier(), recipient.namespace.barrier()]);
        expect(a.packets).toHaveLength(0);
        expect(b.packets).toHaveLength(1);
        expect(actual.packets).toHaveLength(1);
        second.network.unbind(256, b.endpoint, PROTO_RAW4);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, generation);
        await recipient.namespace.barrier();
        expect(actual.packets).toHaveLength(1);
    } finally { await h.close(); }
}, 10000);


test("a RAW owner changing while recipient targets are collected invalidates the whole capture", async () => {
    const h = fixture(), owner = h.child(81113), recipient = h.child(81114);
    const oldOwner = rawReceiver(), freshOwner = rawReceiver(), actual = rawReceiver();
    const ports = (h.host as unknown as { ports: { targets(proto: number, port: number): number[] } }).ports;
    const original = ports.targets.bind(ports);
    let raced = false;
    try {
        owner.network.bind(256, oldOwner.endpoint, PROTO_RAW4);
        recipient.network.bind(2, actual.endpoint, PROTO_RAW4);
        const old = owner.network.bindingGeneration(256, PROTO_RAW4);
        ports.targets = (proto, port) => {
            if (!raced && proto === PROTO_RAW4 && port === 2) {
                raced = true;
                owner.network.unbind(256, oldOwner.endpoint, PROTO_RAW4);
                owner.network.bind(256, freshOwner.endpoint, PROTO_RAW4);
            }
            return original(proto, port);
        };
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, old);
        await Promise.all([owner.namespace.barrier(), recipient.namespace.barrier()]);
        expect(raced).toBe(true);
        expect(owner.network.bindingGeneration(256, PROTO_RAW4)).not.toBe(old);
        expect(actual.packets).toHaveLength(0);
        expect(freshOwner.packets).toHaveLength(0);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, owner.network.bindingGeneration(256, PROTO_RAW4));
        await Promise.all([owner.namespace.barrier(), recipient.namespace.barrier()]);
        expect(actual.packets).toHaveLength(1);
        expect(freshOwner.packets).toHaveLength(1);
    } finally { ports.targets = original; await h.close(); }
}, 10000);


test("a queued RAW recipient rebind is fenced while another reuse owner keeps the lease generation", async () => {
    const h = fixture(), owner = h.child(81115), recipient = h.child(81116), keeper = h.child(81117);
    const captureOwner = rawReceiver(), oldActual = rawReceiver(), freshActual = rawReceiver(), kept = rawReceiver();
    try {
        owner.network.bind(256, captureOwner.endpoint, PROTO_RAW4);
        recipient.network.bind(2, oldActual.endpoint, PROTO_RAW4, true);
        keeper.network.bind(2, kept.endpoint, PROTO_RAW4, true);
        const generation = recipient.network.bindingGeneration(2, PROTO_RAW4);
        const delivery = recipient.network.deliveryGeneration(2, PROTO_RAW4);
        await h.admit();
        h.broker.backplane.receiveFrame(rawCapture(), false, owner.network.bindingGeneration(256, PROTO_RAW4));
        recipient.network.unbind(2, oldActual.endpoint, PROTO_RAW4);
        recipient.network.bind(2, freshActual.endpoint, PROTO_RAW4, true);
        expect(recipient.network.bindingGeneration(2, PROTO_RAW4)).toBe(generation);
        expect(recipient.network.deliveryGeneration(2, PROTO_RAW4)).not.toBe(delivery);
        await Promise.all([recipient.namespace.barrier(), keeper.namespace.barrier()]);
        expect(oldActual.packets).toHaveLength(0);
        expect(freshActual.packets).toHaveLength(0);
        expect(kept.packets).toHaveLength(1);
    } finally { await h.close(); }
}, 10000);

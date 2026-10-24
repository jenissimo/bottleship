import {expect, test} from "bun:test";
import {LanNetwork, type LanDatagram, type LanSocketError} from "../../src/worker/net/lan-network";
import {RootNetworkNamespace, ChildProcessNetworkNamespace} from "../../src/worker/core/network-namespace";
import {type LocalUdpContext} from "../../src/worker/net/local-udp-context";
import {PROTO_UDP} from "../../src/worker/net/netplay-wire";

const source = 62150, target = 62151;
const sink = {deliver(_packet: LanDatagram) {}};
function context(): LocalUdpContext {
    return {source: {family: 2, address: Uint8Array.of(127, 0, 0, 1), port: source},
        destination: {family: 2, address: Uint8Array.of(127, 0, 0, 1), port: target}};
}
function counters(shared: SharedArrayBuffer, slot: number, inbound: boolean) {
    const words = new Int32Array(shared), at = 16 + slot * 8 + (inbound ? 4 : 2);
    return [Atomics.load(words, at), Atomics.load(words, at + 1)];
}
function holdFrames(port: MessagePort) {
    const receive = port.onmessage!, frames: MessageEvent[] = [];
    port.onmessage = event => {
        if (event.data?.type === "frame" && event.data.localUdp !== undefined) frames.push(event);
        else receive.call(port, event);
    };
    return {
        frames,
        replay() { for (const event of frames.splice(0)) receive.call(port, event); },
        restore() { port.onmessage = receive; for (const event of frames.splice(0)) receive.call(port, event); },
    };
}

test("successful child bind admits immediate root local UDP before queued claim metadata is handled", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62961);
    const lease = root.createChild(62962), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const packets: LanDatagram[] = [];
    try {
        expect(network.bind(source, sink, PROTO_UDP)).toBe(true);
        await namespace.barrier();
        // No await between successful bind and send: MessagePort claim delivery
        // cannot be a prerequisite for an already-published local binding.
        expect(child.bind(target, {deliver: packet => packets.push(packet)}, PROTO_UDP)).toBe(true);
        expect(network.send(source, network.node, target, Uint8Array.of(4, 2), PROTO_UDP, undefined, context())).toBe(true);
        await namespace.barrier();
        expect(packets.map(packet => packet.data)).toEqual([Uint8Array.of(4, 2)]);
        expect(packets[0].localUdp).toEqual(context());
        expect(counters(lease.boot.shared, lease.boot.slot, true)).toEqual([0, 0]);
    } finally { namespace.close(); lease.close(); await root.close(); }
}, 10000);

test("namespace accepted local UDP survives sender close and owns its original address/data", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62901);
    const lease = root.createChild(62902), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const packets: LanDatagram[] = [];
    try {
        network.bind(target, {deliver: packet => packets.push(packet)}, PROTO_UDP);
        child.bind(source, sink, PROTO_UDP);
        await namespace.barrier();
        const localUdp = context(), bytes = Uint8Array.of(7);
        expect(child.send(source, child.node, target, bytes, PROTO_UDP, undefined, localUdp)).toBe(true);
        localUdp.source.address.fill(9); bytes.fill(9);
        child.unbind(source, sink, PROTO_UDP);
        await namespace.barrier();
        expect(packets).toHaveLength(1);
        expect(packets[0].localUdp).toEqual(context());
        expect(packets[0].data).toEqual(Uint8Array.of(7));
        expect(counters(lease.boot.shared, lease.boot.slot, false)).toEqual([0, 0]);
    } finally { namespace.close(); lease.close(); await root.close(); }
}, 10000);

test("queued recipient close/rebind under an unchanged shared lease rejects old DATA and releases its full cost", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62911);
    const lease = root.createChild(62912), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const oldPackets: LanDatagram[] = [], newPackets: LanDatagram[] = [];
    const oldEndpoint = {deliver: (packet: LanDatagram) => oldPackets.push(packet)};
    const replacement = {deliver: (packet: LanDatagram) => newPackets.push(packet)};
    const hold = holdFrames(lease.boot.port);
    try {
        network.bind(source, sink, PROTO_UDP);
        network.bind(target, sink, PROTO_UDP, true);
        child.bind(target, oldEndpoint, PROTO_UDP, true);
        await namespace.barrier();
        const binding = child.bindingGeneration(target, PROTO_UDP), delivery = child.deliveryGeneration(target, PROTO_UDP);
        expect(network.send(source, network.node, target, Uint8Array.of(1, 2, 3), PROTO_UDP, undefined, context())).toBe(true);
        await namespace.barrier();
        expect(hold.frames).toHaveLength(1);
        expect(counters(lease.boot.shared, lease.boot.slot, true)).toEqual([12 + 3 + 64, 1]);
        child.unbind(target, oldEndpoint, PROTO_UDP);
        expect(child.bind(target, replacement, PROTO_UDP, true)).toBe(true);
        expect(child.bindingGeneration(target, PROTO_UDP)).toBe(binding);
        expect(child.deliveryGeneration(target, PROTO_UDP)).not.toBe(delivery);
        hold.replay();
        expect(oldPackets).toHaveLength(0); expect(newPackets).toHaveLength(0);
        expect(counters(lease.boot.shared, lease.boot.slot, true)).toEqual([0, 0]);
        await namespace.barrier();
        network.send(source, network.node, target, Uint8Array.of(9), PROTO_UDP, undefined, context());
        await namespace.barrier(); hold.replay();
        expect(newPackets.map(packet => packet.data)).toEqual([Uint8Array.of(9)]);
        expect(newPackets[0].localUdp).toEqual(context());
        expect(counters(lease.boot.shared, lease.boot.slot, true)).toEqual([0, 0]);
    } finally { hold.restore(); namespace.close(); lease.close(); await root.close(); }
}, 10000);

test("queued DATA cannot cross a process incarnation even if recipient delivery generation is unchanged", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62921);
    const lease = root.createChild(62922), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const packets: LanDatagram[] = [], hold = holdFrames(lease.boot.port);
    try {
        network.bind(source, sink, PROTO_UDP);
        child.bind(target, {deliver: packet => packets.push(packet)}, PROTO_UDP);
        await namespace.barrier();
        const delivery = child.deliveryGeneration(target, PROTO_UDP);
        network.send(source, network.node, target, Uint8Array.of(1), PROTO_UDP, undefined, context());
        await namespace.barrier(); expect(hold.frames).toHaveLength(1);
        const oldEpoch = hold.frames[0].data.recipientProcessEpoch;
        await namespace.finishProcessLifetime(); namespace.beginProcessLifetime(); await namespace.barrier();
        expect(child.deliveryGeneration(target, PROTO_UDP)).toBe(delivery);
        expect(Atomics.load(new Int32Array(lease.boot.shared), 16 + lease.boot.slot * 8 + 7)).not.toBe(oldEpoch);
        hold.replay(); expect(packets).toHaveLength(0);
        expect(counters(lease.boot.shared, lease.boot.slot, true)).toEqual([0, 0]);
        network.send(source, network.node, target, Uint8Array.of(2), PROTO_UDP, undefined, context());
        await namespace.barrier(); hold.replay();
        expect(packets.map(packet => packet.data)).toEqual([Uint8Array.of(2)]);
    } finally { hold.restore(); namespace.close(); lease.close(); await root.close(); }
}, 10000);

test("old reset context cannot reach a rebound shared-port sender, while fresh reset retains its tuple", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62931);
    const lease = root.createChild(62932), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const errors: LanSocketError[] = [];
    try {
        network.bind(source, sink, PROTO_UDP, true);
        child.bind(source, sink, PROTO_UDP, true);
        child.onSocketError(error => errors.push(error)); await namespace.barrier();
        const binding = child.bindingGeneration(source, PROTO_UDP);
        child.send(source, child.node, target, Uint8Array.of(1), PROTO_UDP, undefined, context());
        child.unbind(source, sink, PROTO_UDP); child.bind(source, sink, PROTO_UDP, true);
        expect(child.bindingGeneration(source, PROTO_UDP)).toBe(binding);
        await namespace.barrier(); expect(errors).toHaveLength(0);
        child.send(source, child.node, target, Uint8Array.of(2), PROTO_UDP, undefined, context());
        await namespace.barrier();
        expect(errors).toHaveLength(1); expect(errors[0].localUdp).toEqual(context());
        expect(counters(lease.boot.shared, lease.boot.slot, false)).toEqual([0, 0]);
    } finally { namespace.close(); lease.close(); await root.close(); }
}, 10000);

test("zero-length tagged UDP occupies frame credits and drains exactly once", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62941);
    const lease = root.createChild(62942), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const packets: LanDatagram[] = [];
    try {
        network.bind(target, {deliver: packet => packets.push(packet)}, PROTO_UDP);
        child.bind(source, sink, PROTO_UDP); await namespace.barrier();
        for (let i = 0; i < 256; i++) expect(child.send(source, child.node, target, new Uint8Array(), PROTO_UDP, undefined, context())).toBe(true);
        expect(child.send(source, child.node, target, new Uint8Array(), PROTO_UDP, undefined, context())).toBe(false);
        expect(counters(lease.boot.shared, lease.boot.slot, false)).toEqual([256 * (12 + 64), 256]);
        await namespace.barrier();
        expect(packets).toHaveLength(256);
        expect(packets.every(packet => packet.data.length === 0 && packet.localUdp?.source.port === source)).toBe(true);
        expect(counters(lease.boot.shared, lease.boot.slot, false)).toEqual([0, 0]);
    } finally { namespace.close(); lease.close(); await root.close(); }
}, 10000);

test("context queue bytes prevent sixteen maximum UDP packets from bypassing the one-MiB admission bound", async () => {
    const network = new LanNetwork(), root = new RootNetworkNamespace(network, 8, 62951);
    const lease = root.createChild(62952), child = new LanNetwork(), namespace = new ChildProcessNetworkNamespace(child, lease.boot);
    const packets: LanDatagram[] = [];
    try {
        network.bind(target, {deliver: packet => packets.push(packet)}, PROTO_UDP);
        child.bind(source, sink, PROTO_UDP); await namespace.barrier();
        const bytes = new Uint8Array(65507); bytes[0] = 7; bytes[65506] = 9;
        for (let i = 0; i < 15; i++) expect(child.send(source, child.node, target, bytes, PROTO_UDP, undefined, context())).toBe(true);
        expect(child.send(source, child.node, target, bytes, PROTO_UDP, undefined, context())).toBe(false);
        expect(counters(lease.boot.shared, lease.boot.slot, false)).toEqual([15 * (12 + 65507 + 64), 15]);
        await namespace.barrier();
        expect(packets).toHaveLength(15);
        expect(packets.every(packet => packet.data.length === 65507 && packet.data[0] === 7 && packet.data[65506] === 9)).toBe(true);
        expect(counters(lease.boot.shared, lease.boot.slot, false)).toEqual([0, 0]);
        expect(child.send(source, child.node, target, bytes, PROTO_UDP, undefined, context())).toBe(true);
        await namespace.barrier(); expect(packets).toHaveLength(16);
    } finally { namespace.close(); lease.close(); await root.close(); }
}, 10000);

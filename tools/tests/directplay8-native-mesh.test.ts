import { afterEach, expect, test } from "bun:test";
import fixture from "./fixtures/directplay8-native-mesh.json";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { PROTO_UDP, decodeDatagram, encodeDatagram } from "../../src/worker/net/netplay-wire";
import { NativeDirectPlayCore } from "../../src/worker/modules/dpnet/native-wire/core";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { NativeDirectPlayChannel } from "../../src/worker/modules/dpnet/native-wire/channel";
import { NativeDirectPlayPort } from "../../src/worker/modules/dpnet/native-wire/port";
import { NativeReceiveWindow } from "../../src/worker/modules/dpnet/native-wire/receive-window";
import { DN, encodeNativeProtocolFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { DPN } from "../../src/worker/modules/dpnet/constants";
import { decodeNativeCoreConnectInfo } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const packet = (command: number, target: number) => Uint8Array.from(Buffer.from(fixture.messages.find(m => m.core === command && m.target === target)!.payload, "hex"));
const until = async (check: () => boolean) => { const end = Date.now() + 150; while (!check()) { if (Date.now() > end) throw Error("Native mesh test progress"); await Bun.sleep(1); } };
function scenario(options: { autoC4?: boolean; deferLease?: boolean; earlyC4?: boolean } = {}) {
    const [client, server] = [1, 2].map(n => new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, n)));
    const outgoing: { source: number; target: number; localPort: number }[] = [];
    for (const [i, network] of [client, server].entries()) network.attach({ send(frame) {
        const dg = decodeDatagram(frame)!, remote = i ? client : server;
        outgoing.push({ source: i, target: dg.dstPort, localPort: dg.srcPort });
        remote.receiveFrame(encodeDatagram(dg.proto, network.node, dg.dstPort, dg.srcPort, dg.payload)); return true;
    }, close() {} });
    cleanup.push(() => { client.attach(null); server.attach(null); });
    // Route the captured loopback endpoint to this test's simulated native adapter.
    client.routeIpv4 = () => server.node.slice();
    let resumeLease!: () => void, denyLease!: () => void, leaseWaiting = false, released = 0;
    if (options.deferLease) client.leaseUdpPeer = () => new Promise((resolve, reject) => {
        leaseWaiting = true; resumeLease = () => resolve({ release() { released++; } }); denyLease = () => reject(Error("denied"));
    });
    const snapshot = packet(0xc2, 2), info = decodeNativeCoreConnectInfo(snapshot)!;
    let peerNode = client.node.slice(), peerPort = 0, old: NativeDirectPlayChannel | undefined, c3 = 0;
    const received: Uint8Array[] = [], control: Uint8Array[] = [];
    function startOld(): void {
        if (old) return;
        old = new NativeDirectPlayChannel(server, { node: [...client.node], port: peerPort }, {
            timeout: 200, retryInterval: 2,
            onMessage(message) { if (!(message.command & DN.USER1)) { received.push(message.payload); void old!.link.sendReliable(message.payload, 0); } },
        }, fixture.ports[1]);
        cleanup.push(() => old?.close());
        void old.link.connect().then(hr => { if (!hr && options.autoC4 !== false) void old!.link.sendReliable(packet(0xc4, 2)); });
    }
    const host = new NativeReliableLink({ send(bytes) { return server.send(fixture.ports[0], peerNode, peerPort, bytes, PROTO_UDP); }, onMessage(message) {
        if (!(message.command & DN.USER1)) return;
        control.push(message.payload.slice());
        const command = new DataView(message.payload.buffer).getUint32(0, true);
        if (command === 0xc1) { void host.sendReliable(snapshot); if (options.earlyC4) startOld(); }
        if (command === 0xc3) { c3++; void host.sendReliable(packet(0xc6, 2)); startOld(); }
    } });
    expect(server.bind(fixture.ports[0], { deliver(dg) { peerNode = dg.srcNode.slice(); peerPort = dg.srcPort; host.receive(dg.data); } }, PROTO_UDP)).toBe(true);
    host.listen(); cleanup.push(() => host.close());
    const core = new NativeDirectPlayCore(client, "peer", 200, 2); cleanup.push(() => core.dispose());
    const connect = () => core.connect({ node: [...server.node], port: fixture.ports[0] },
        { instance: "0".repeat(32), application: info.application.application, flags: 0, maxPlayers: 0, name: "", password: "", user: [0, 0, 0, 0] },
        { name: { short: "peer2", long: "" }, data: [], flags: 0 }, new Uint8Array());
    return { core, client, server, outgoing, received, control, host, connect, resume: () => resumeLease(), deny: () => denyLease(),
        get leaseWaiting() { return leaseWaiting; }, get released() { return released; }, get c3() { return c3; }, get old() { return old; }, get peerPort() { return peerPort; } };
}
test("captured C2/C4 mesh joins through one UDP binding and exchanges directly with an existing native peer", async () => {
    const scene = scenario(); expect(await scene.connect()).toBe(0);
    expect([...scene.core.entities.keys()]).toEqual([fixture.ids[2], fixture.ids[0], fixture.ids[1]]);
    expect(scene.core.playerAddress(fixture.ids[1])).toEqual({ node: [...scene.server.node], port: fixture.ports[1] });
    expect(await scene.core.sendDpn(fixture.ids[1], 8, Uint8Array.of(4, 0, 7))).toBe(0);
    expect(scene.received).toEqual([Uint8Array.of(4, 0, 7)]); expect(scene.core.queue[0]).toMatchObject({ from: fixture.ids[1], data: Uint8Array.of(4, 0, 7) });
    expect(new Set(scene.outgoing.filter(d => d.source === 0).map(d => d.localPort))).toEqual(new Set([scene.core.localAddress.port]));
    expect(await scene.core.shutdown()).toBe(0); expect(scene.client.isBound(scene.peerPort, PROTO_UDP)).toBe(false);
});
test("host voice frames never enter the application queue with either USER1 classification", async () => {
    const scene=scenario();expect(await scene.connect()).toBe(0);
    for(const flags of [DN.USER2,DN.USER1|DN.USER2]){
        expect(await scene.host.sendReliable(Uint8Array.of(0x99,0),flags)).toBe(0);
        expect(scene.core.queue).toHaveLength(0);
    }
    expect(await scene.host.sendReliable(Uint8Array.of(4,0,7),0)).toBe(0);
    expect(scene.core.queue[0]).toMatchObject({from:fixture.ids[0],data:Uint8Array.of(4,0,7)});
});
test("graceful Close accepts an existing peer whose native end-stream has already drained", async () => {
    const scene = scenario(); expect(await scene.connect()).toBe(0);
    expect(await scene.old!.link.shutdown()).toBe(0); await scene.old!.closed;
    expect(await scene.core.shutdown()).toBe(0); expect(scene.client.isBound(scene.peerPort, PROTO_UDP)).toBe(false);
});
test("Connect waits for exact lease readiness before C3 and cannot accept a foreign tuple or another DPNID's C4", async () => {
    const scene = scenario({ deferLease: true, autoC4: false }); let finished = false;
    const pending = scene.connect().then(hr => { finished = true; return hr; }); await until(() => scene.leaseWaiting);
    expect(scene.c3).toBe(0); expect(finished).toBe(false); scene.resume();
    await until(() => scene.old?.link.state === "connected"); expect(scene.c3).toBe(1); expect(finished).toBe(false);
    const wrong = packet(0xc4, 2); new DataView(wrong.buffer).setUint32(4, fixture.ids[0], true);
    expect(await scene.old!.link.sendReliable(wrong)).toBe(0); expect(finished).toBe(false); expect(scene.core.entities.has(fixture.ids[1])).toBe(false);
    scene.client.receiveFrame(encodeDatagram(PROTO_UDP, scene.server.node, scene.peerPort, fixture.ports[1] + 4,
        encodeNativeProtocolFrame({ kind: "data", command: 0x7f, control: 0, sequence: 0, nextReceive: 0, masks: [], payload: packet(0xc4, 2) })));
    expect(finished).toBe(false);
    expect(await scene.old!.link.sendReliable(packet(0xc4, 2), DN.USER1 | DN.USER2)).toBe(0); expect(finished).toBe(false); expect(scene.core.entities.has(fixture.ids[1])).toBe(false);
    expect(await scene.old!.link.sendReliable(packet(0xc4, 2))).toBe(0); expect(await pending).toBe(0);
    expect(await scene.core.shutdown()).toBe(0); expect(scene.released).toBe(1);
});
test.each([true, false])("an early C4 cannot publish a peer before the lease ACK (accepted=%s)", async accepted => {
    const scene = scenario({ earlyC4: true, deferLease: true }), pending = scene.connect();
    await until(() => scene.old?.link.state === "connected"); await Promise.resolve(); await Promise.resolve();
    expect(scene.core.entities.has(fixture.ids[1])).toBe(false); expect(scene.c3).toBe(0);
    if (accepted) { scene.resume(); expect(await pending).toBe(0); expect(scene.core.entities.has(fixture.ids[1])).toBe(true); }
    else { scene.deny(); expect(await pending).toBe(DPN.INVALIDHOSTADDRESS); expect(scene.core.entities.size).toBe(0); }
});
test("Close cancels an instructed C6 whose peer lease is still pending, without a handshake timeout", async () => {
    const scene=scenario();expect(await scene.connect()).toBe(0);
    let accept!:()=>void,released=0;
    scene.client.leaseUdpPeer=()=>new Promise(resolve=>{accept=()=>resolve({release(){released++;}});});
    const entry=packet(0xd0,1),instruct=packet(0xc6,1),id=0x76543210;
    new DataView(entry.buffer).setUint32(4,id,true);new DataView(entry.buffer).setUint32(16,7,true);
    new DataView(instruct.buffer).setUint32(4,id,true);new DataView(instruct.buffer).setUint32(8,8,true);
    expect(await scene.host.sendReliable(entry)).toBe(0);expect(await scene.host.sendReliable(instruct)).toBe(0);
    expect(typeof accept).toBe("function");
    const closed=scene.core.shutdown();
    expect(await Promise.race([closed,Bun.sleep(30).then(()=>"deadline")])).toBe(0);
    expect(scene.client.isBound(scene.peerPort,PROTO_UDP)).toBe(false);
    accept();await Promise.resolve();await Promise.resolve();await Promise.resolve();expect(released).toBe(1);
});
test("an established native peer loss removes availability and requests a host integrity check once", async () => {
    const scene = scenario(); expect(await scene.connect()).toBe(0);
    scene.old!.close(DPN.CONNECTIONLOST);
    // The local link learns the loss from its own finite keepalive/transport path.
    const mesh = (scene.core as any).mesh, channel = mesh.channel(fixture.ids[1]);
    channel.close(DPN.CONNECTIONLOST);
    expect(scene.core.entities.has(fixture.ids[1])).toBe(false);
    const integrity = scene.control.filter(bytes => new DataView(bytes.buffer).getUint32(0,true)===0xe2);
    expect(integrity).toHaveLength(1);expect(integrity[0].length).toBe(12);
    expect(new DataView(integrity[0].buffer).getUint32(8,true)).toBe(fixture.ids[1]);
    channel.close(DPN.CONNECTIONLOST);expect(scene.control.filter(bytes => new DataView(bytes.buffer).getUint32(0,true)===0xe2)).toHaveLength(1);
    expect(await scene.core.sendDpn(fixture.ids[1],8,Uint8Array.of(1))).toBe(DPN.INVALIDPLAYER);
});
test("Close during a pending peer lease releases a late ACK and cannot revive the retired binding", async () => {
    const scene = scenario({ deferLease: true }), pending = scene.connect(); await until(() => scene.leaseWaiting);
    const port = scene.core.localAddress.port; expect(scene.core.close()).toBe(0); expect(await pending).toBe(DPN.USERCANCEL);
    const endpoint = { deliver() {} }; expect(scene.client.bind(port, endpoint, PROTO_UDP)).toBe(true);
    scene.resume(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scene.released).toBe(1); expect(scene.c3).toBe(0); expect(scene.core.entities.size).toBe(0);
    expect(scene.client.isBound(port, PROTO_UDP)).toBe(true); scene.client.unbind(port, endpoint, PROTO_UDP);
});
test("a failed native peer lease fails Connect and releases its original UDP port", async () => {
    const scene = scenario({ deferLease: true }), pending = scene.connect(); await until(() => scene.leaseWaiting);
    const port = scene.core.localAddress.port; scene.deny(); expect(await pending).toBe(DPN.INVALIDHOSTADDRESS);
    expect(scene.c3).toBe(0); expect(scene.client.isBound(port, PROTO_UDP)).toBe(false);
});
test("zero-byte fragments across peers have a finite aggregate object budget", () => {
    const network = new LanNetwork(); network.attach({send(){return true;},close(){}});
    const port = new NativeDirectPlayPort(network,2302);cleanup.push(()=>{port.close();network.attach(null);});
    const a = new NativeReceiveWindow(0,1024*1024,4*1024*1024,65536,port.receiveBudget);
    const b = new NativeReceiveWindow(0,1024*1024,4*1024*1024,65536,port.receiveBudget);
    for(let i=0;i<65536;i++)expect(a.receive({kind:"data",command:i?DN.RELIABLE:DN.RELIABLE|DN.NEW_MESSAGE,control:0,sequence:i&255,nextReceive:0,masks:[],payload:new Uint8Array()}).accepted).toBe(true);
    expect(port.pendingBytes).toBe(0);
    expect(b.receive({kind:"data",command:DN.RELIABLE|DN.NEW_MESSAGE,control:0,sequence:0,nextReceive:0,masks:[],payload:new Uint8Array()}).overflow).toBe(true);
    expect(port.pendingFragments).toBe(65536);
    a.reset();b.reset();expect(port.pendingFragments).toBe(0);
    expect(b.receive({kind:"data",command:DN.RELIABLE|DN.NEW_MESSAGE,control:0,sequence:0,nextReceive:0,masks:[],payload:new Uint8Array()}).accepted).toBe(true);
    b.reset();expect(port.pendingFragments).toBe(0);
});
test("one native UDP port has finite peer admission and aggregate send/reassembly ownership", () => {
    const network = new LanNetwork(); network.attach({ send() { return true; }, close() {} });
    const port = new NativeDirectPlayPort(network, 2302, 2); cleanup.push(() => { port.close(); network.attach(null); });
    const endpoint = { deliver() {}, close() {} }, address = { node: [2, 0, 0, 0, 0, 2], port: 9 };
    expect(port.attach(address, endpoint)).toBe(true); expect(port.attach(address, endpoint)).toBe(false);
    expect(port.attach({ ...address, port: 10 }, endpoint)).toBe(true); expect(port.attach({ ...address, port: 11 }, endpoint)).toBe(false);
    const a = new NativeReceiveWindow(0, 1024 * 1024, 4 * 1024 * 1024, 65536, port.receiveBudget);
    const b = new NativeReceiveWindow(0, 1024 * 1024, 4 * 1024 * 1024, 65536, port.receiveBudget);
    for (let i = 1; i <= 4; i++) expect(a.receive({ kind: "data", command: 0x17, control: 0, sequence: i, nextReceive: 0, masks: [], payload: new Uint8Array(1024 * 1024) }).accepted).toBe(true);
    expect(b.receive({ kind: "data", command: 0x17, control: 0, sequence: 1, nextReceive: 0, masks: [], payload: Uint8Array.of(1) }).overflow).toBe(true);
    a.reset(); b.reset(); expect(port.pendingBytes).toBe(0);
    expect(port.sendBudget.reserve(4 * 1024 * 1024)).toBe(true); expect(port.sendBudget.reserve(1)).toBe(false);
    port.sendBudget.release(4 * 1024 * 1024); expect(port.pendingBytes).toBe(0);
    for (let i = 0; i < 320; i++) expect(port.sendBudget.reserve(0)).toBe(true);
    expect(port.sendBudget.reserve(0)).toBe(false); for (let i = 0; i < 320; i++) port.sendBudget.release(0);
    expect(port.pendingBytes).toBe(0);
});

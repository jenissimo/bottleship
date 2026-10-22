import { expect, test } from "bun:test";
import { NativeReliableLink } from "../../src/worker/modules/dpnet/native-wire/reliable-link";
import { decodeNativeProtocolFrame, encodeNativeProtocolFrame, DN, type NativeAckFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { DPN } from "../../src/worker/modules/dpnet/constants";
function circuit(options: { fragmentSize?: number; maxMessage?: number; maxBuffered?: number; version?: number } = {}) {
    let now = 0;
    const wire: { from: number; packet: Uint8Array }[] = [], messages: Uint8Array[][] = [[], []], states: string[][] = [[], []];
    let reject = -1, drop: (from: number, bytes: Uint8Array) => boolean = () => false;
    const links = [0, 1].map(from => new NativeReliableLink({ ...options, sessionId: 0x12345678 + from, now: () => now, retryInterval: 10, timeout: 500,
        send(packet) { if (reject === from) return false; if (!drop(from, packet)) wire.push({ from, packet: packet.slice() }); return true; },
        onMessage(message) { messages[from].push(message.payload); }, onState(state) { states[from].push(state); } }));
    const flush = () => { let count = 0; while (wire.length) { if (++count > 50000) throw Error("Protocol failed to quiesce"); const p = wire.shift()!; links[1 - p.from].receive(p.packet); } };
    return { links, messages, states, wire, flush, drop: (fn: typeof drop) => { drop = fn; }, reject: (from: number) => { reject = from; },
        advance(ms: number) { now += ms; for (const link of links) link.tick(); },
        async connect() { links[1].listen(); links[0].connect(); flush(); expect(await links[0].ready).toBe(0); expect(await links[1].ready).toBe(0); } };
}
test("DNET peers establish a correlated three-way native handshake and acknowledge reliable data", async () => {
    const c = circuit(); await c.connect();
    expect(c.links.map(l => l.state)).toEqual(["connected", "connected"]); expect(c.states).toEqual([["connected"], ["connected"]]);
    const source = Uint8Array.of(1, 0, 9), sent = c.links[0].sendReliable(source); source.fill(255); c.flush();
    expect(await sent).toBe(DPN.OK); expect([...c.messages[1][0]]).toEqual([1, 0, 9]); expect(c.links[0].pendingBytes).toBe(0); expect(c.links[0].pendingFrames).toBe(0);
    for (const link of c.links) link.close();
});
test("a dropped CONNECT response retries, duplicate CONNECTED converges and stale session/version/correlation is rejected", async () => {
    const c = circuit(); let dropped = false;
    c.drop((from, bytes) => { if (from === 1 && !dropped) { dropped = true; return true; } return false; });
    c.links[1].listen(); c.links[0].connect(); c.flush(); expect(c.links[0].state).toBe("connecting");
    const fake = { kind: "control" as const, command: 0x88, opcode: 2 as const, messageId: 0, responseId: 0,
        version: 0x10006, sessionId: 0x12345678, timestamp: 0, extra: new Uint8Array() };
    for (const patch of [{ version: 0x20006 }, { sessionId: 99 }, { responseId: 12 }]) c.links[0].receive(encodeNativeProtocolFrame({ ...fake, ...patch }));
    expect(c.links[0].state).toBe("connecting");
    c.advance(10); c.flush(); expect(await c.links[0].ready).toBe(0); expect(await c.links[1].ready).toBe(0);
    c.links[0].receive(encodeNativeProtocolFrame(fake)); c.flush(); expect(c.states[0]).toEqual(["connected"]);
    for (const link of c.links) link.close();
});
test("selective ACK and retransmission repair a lost fragment while ordered messages never duplicate", async () => {
    const c = circuit({ fragmentSize: 64 }); await c.connect(); let dropped = false;
    c.drop((from, bytes) => { const p = decodeNativeProtocolFrame(bytes); if (from === 0 && p?.kind === "data" && p.sequence === 1 && !dropped) { dropped = true; return true; } return false; });
    const input = Uint8Array.from({ length: 257 }, (_, i) => i & 255), sent = c.links[0].sendReliable(input);
    c.flush(); expect(c.messages[1]).toEqual([]); expect(c.links[0].pendingFrames).toBe(1);
    c.advance(10); c.flush(); expect(await sent).toBe(0); expect(c.messages[1]).toEqual([input]); expect(c.links[0].pendingFrames).toBe(0);
    c.advance(100); c.flush(); expect(c.messages[1].length).toBe(1);
    for (const link of c.links) link.close();
});
test("fragment windows stay at 63 frames and pass repeated sequence wraps without losing a byte", async () => {
    const c = circuit({ fragmentSize: 64 }); await c.connect();
    const data = Uint8Array.from({ length: 64 * 600 + 17 }, (_, i) => (i * 17) & 255), sent = c.links[0].sendReliable(data);
    expect(c.links[0].pendingFrames).toBe(63); c.flush(); expect(await sent).toBe(0); expect(c.messages[1]).toEqual([data]);
    expect(c.links[0].pendingMessages).toBe(0); expect(c.links[0].pendingBytes).toBe(0); expect(c.links[1].receiver.nextReceive).toBe(601 & 255);
    for (const link of c.links) link.close();
});
test("ACKs beyond the sent range cannot complete a send; pending state has a finite byte and message budget", async () => {
    const c = circuit({ maxMessage: 64, maxBuffered: 128 }); await c.connect(); c.drop((from, packet) => from === 1 && decodeNativeProtocolFrame(packet)?.kind === "ack");
    const one = c.links[0].sendReliable(new Uint8Array(64)), two = c.links[0].sendReliable(new Uint8Array(64)); c.flush();
    expect(c.links[0].pendingMessages).toBe(2);
    const ack: NativeAckFrame = { kind: "ack", command: 0x80, flags: 1, retry: 0, nextSend: 0, nextReceive: 250, timestamp: 0, reserved: [0, 0], masks: [], extra: new Uint8Array() };
    c.links[0].receive(encodeNativeProtocolFrame(ack)); expect(c.links[0].pendingMessages).toBe(2);
    c.links[0].receive(encodeNativeProtocolFrame({ kind: "data", command: 0x3f, control: 0, sequence: 250, nextReceive: 2, masks: [], payload: new Uint8Array() }));
    expect(c.links[0].pendingMessages).toBe(2); // Old data cannot smuggle a fresh acknowledgment.
    expect(await c.links[0].sendReliable(Uint8Array.of(1))).toBe(DPN.TABLEFULL);
    expect(await c.links[0].sendReliable(new Uint8Array(65))).toBe(DPN.DATATOOLARGE);
    c.links[0].close(); expect(await one).toBe(DPN.USERCANCEL); expect(await two).toBe(DPN.USERCANCEL);
    expect(c.links[0].pendingBytes).toBe(0); c.links[1].close();
});
test("failed transport submission and exhausted retries settle every operation with a failure", async () => {
    const c = circuit(); await c.connect(); c.reject(0); expect(await c.links[0].sendReliable(Uint8Array.of(1))).toBe(DPN.NOCONNECTION); expect(c.links[0].state).toBe("closed"); c.links[1].close();
    let now = 0; const link = new NativeReliableLink({ send: () => true, now: () => now, retryInterval: 1, retries: 1, timeout: 100 });
    link.connect(); now = 1; link.tick(); now = 2; link.tick(); expect(await link.ready).toBe(DPN.TIMEDOUT); expect(link.state).toBe("closed");
    const c2 = circuit(); await c2.connect(); c2.drop(() => true); const pending = c2.links[0].sendReliable(Uint8Array.of(2)); c2.advance(501);
    expect(await pending).toBe(DPN.CONNECTIONLOST); for (const l of c2.links) l.close();
});
test("consumer pressure and thrown handlers fail explicitly without unwinding an incoming datagram", async () => {
    for (const throwing of [false, true]) {
        let left!: NativeReliableLink, right!: NativeReliableLink;
        left = new NativeReliableLink({ sessionId: 3, send: bytes => { right.receive(bytes); return true; } });
        right = new NativeReliableLink({ send: bytes => { left.receive(bytes); return true; }, onMessage() { if (throwing) throw Error("capacity"); return false; } });
        right.listen(); expect(await left.connect()).toBe(0);
        const pending = left.sendReliable(Uint8Array.of(1)); expect(right.state).toBe("closed"); left.close();
        expect(await pending).toBe(DPN.USERCANCEL);
    }
});

test("graceful end-stream waits for native ACK after queued data and rejects later sends", async () => {
    const c = circuit({ fragmentSize: 64 }); await c.connect();
    const data = Uint8Array.from({ length: 150 }, (_, i) => i), sent = c.links[0].sendReliable(data);
    const closed = c.links[0].shutdown(); expect(c.links[0].shutdown()).toBe(closed);
    expect(await c.links[0].sendReliable(Uint8Array.of(1))).toBe(DPN.ALREADYCLOSING);
    c.flush(); expect(await sent).toBe(0); expect(await closed).toBe(0);
    expect(c.messages[1]).toEqual([data]); expect(c.links[0].state).toBe("closed"); expect(c.links[1].state).toBe("closed");
});

test("own EOS ACK alone cannot close before peer EOS, and missing peer EOS has a finite lifetime", async () => {
    const c = circuit(); await c.connect(); let finished = false;
    c.drop((from, bytes) => { const frame = decodeNativeProtocolFrame(bytes); return from === 1 && frame?.kind === "data" && !!(frame.control & DN.END_STREAM); });
    const ended = c.links[0].shutdown(); void ended.then(() => { finished = true; }); c.flush(); await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false); expect(c.links[0].state).toBe("connected"); expect(c.links[0].pendingFrames).toBe(0);
    c.advance(501); c.flush(); expect(await ended).toBe(DPN.CONNECTIONLOST); for (const link of c.links) link.close();
});

test("lost peer EOS retries, both final directions are acknowledged and EOS never becomes an application message", async () => {
    const c = circuit(); await c.connect(); let dropped = false, finalAcks = 0;
    c.drop((from, bytes) => {
        const frame = decodeNativeProtocolFrame(bytes);
        if (from === 1 && frame?.kind === "data" && frame.control & DN.END_STREAM && !dropped) { dropped = true; return true; }
        if (from === 0 && frame?.kind === "ack") finalAcks++;
        return false;
    });
    const ended = c.links[0].shutdown(); c.flush(); await Promise.resolve(); expect(c.links[0].state).toBe("connected");
    c.advance(10); c.flush(); expect(await ended).toBe(DPN.OK); await Promise.resolve();
    expect(finalAcks).toBeGreaterThanOrEqual(3); expect(c.messages).toEqual([[], []]); expect(c.links.map(link => link.state)).toEqual(["closed", "closed"]);
});

test("unreliable loss is cancelled with native backward SEND masks and never blocks later reliable data", async () => {
    const c = circuit({ fragmentSize: 64 }); await c.connect(); let dropped = false; const sent: Uint8Array[] = [];
    c.drop((from, bytes) => { if (from === 0) sent.push(bytes.slice()); const frame = decodeNativeProtocolFrame(bytes); if (!dropped && from === 0 && frame?.kind === "data" && frame.sequence === 0) { dropped = true; return true; } return false; });
    expect(await c.links[0].sendUnreliable(Uint8Array.of(1, 2, 3))).toBe(0);
    const reliable = c.links[0].sendReliable(Uint8Array.of(4, 5, 6), 0); c.flush(); expect(c.messages[1]).toEqual([]);
    c.advance(10); c.flush(); expect(await reliable).toBe(0); expect(c.messages[1]).toEqual([Uint8Array.of(4, 5, 6)]);
    expect(sent.some(bytes => { const frame = decodeNativeProtocolFrame(bytes); return frame?.kind === "ack" && !!(frame.flags & 8); })).toBe(true);
    expect(sent.filter(bytes => { const frame = decodeNativeProtocolFrame(bytes); return frame?.kind === "data" && !(frame.command & DN.RELIABLE); }).length).toBe(1);
    for (const link of c.links) link.close();
});

test("unreliable fragment loss discards the incomplete message and shutdown drains sequence cancellation", async () => {
    const c = circuit({ fragmentSize: 64 }); await c.connect(); let dropped = false;
    c.drop((from, bytes) => { const frame = decodeNativeProtocolFrame(bytes); if (!dropped && from === 0 && frame?.kind === "data" && frame.sequence === 1) { dropped = true; return true; } return false; });
    expect(await c.links[0].sendUnreliable(new Uint8Array(150))).toBe(0); c.flush(); expect(c.messages[1]).toEqual([]);
    const ended = c.links[0].shutdown(); c.flush(); c.advance(10); c.flush(); expect(await ended).toBe(0); expect(c.messages[1]).toEqual([]);
});

test("a selectively ACKed end-stream cannot report success for an earlier lost reliable frame", async () => {
    const c = circuit({ fragmentSize: 64 }); await c.connect(); let dropped = false, finished = false;
    c.drop((from, bytes) => { const frame = decodeNativeProtocolFrame(bytes); if (!dropped && from === 0 && frame?.kind === "data" && frame.sequence === 0) { dropped = true; return true; } return false; });
    const data = Uint8Array.from({ length: 150 }, (_, i) => i), sent = c.links[0].sendReliable(data), closed = c.links[0].shutdown();
    void closed.then(() => { finished = true; }); c.flush(); await Promise.resolve();
    expect(finished).toBe(false); expect(c.links[0].state).toBe("connected"); expect(c.messages[1]).toEqual([]);
    c.advance(10); c.flush(); expect(await sent).toBe(0); expect(await closed).toBe(0); expect(c.messages[1][0]).toEqual(data);
});

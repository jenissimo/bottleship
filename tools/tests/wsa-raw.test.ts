import { afterEach, describe, expect, test } from "bun:test";
import { LanNetwork, type NetTransport } from "../../src/worker/net/lan-network";
import { decodeDatagram, encodeDatagram, PROTO_RAW4, PROTO_RAW6 } from "../../src/worker/net/netplay-wire";
import { WsaSocketTable, WsaFailure, WSA, ipv4Address, ipv6Address, FD_READ, FD_WRITE } from "../../src/worker/modules/wsa-network";
import { ipChecksum, ipv4RawPacket, parseRawIp } from "../../src/worker/modules/wsa-raw";
import { makeSocketExports, WsaStartupCount } from "../../src/worker/modules/wsa-stub-shared";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
const all: WsaSocketTable[] = [];
afterEach(() => { all.splice(0).forEach(table => table.reset()); });
function pair() {
    const na = new LanNetwork(new Uint8Array([2,0,0,1,1,1])), nb = new LanNetwork(new Uint8Array([2,0,0,1,1,2]));
    const frames: ReturnType<typeof decodeDatagram>[] = [];
    const link = (src: LanNetwork, dst: LanNetwork): NetTransport => ({
        send(frame) { const packet = decodeDatagram(frame)!; frames.push(packet);
            dst.receiveFrame(encodeDatagram(packet.proto, src.node, packet.dstPort, packet.srcPort, packet.payload)); return true; },
        close() {},
    });
    na.attach(link(na,nb)); nb.attach(link(nb,na));
    const a = new WsaSocketTable(na), b = new WsaSocketTable(nb); all.push(a,b);
    return { a,b,na,nb,frames };
}
function error(fn: () => unknown, code: number) {
    try { fn(); throw Error("expected failure"); } catch (e) { expect(e).toBeInstanceOf(WsaFailure); expect((e as WsaFailure).code).toBe(code); }
}
describe("Winsock RAW IP boundaries", () => {
    test("IPv4 checksum agrees with a fixed RFC header, including odd payload byte", () => {
        const header = Uint8Array.from([0x45,0,0,0x73,0,0,0x40,0,0x40,0x11,0xb8,0x61,0xc0,0xa8,0,1,0xc0,0xa8,0,0xc7]);
        expect(ipChecksum(header)).toBe(0); header[10]=header[11]=0; expect(ipChecksum(header)).toBe(0xb861);
        expect(ipChecksum(Uint8Array.of(1,2,3))).toBe(0xfbfd);
    });
    test("raw protocol bindings fan out independently of UDP ports, preserving a full IPv4 header", () => {
        const { a,b,na,nb,frames } = pair(), sender=a.socket(3,2,1), first=b.socket(3,2,1), second=b.socket(3,2,1), udp=b.socket(2);
        b.bind(first,ipv4Address(nb.ipv4,173)); b.bind(second,ipv4Address(nb.ipv4,999)); b.bind(udp,ipv4Address(nb.ipv4,2));
        a.configureEvents(sender,FD_WRITE); b.configureEvents(first,FD_READ);
        expect(a.enumEvents(sender).mask).toBe(FD_WRITE);
        const body=Uint8Array.of(8,0,0,0,1,2,3,4);
        expect(a.send(sender,body,ipv4Address(nb.ipv4,0))).toBe(8);
        expect(frames[0]!.proto).toBe(PROTO_RAW4); expect(frames[0]!.srcPort).toBe(2); expect(frames[0]!.dstPort).toBe(2);
        expect(a.get(sender).local!.port).toBe(0); expect(b.get(first).local!.port).toBe(0);
        const packet=b.receive(first,100), header=parseRawIp(packet.data,2)!;
        expect(packet.from.port).toBe(0); expect(packet.from.ip).toEqual(na.ipv4); expect(header.protocol).toBe(1);
        expect(header.source).toEqual(na.ipv4); expect(header.destination).toEqual(nb.ipv4);
        expect(ipChecksum(packet.data.subarray(0,20))).toBe(0); expect(packet.data.subarray(20)).toEqual(body);
        expect(b.receive(second,100).data.subarray(20)).toEqual(body); expect(b.readable(udp)).toBe(false);
        expect(b.enumEvents(first).mask).toBe(FD_READ);
        b.closesocket(first); a.send(sender,body,ipv4Address(nb.ipv4,0)); expect(b.receive(second,100).data.length).toBe(28);
    });
    test("raw wildcard protocols receive each matching IP packet once alongside specific protocol sockets", () => {
        const { a,b,nb }=pair(), sender=a.socket(3,2,1), any=b.socket(3,2,0), raw=b.socket(3,2,255), icmp=b.socket(3,2,1), other=b.socket(3,2,2);
        for(const socket of [any,raw,icmp,other])b.bind(socket,ipv4Address(nb.ipv4,0));
        a.send(sender,Uint8Array.of(8,0,1,2),ipv4Address(nb.ipv4,0));
        for(const socket of [any,raw,icmp]) { expect(b.receive(socket,100).data.subarray(20)).toEqual(Uint8Array.of(8,0,1,2));expect(b.readable(socket)).toBe(false); }
        expect(b.readable(other)).toBe(false);
        const wildcardSender=a.socket(3,2,0);a.send(wildcardSender,Uint8Array.of(7),ipv4Address(nb.ipv4,0));
        expect(b.receive(any,100).data[20]).toBe(7);expect(b.readable(any)).toBe(false);
        expect(b.receive(raw,100).data[20]).toBe(7);expect(b.readable(raw)).toBe(false);
    });
    test("HDRINCL distinguishes the socket protocol from the supplied packet protocol and validates lengths", () => {
        const { a,b,na,nb,frames }=pair(), sender=a.socket(3,2,255), receiver=b.socket(3,2,1);
        b.bind(receiver,ipv4Address(nb.ipv4,0)); a.get(sender).headerInclude=true;
        const supplied=ipv4RawPacket(Uint8Array.of(8,0,0,0),1,new Uint8Array(4),nb.ipv4,0,37,16);
        expect(a.send(sender,supplied,ipv4Address(nb.ipv4,0))).toBe(24);
        const frame=frames[0]!; expect(frame.srcPort).toBe(256); expect(frame.dstPort).toBe(2);
        expect(frame.payload[0]).toBe(1); expect(frame.payload[1]).toBe(1);
        const received=b.receive(receiver,100); expect(received.data[8]).toBe(37); expect(received.data[1]).toBe(16);
        expect(received.data.subarray(12,16)).toEqual(na.ipv4); expect(ipChecksum(received.data.subarray(0,20))).toBe(0);
        supplied[2]=1; error(()=>a.send(sender,supplied,ipv4Address(nb.ipv4,0)),WSA.EINVAL);
        error(()=>a.send(sender,new Uint8Array(65536),ipv4Address(nb.ipv4,0)),WSA.EMSGSIZE);
    });
    test("IPv6 raw receives payload without the base header, uses a distinct protocol namespace and zero sockaddr ports", () => {
        const { a,b,nb,frames }=pair(), sender=a.socket(3,23,58), receiver=b.socket(3,23,58), ipv4=b.socket(3,2,58);
        b.bind(receiver,ipv6Address(nb.ipv6,99)); b.bind(ipv4,ipv4Address(nb.ipv4,0));
        const payload=Uint8Array.of(128,0,1,2,3,4,5,6);
        a.connect(sender,ipv6Address(nb.ipv6,0)); expect(a.send(sender,payload)).toBe(8);
        expect(frames[0]!.proto).toBe(PROTO_RAW6); const first = b.receive(receiver,100).data; expect(first[0]).toBe(128); expect(first.subarray(4)).toEqual(payload.subarray(4)); expect(first[2] | first[3]).not.toBe(0); expect(b.readable(ipv4)).toBe(false);
        a.get(sender).headerInclude=true;
        const included=new Uint8Array(48); included[0]=0x60; included[5]=8; included[6]=58; included[7]=64;
        included.set(a.network.ipv6,8); included.set(nb.ipv6,24); included.set(payload,40);
        a.send(sender,included); const packet=b.receive(receiver,100);
        expect(packet.data).toEqual(payload); expect(packet.from.family).toBe(23); expect(packet.from.port).toBe(0);
    });
    test("raw errors are transient, PEEK and truncation preserve packet boundaries, and close releases its wire binding", () => {
        const { a,b,na,nb }=pair(), sender=a.socket(3,2,1), receiver=b.socket(3,2,1);
        b.connect(receiver,ipv4Address(na.ipv4,0));
        a.send(sender,Uint8Array.of(1,2,3),ipv4Address(nb.ipv4,0));
        expect(b.bytesAvailable(receiver)).toBe(23); expect(b.receive(receiver,2,2).data.length).toBe(2); expect(b.bytesAvailable(receiver)).toBe(23);
        expect(b.receive(receiver,3).truncated).toBe(true); expect(b.readable(receiver)).toBe(false);
        nb.notifySocketError({node:na.node,localPort:2,remotePort:2,proto:PROTO_RAW4,code:WSA.ECONNRESET});
        error(()=>b.receive(receiver,100),WSA.ECONNRESET); error(()=>b.receive(receiver,100),WSA.EWOULDBLOCK);
        b.closesocket(receiver); const replacement=b.socket(3,2,1); b.bind(replacement,ipv4Address(nb.ipv4,0));
        expect(b.get(replacement).local!.port).toBe(0);
    });
    test("RAW socket ABI exposes HDRINCL, real hop options and the Windows unsupported checksum error", () => {
        const { a }=pair(); const memory=new Uint8Array(4096), view=new DataView(memory.buffer); Mem.bind(()=>memory);
        const counter=new WsaStartupCount(); counter.startup(); let last=0;
        const api=makeSocketExports(a,code=>{last=code;},counter);
        const call=(name:string,args:number[])=>api[name]({} as never,memory,args);
        const s=call("socket",[23,3,58]) as number; expect(s).toBeGreaterThan(0);
        view.setUint32(128,4,true); expect(call("getsockopt",[s,41,2,132,128])).toBe(0); expect(view.getUint32(132,true)).toBe(0);
        view.setUint32(132,1,true); expect(call("setsockopt",[s,41,2,132,4])).toBe(0); expect(a.get(s).headerInclude).toBe(true);
        view.setUint32(132,3,true); expect(call("setsockopt",[s,41,26,132,4])).toBe(-1); expect(last).toBe(WSA.ENOPROTOOPT);
        view.setUint32(132,0,true); expect(call("setsockopt",[s,41,4,132,4])).toBe(0); expect(a.get(s).ipTtl).toBe(0);
        expect(a.get(s).ipOptionsChanged).toBe(true);
    });

    test("IP_TTL and IP_TOS affect transmitted headers through the optional RAW prefix without exposing metadata to the guest", () => {
        const { a,b,nb,frames } = pair(), sender=a.socket(3,2,1), receiver=b.socket(3,2,1);
        b.bind(receiver,ipv4Address(nb.ipv4,0));
        const memory=new Uint8Array(4096), view=new DataView(memory.buffer); Mem.bind(()=>memory);
        const counter=new WsaStartupCount(); counter.startup(); const api=makeSocketExports(a,()=>{},counter);
        const call=(name:string,args:number[])=>api[name]({} as never,memory,args);
        view.setUint32(128,37,true); expect(call("setsockopt",[sender,0,4,128,4])).toBe(0);
        view.setUint32(128,16,true); expect(call("setsockopt",[sender,0,3,128,4])).toBe(0);
        const payload=Uint8Array.of(8,0,1,2); expect(a.send(sender,payload,ipv4Address(nb.ipv4,0))).toBe(4);
        const frame=frames[0]!; expect(frame.payload[1]).toBe(2); expect(frame.payload.length).toBe(9);
        const received=b.receive(receiver,100).data; expect(received.length).toBe(24); expect(received[8]).toBe(37); expect(received[1]).toBe(16);
        expect(received.subarray(20)).toEqual(payload); expect(ipChecksum(received.subarray(0,20))).toBe(0);
    });
});

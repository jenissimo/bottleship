/// <reference types="bun" />
import { expect, test } from "bun:test";
import { echoIdentifier, translateEcho, rewriteIpv4Header, internetChecksum, setIcmpv6Checksum } from "../src/icmp-nat";
import { parseIpv6 } from "../src/ip-address";

test("ICMP echo identifier NAT and IPv4 address translation preserve valid checksums", () => {
    expect(internetChecksum(Uint8Array.of(0,1,0xf2,3,0xf4,0xf5,0xf6,0xf7))).toBe(0x220d);
    const packet = Uint8Array.of(8,0,0,0,0x12,0x34,0,1,99);
    const initial = translateEcho(packet,4,false,0x1234);
    expect(internetChecksum(initial)).toBe(0);
    const translated = translateEcho(initial,4,false,0xabcd);
    expect(echoIdentifier(translated,4,false,false)).toBe(0xabcd);
    expect(internetChecksum(translated)).toBe(0);
    expect(translateEcho(translated,4,false,0x1234)).toEqual(initial);
    const ipv4 = new Uint8Array(20 + initial.length); ipv4[0]=0x45; ipv4[9]=1; ipv4.set(initial,20);
    rewriteIpv4Header(ipv4,Uint8Array.of(203,0,113,1),Uint8Array.of(10,1,2,3));
    expect(internetChecksum(ipv4.subarray(0,20))).toBe(0);
    expect(echoIdentifier(ipv4,4,true,false)).toBe(0x1234);
    expect(packet[4]).toBe(0x12);
});
test("ICMPv6 restored payload checksum matches advertised guest addresses", () => {
    const source=parseIpv6("2001:db8::80")!,destination=parseIpv6("fd42:6273:6c61:6e00:0:200:800:1")!;
    const payload=Uint8Array.of(129,0,0,0,0x12,0x34,0,9,4,5,6);
    setIcmpv6Checksum(payload,source,destination);
    const pseudo=new Uint8Array(40+payload.length);pseudo.set(source);pseudo.set(destination,16);
    new DataView(pseudo.buffer).setUint32(32,payload.length);pseudo[39]=58;pseudo.set(payload,40);
    expect(internetChecksum(pseudo)).toBe(0);
    expect(echoIdentifier(payload,6,false,true)).toBe(0x1234);
    expect(echoIdentifier(payload,6,false,false)).toBeNull();
});

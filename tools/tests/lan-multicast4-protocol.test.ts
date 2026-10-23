import {describe,expect,test} from "bun:test";
import {Buffer} from "node:buffer";
import {encodeDatagram,decodeDatagram,asBytes,ipv4ToNode,nodeToIpv4,PROTO_UDP,PROTO_TCP,MAX_FRAME_SIZE} from "../../packages/lan/src/protocol";

const group=Uint8Array.of(239,255,42,17), node=Uint8Array.of(2,3,...group), source=Uint8Array.of(2,0,0,1,2,3);
const metadata={group,interfaceIndex:2 as const,ttl:1};
const fixture=()=>Uint8Array.of(3,1,2,3,239,255,42,17,0x12,0x34,0x56,0x78,239,255,42,17,2,1,0,0,9,0,8);

describe("UDP IPv4 multicast binary contract",()=>{
 test("encodes the independent 20-byte envelope without losing destination",()=>{
  expect(encodeDatagram(PROTO_UDP,node,0x1234,0x5678,Uint8Array.of(9,0,8),metadata)).toEqual(fixture());
 });
 test("decodes multicast metadata and permits authenticated source rewrite",()=>{
  const decoded=decodeDatagram(fixture()); expect(decoded).not.toBeNull();
  expect(decoded?.multicast4).toEqual(metadata);
  expect(decoded?.payload).toEqual(Uint8Array.of(9,0,8));
  const incoming=fixture();incoming.set(source,2);
  expect(decodeDatagram(incoming)?.node).toEqual(source);
  expect(decodeDatagram(incoming)?.multicast4?.group).toEqual(group);
 });
 test("group IPv4 mapping is exact and distinct from external IPv6 tokens",()=>{
  expect(ipv4ToNode(group)).toEqual(node);expect(ipv4ToNode(group,true)).toEqual(node);expect(nodeToIpv4(node)).toEqual(group);
 });
 test("rejects malformed multicast envelopes and legacy group downgrade",()=>{
  for(const [at,value] of [[1,2],[12,223],[16,0],[16,3],[18,1],[19,1],[2,255],[3,1],[4,238]]){
   const malformed=fixture(); malformed[at]=value; expect(decodeDatagram(malformed),String([at,value])).toBeNull();
  }
  const zeroPort=fixture();zeroPort[8]=zeroPort[9]=0;expect(decodeDatagram(zeroPort)).toBeNull();
  expect(decodeDatagram(fixture().subarray(0,19))).toBeNull();
  const legacy=Uint8Array.of(2,1,...node,0,1,0,2,7);expect(decodeDatagram(legacy)).toBeNull();
  expect(()=>encodeDatagram(PROTO_UDP,node,1,2,Uint8Array.of(7))).toThrow();
 });
 test("validates metadata before encoding and bounds the UDP payload",()=>{
  for(const bad of [{...metadata,group:Uint8Array.of(223,1,2,3)},{...metadata,interfaceIndex:3},{...metadata,ttl:-1},{...metadata,ttl:256},{...metadata,ttl:1.5}]){
   expect(()=>encodeDatagram(PROTO_UDP,node,1,2,new Uint8Array(),bad as typeof metadata)).toThrow();
  }
  expect(()=>encodeDatagram(PROTO_TCP,node,1,2,new Uint8Array(),metadata)).toThrow();
  expect(()=>encodeDatagram(PROTO_UDP,Uint8Array.of(2,3,239,255,42,18),1,2,new Uint8Array(),metadata)).toThrow();
  const max=encodeDatagram(PROTO_UDP,node,1,2,new Uint8Array(65507),metadata);expect(max.length).toBe(65527);expect(max.length).toBeLessThanOrEqual(MAX_FRAME_SIZE);
  expect(decodeDatagram(max)?.payload.length).toBe(65507);
  expect(()=>encodeDatagram(PROTO_UDP,node,1,2,new Uint8Array(65508),metadata)).toThrow();
  const oversized=new Uint8Array(65528);oversized.set(fixture());expect(decodeDatagram(oversized)).toBeNull();
 });
 test("borrowed Node Buffer fields produce owned copies before a process transfer",()=>{
  const input=Buffer.allocUnsafeSlow(fixture().length);input.set(fixture());
  const datagram=decodeDatagram(input)!;
  const payload=datagram.payload.slice(),groupCopy=datagram.multicast4!.group.slice();
  const normalized=asBytes(input)!;
  const packetCopy=normalized.slice();
  structuredClone(input.buffer,{transfer:[input.buffer]});
  expect(payload).toEqual(Uint8Array.of(9,0,8));expect(groupCopy).toEqual(group);expect(packetCopy).toEqual(fixture());
 });
 test("ordinary datagrams retain their original bytes",()=>{
  const frame=encodeDatagram(PROTO_UDP,source,1,2,Uint8Array.of(3,4));
  expect(frame).toEqual(Uint8Array.of(2,1,...source,0,1,0,2,3,4));expect(decodeDatagram(frame)?.multicast4).toBeUndefined();
 });
});

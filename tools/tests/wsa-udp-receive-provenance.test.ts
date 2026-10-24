/**
 * Immutable native UDP36 efc93fea... / observed contract56c2b002...:
 * Primary plus measured PEEK/alias/SO_ERROR/output-validation controls.
 * Virtual/wildcard source separation is a structural route nonregression control.
 * Unchanged runtime first RED must be captured by Root BEFORE implementation.
 */
import {beforeEach,afterEach,expect,test} from "bun:test";
import {WSA} from "../../src/worker/modules/wsa-network";
import {createUdpReceiveProvenanceActor,type Endpoint,type ReadResult} from "./fixtures/udp-receive-provenance-actor";

let f:Awaited<ReturnType<typeof createUdpReceiveProvenanceActor>>|undefined;
beforeEach(async()=>{f=await createUdpReceiveProvenanceActor();});
afterEach(async()=>{const current=f;f=undefined;await current?.dispose();});
const filled=(n:number)=>Array(n).fill(0xa5);
function copiedSource(r:ReadResult,from:Endpoint){
 expect(r.length).toBe(from.bytes.length);
 expect(r.name.slice(0,from.bytes.length)).toEqual(from.bytes);
 expect(r.name.slice(from.bytes.length)).toEqual(filled(32-from.bytes.length));
}
function successful(r:ReadResult,from:Endpoint,byte:number){
 expect({value:r.value,error:r.error}).toEqual({value:1,error:0});
 copiedSource(r,from);expect(r.payload).toEqual([byte,...filled(15)]);
}
function closedAddressOnly(r:ReadResult,a:Endpoint){
 expect({value:r.value,error:r.error}).toEqual({value:-1,error:WSA.ECONNRESET});
 copiedSource(r,a);expect(r.payload).toEqual(filled(16));
}
function untouched(r:ReadResult,error:number,capacity=32){
 expect({value:r.value,error:r.error}).toEqual({value:-1,error});
 expect(r.length).toBe(capacity>>>0);expect(r.name).toEqual(filled(32));expect(r.payload).toEqual(filled(16));
}
for(const family of[2,23] as const){
 test("UDP source provenance primary AF"+family+": recvfrom matches independently queried sender and live B",async()=>{
  const x=f!,client=x.socket(family),a=x.socket(family),b=x.socket(family);
  x.sendOk(client.socket,a,97);await x.delivered(a.socket);const warmA=x.receive(a.socket);
  x.sendOk(client.socket,b,98);await x.delivered(b.socket);const warmB=x.receive(b.socket);
  x.sendOk(b.socket,client,90);await x.delivered(client.socket);const live=x.receive(client.socket);
  // All three actual deliveries are collected before source assertions.
  successful(warmA,client,97);successful(warmB,client,98);successful(live,b,90);
 },30000);
 test("UDP error provenance primary AF"+family+": closed A54 copies address only then wouldblock is untouched",async()=>{
  const x=f!,p=await x.closedCase(family),error=x.receive(p.client.socket),again=x.receive(p.client.socket);
  x.sendOk(p.b.socket,p.client,90);await x.delivered(p.client.socket);const live=x.receive(p.client.socket);
  closedAddressOnly(error,p.a);untouched(again,WSA.EWOULDBLOCK);successful(live,p.b,90);
 },30000);
 test("UDP receive error AF"+family+": repeated PEEK preserves A54 until ordinary receive",async()=>{
  const x=f!,p=await x.closedCase(family);
  const first=x.receive(p.client.socket,{flags:2}),second=x.receive(p.client.socket,{flags:2});
  const plain=x.receive(p.client.socket),empty=x.receive(p.client.socket);
  closedAddressOnly(first,p.a);closedAddressOnly(second,p.a);closedAddressOnly(plain,p.a);
  untouched(empty,WSA.EWOULDBLOCK);
 },30000);
 test("UDP receive error AF"+family+": SO_ERROR reports zero and leaves pending A54 available",async()=>{
  const x=f!,p=await x.closedCase(family),option=x.soError(p.client.socket);
  const error=x.receive(p.client.socket),again=x.receive(p.client.socket);
  expect(option).toEqual({value:0,error:0,option:0,length:4});
  closedAddressOnly(error,p.a);untouched(again,WSA.EWOULDBLOCK);
 },30000);
 test("UDP receive error AF"+family+": next successful sendto B neither consumes54 nor renames it",async()=>{
  const x=f!,p=await x.closedCase(family);
  const send=x.send(p.client.socket,p.b,108);await x.fence();
  const gotByB=x.receive(p.b.socket),error=x.receive(p.client.socket),again=x.receive(p.client.socket);
  expect(send).toEqual({value:1,error:0});successful(gotByB,p.client,108);
  closedAddressOnly(error,p.a);untouched(again,WSA.EWOULDBLOCK);
 },30000);
 test("UDP receive error AF"+family+": alias PEEK shares A54 and original close leaves alias ownership",async()=>{
  const x=f!,p=await x.closedCase(family,true),alias=p.alias!;
  const peek=x.receive(alias,{flags:2}),plain=x.receive(p.client.socket),empty=x.receive(alias);
  // A fresh single real error, not multiple-error coalescing. Closing the
  // original descriptor leaves the physical socket owned by its imported alias.
  x.sendOk(alias,p.a,120);await x.delivered(alias);x.close(p.client.socket);await x.fence();
  const surviving=x.receive(alias),afterClose=x.receive(alias);
  closedAddressOnly(peek,p.a);closedAddressOnly(plain,p.a);untouched(empty,WSA.EWOULDBLOCK);
  closedAddressOnly(surviving,p.a);untouched(afterClose,WSA.EWOULDBLOCK);
 },30000);
 test("UDP receive validation AF"+family+": invalid capacities and unpaired NULL preserve54; both NULL consumes",async()=>{
  const x=f!,p=await x.closedCase(family),n=p.a.bytes.length;
  const invalid=[0,1,n-1,-1].map(capacity=>({capacity,result:x.receive(p.client.socket,{capacity})}));
  const nullFrom=x.receive(p.client.socket,{fromPresent:false}),nullLength=x.receive(p.client.socket,{lengthPresent:false});
  const valid=x.receive(p.client.socket),empty=x.receive(p.client.socket);
  // Independent fresh error for the measured both-NULL consumption case.
  x.sendOk(p.client.socket,p.a,120);await x.delivered(p.client.socket);
  const noOutputs=x.receive(p.client.socket,{fromPresent:false,lengthPresent:false}),afterNull=x.receive(p.client.socket);
  for(const r of invalid)untouched(r.result,WSA.EFAULT,r.capacity);
  untouched(nullFrom,WSA.EFAULT);untouched(nullLength,WSA.EFAULT);
  closedAddressOnly(valid,p.a);untouched(empty,WSA.EWOULDBLOCK);
  untouched(noOutputs,WSA.ECONNRESET);untouched(afterNull,WSA.EWOULDBLOCK);
 },30000);
 // XP source contract: afdsys/misc.c484-498 signals readable with STATUS_SUCCESS.
 // This is not a measured modern-Windows WSAEnumNetworkEvents native profile.
 test("UDP NT5-source FD_READ AF"+family+": notification status0 leaves SO_ERROR0 and receive54 address available",async()=>{
  const x=f!,p=await x.closedCase(family,false,true),notified=x.networkEvents(p.client.socket);
  // Reconfigure while the same physical error is pending, exercising refresh
  // without consuming recvfrom or synthesizing a second error notification.
  x.selectRead(p.client.socket);const refreshed=x.networkEvents(p.client.socket);
  const option=x.soError(p.client.socket),error=x.receive(p.client.socket),again=x.receive(p.client.socket);
  expect(p.beforeErrorEvents?.value).toBe(0);expect(p.beforeErrorEvents?.mask).toBe(0);
  for(const events of[notified,refreshed]){
   expect(events.value).toBe(0);expect(events.mask).toBe(1);
   expect(events.errors).toEqual(Array(10).fill(0));
  }
  expect(option).toEqual({value:0,error:0,option:0,length:4});
  closedAddressOnly(error,p.a);untouched(again,WSA.EWOULDBLOCK);
 },30000);
 test("UDP route separation AF"+family+": wildcard recipient distinguishes explicit loopback and own virtual source",async()=>{
  const x=f!,rx=x.socket(family,"wildcard"),loop=x.socket(family,"loopback"),virtual=x.socket(family,"virtual");
  x.sendOk(loop.socket,x.destination(rx,"loopback"),97);await x.delivered(rx.socket);const fromLoop=x.receive(rx.socket);
  x.sendOk(virtual.socket,x.destination(rx,"virtual"),98);await x.delivered(rx.socket);const fromVirtual=x.receive(rx.socket);
  // Each expected source is independently queried. Receiver-based rewriting
  // cannot satisfy both. This is not native Windows ownership of our virtual NIC.
  expect(loop.bytes).not.toEqual(virtual.bytes);
  successful(fromLoop,loop,97);successful(fromVirtual,virtual,98);
 },30000);
}

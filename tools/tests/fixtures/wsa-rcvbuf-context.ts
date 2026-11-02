import {createWsaApiFixture} from "./wsa-api-context";
import type {WsaSocketTable} from "../../../src/worker/modules/wsa-network";
import type {ThunkResult} from "../../../src/worker/core/thunking/thunk-dispatcher";
export type Family=2|23;
export function publicContext(table:WsaSocketTable){
 const m=createWsaApiFixture(table),trace:unknown[]=[];
 const V=0x20000,L=0x20100,S=0x20200,A=0x21000,N=0x21100,NL=0x21200,D=0x22000,P=0x23000;
 function note(value:unknown){if(trace.length>=512)throw Error("Bounded API trace");trace.push(value);}
 function call(name:string,args:number[]):number{
  const r=m.api[name]({} as never,m.ram,args);
  if(r instanceof Promise)throw Error("Public nonblocking ABI required");
  if(typeof r!=="number"&&r.deferredWrites)m.apply(r as ThunkResult);
  const rc=typeof r==="number"?r:r.value;note({name,args:[...args],rc,error:m.error()});return rc;
 }
 function need(name:string,args:number[],expected=0){const rc=call(name,args);if(rc!==expected)throw Error(name+" prerequisite="+rc+"/error="+m.error());return rc;}
 function query(socket:number,capacity=4){
  if(![0,1,2,3,4,5,6,7,8,12,16].includes(capacity))throw Error("Draft measured capacity scope");
  m.ram.fill(0xb6,V,V+32);m.ram.fill(0xb6,L,L+12);m.put(L+4,capacity);m.seed(0x5a510072);
  const rc=call("getsockopt",[socket,0xffff,0x1002,V+8,L+4]);
  const row={rc,error:m.error(),capacity,length:m.get(L+4),word:m.get(V+8),value:Array.from(m.ram.slice(V,V+32)),lengthBytes:Array.from(m.ram.slice(L,L+12))};
  note({query:row});return row;
 }
 function set(socket:number,value:number,length=4){
  if(![0,1,2,3,4,8].includes(length))throw Error("Draft measured setter length scope");
  m.ram.fill(0xb6,S,S+24);m.put(S+8,value);m.put(S+12,0);m.seed(0x5a510073);
  const before=Array.from(m.ram.slice(S,S+24)),rc=call("setsockopt",[socket,0xffff,0x1002,S+8,length]);
  const row={rc,error:m.error(),value,length,before,after:Array.from(m.ram.slice(S,S+24))};note({setter:row});return row;
 }
 function socket(family:Family){
  const s=call("WSASocketA",[family,2,17,0,0,1]);if(s===-1||s===0xffffffff)throw Error("UDP create prerequisite");
  m.put(S,1);need("ioctlsocket",[s,0x8004667e,S]);
  if(family===23){m.put(S,1);need("setsockopt",[s,41,27,S,4]);}return s;
 }
 function local(socket:number){
  m.ram.fill(0xa5,N,N+32);m.put(NL,32);need("getsockname",[socket,N,NL]);const length=m.get(NL);
  const raw=Array.from(m.ram.slice(N,N+32)),af=raw[0]|raw[1]<<8;
  if((af!==2&&af!==23)||length!==(af===2?16:28))throw Error("Actual sockaddr shape");
  const row={family:af as Family,port:raw[2]*256+raw[3],length,raw};note({local:row});return row;
 }
 function bind(socket:number,family:Family,port=0){
  const raw=new Uint8Array(family===2?16:28),d=new DataView(raw.buffer);d.setUint16(0,family,true);d.setUint16(2,port,false);
  if(family===2)raw.set([127,0,0,1],4);else raw[23]=1;m.ram.set(raw,A);need("bind",[socket,A,raw.length]);
  const actual=local(socket),ip=family===2?actual.raw.slice(4,8):actual.raw.slice(8,24);
  const expectedIp=family===2?[127,0,0,1]:[...Array(15).fill(0),1];
  if(actual.family!==family||ip.length!==expectedIp.length||ip.some((byte,i)=>byte!==expectedIp[i])||
   actual.port<1||actual.port>65535||(port!==0&&actual.port!==port))throw Error("Queried endpoint differs from independent bind input");
  return actual;
 }
 function duplicate(socket:number,targetPid:number){
  m.ram.fill(0xa5,P,P+636);need("WSADuplicateSocketW",[socket,targetPid,P]);
  const info=m.ram.slice(P,P+628);note({duplicateOpaque:info.length,tail:Array.from(m.ram.slice(P+628,P+636))});
  if(m.ram.slice(P+628,P+636).some(x=>x!==0xa5))throw Error("Duplicate output tail");
  return info;
 }
 function importInfo(info:Uint8Array){
  if(info.length!==628)throw Error("Opaque public info image");m.ram.set(info,P);
  const s=call("WSASocketW",[-1,-1,-1,P,0,1]);if(s===-1||s===0xffffffff)throw Error("Public duplicate import");return s;
 }
 function send(socket:number,target:ReturnType<typeof local>,bytes:number[]){
  m.ram.set(target.raw.slice(0,target.length),A);m.ram.set(bytes,D);
  return call("sendto",[socket,D,bytes.length,0,A,target.length]);
 }
 function receive(socket:number,peek=false){
  m.ram.fill(0xa5,D,D+32);m.ram.fill(0xa5,N,N+32);m.put(NL,32);
  const rc=call("recvfrom",[socket,D,32,peek?2:0,N,NL]);
  const row={rc,error:m.error(),length:m.get(NL),data:Array.from(m.ram.slice(D,D+32)),name:Array.from(m.ram.slice(N,N+32))};note({receive:row});return row;
 }
 function available(socket:number){m.put(S,0xb6b6b6b6);need("ioctlsocket",[socket,0x4004667f,S]);const value=m.get(S);note({available:value});return value;}
 function close(socket:number){need("closesocket",[socket]);}
 return{m,table,trace,note,call,need,query,set,socket,local,bind,duplicate,importInfo,send,receive,available,close,dispose:()=>m.dispose()};
}

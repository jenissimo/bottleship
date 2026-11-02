import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {WsaSocketTable} from "../../src/worker/modules/wsa-network";
import {acquireDirectPlay4JoinUdpListener} from "../../src/worker/modules/dplayx/native-wire/join-udp-listener";

test("actor host validation is the final external check after reentrant file lookup",async()=>{
 const network=new LanNetwork(),table=new WsaSocketTable(network);
 network.attach({connected:true,send:()=>true,close(){}});
 let live=true,inject=false,releases=0;
 const original=table.fileObjectId.bind(table);
 table.fileObjectId=(id:number)=>{if(inject)live=false;return original(id);};
 (table as any).startActorUdpHost=(sid:number)=>({
  inspect(){if(!live)throw Error("revoked");return {physical:original(sid),binding:1,port:5000,
   address:{node:[2,1,127,0,0,1],port:32123},allowedNodes:[[2,1,127,0,0,1]]};},
  release(){if(live){live=false;releases++;}}
 });
 try{
  const owner=await acquireDirectPlay4JoinUdpListener(table,"udp",1000);
  expect(owner.current()).toBe(true);
  inject=true;expect(owner.current()).toBe(false);owner.release();
  expect(table.isValid(owner.socket)).toBe(false);
 }finally{table.reset();}
});
test("reentrant abort inside final actor READY inspection rejects",async()=>{
 const network=new LanNetwork(),table=new WsaSocketTable(network),controller=new AbortController();
 network.attach({connected:true,send:()=>true,close(){}});
 let count=0,releases=0;
 (table as any).startActorUdpHost=(sid:number)=>({
  inspect(){if(++count===2)controller.abort();return {physical:table.fileObjectId(sid),binding:1,port:5000,
   address:{node:[2,1,127,0,0,1],port:32123},allowedNodes:[[2,1,127,0,0,1]]};},
  release(){releases++;}
 });
 try{
  const pending=acquireDirectPlay4JoinUdpListener(table,"udp",1000,controller.signal);
  const outcome=await Promise.race([pending.then(()=>"resolved",()=>"rejected"),new Promise<string>(r=>setTimeout(()=>r("hung"),100))]);
  expect(outcome).toBe("rejected");expect(releases).toBe(1);
 }finally{table.reset();}
});

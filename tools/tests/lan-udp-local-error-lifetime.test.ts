import {expect,test} from "bun:test";
import {LanNetwork,type LanSocketError,type NetTransport} from "../../src/worker/net/lan-network";
import {PROTO_UDP,PROTO_UDP6} from "../../src/worker/net/netplay-wire";
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const transport=():NetTransport=>({connected:true,send(){return true;},close(){}});
for(const proto of [PROTO_UDP,PROTO_UDP6])test(`local UDP ${proto} error survives unrelated relay loss and replacement`,async()=>{
 for(const transition of ["offline","detach","replace"]){
  const network=new LanNetwork(),errors:LanSocketError[]=[],endpoint={deliver(){}};
  network.attach(transport());network.onSocketError(error=>errors.push(error));
  expect(network.bind(62120,endpoint,proto)).toBe(true);
  const bindingGeneration=network.bindingGeneration(62120,proto),delivery=network.deliveryGeneration(62120,proto);
  expect(network.send(62120,network.node,62121,Uint8Array.of(1),proto)).toBe(true);
  if(transition==="offline")network.setConnected(false);
  else network.attach(transition==="detach"?null:transport());
  expect(network.bindingGeneration(62120,proto)).toBe(bindingGeneration);
  expect(network.deliveryGeneration(62120,proto)).toBe(delivery);
  await tick();
  expect(errors).toEqual([{node:network.node,localPort:62120,remotePort:62121,proto,code:10054,bindingGeneration}]);
  network.reset();network.attach(null);
 }
});

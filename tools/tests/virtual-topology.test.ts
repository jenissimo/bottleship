import {expect,test} from 'bun:test';
import {LanNetwork} from '../../src/worker/net/lan-network';
import {getVirtualNetworkTopology,encodeInterfaceList,prefixMask} from '../../src/worker/net/virtual-topology';
import {encodeAdaptersInfo,encodeAdaptersAddresses} from '../../src/worker/modules/iphlpapi';

const network=()=>new LanNetwork(Uint8Array.of(2,0,0,9,8,7));
const u32=(bytes:Uint8Array,offset:number)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset,true);
const text=(bytes:Uint8Array,offset:number)=>{let end=offset;while(end<bytes.length&&bytes[end])end++;return new TextDecoder().decode(bytes.subarray(offset,end));};

test('virtual NIC identity, local routes and ULA /80 survive relay offline without advertising gateway addresses',()=>{
 const net=network();net.configureGatewayAddresses([[203,0,113,99]]);net.configureGatewayIpv6([{address:[0x20,1,0xdb,8,...Array(12).fill(0)],node:[2,2,0,0,0,1],scopeId:9}]);
 const offline=getVirtualNetworkTopology(net);net.setConnected(true);const online=getVirtualNetworkTopology(net);net.setConnected(false);
 expect(getVirtualNetworkTopology(net)).toEqual(offline);expect(online).toEqual(offline);expect(offline.interfaces.map(adapter=>adapter.index)).toEqual([2,1]);
 const lan=offline.interfaces[0];expect(lan.physicalAddress).toEqual(net.node);expect(lan.addresses.map(address=>[address.family,address.prefixLength,address.scopeId])).toEqual([[2,8,0],[23,80,0]]);
 expect(lan.addresses[0].address).toEqual(Uint8Array.of(10,9,8,7));expect(lan.addresses[1].address).toEqual(net.ipv6);
 expect(offline.interfaces.every(adapter=>adapter.up&&adapter.multicast)).toBe(true);
 expect(offline.interfaces.flatMap(adapter=>adapter.addresses).some(address=>address.address.join('.')==='203.0.113.99')).toBe(false);
 lan.physicalAddress[5]=99;lan.addresses[0].address[3]=99;expect(getVirtualNetworkTopology(net).interfaces[0].physicalAddress[5]).toBe(7);expect(net.ipv4[3]).toBe(7);
});
test('native x86 INTERFACE_INFO layout has 76-byte records, 24-byte sockaddr unions and real broadcast capability',()=>{
 const bytes=encodeInterfaceList(getVirtualNetworkTopology(network()));expect(bytes.length).toBe(152);
 expect(u32(bytes,0)).toBe(19);expect(u32(bytes,76)).toBe(21);
 expect([...bytes.slice(8,12)]).toEqual([10,9,8,7]);expect([...bytes.slice(32,36)]).toEqual([10,255,255,255]);expect([...bytes.slice(56,60)]).toEqual([255,0,0,0]);
 for(const start of [0,76])for(const field of [4,28,52]){expect(u32(bytes,start+field)).toBe(start===76&&field===28?0:2);expect([...bytes.slice(start+field+16,start+field+24)]).toEqual(Array(8).fill(0));}
 expect(prefixMask(16,80)).toEqual(Uint8Array.from([...Array(10).fill(255),...Array(6).fill(0)]));
});
test('IP Helper prefix chain describes local host, on-link and implemented broadcast and IPv4 multicast routes',()=>{
 const base=0x10000,bytes=encodeAdaptersAddresses(getVirtualNetworkTopology(network()),base,0,0x10),prefixes:Array<[number,string,number]>=[];
 for(let entry=u32(bytes,140);entry;entry=u32(bytes,entry-base+8)){
  const offset=entry-base,sockaddr=u32(bytes,offset+12)-base,family=new DataView(bytes.buffer).getUint16(sockaddr,true);
  const ip=bytes.slice(sockaddr+(family===2?4:8),sockaddr+(family===2?8:24));prefixes.push([family,Array.from(ip).join('.'),u32(bytes,offset+20)]);
 }
 expect(prefixes).toContainEqual([2,'10.0.0.0',8]);expect(prefixes).toContainEqual([2,'10.9.8.7',32]);expect(prefixes).toContainEqual([2,'10.255.255.255',32]);expect(prefixes).toContainEqual([2,'255.255.255.255',32]);
 expect(prefixes.filter(([family])=>family===23).map(([, ,length])=>length)).toEqual([80,128]);
 expect(prefixes).toContainEqual([2,'224.0.0.0',4]);expect(prefixes.some(([family,address])=>family===23&&address.startsWith('255.'))).toBe(false);
});
test('classic IP Helper emits the same LAN identity in the native640 IPv4 adapter and excludes loopback',()=>{
 const topology=getVirtualNetworkTopology(network()),bytes=encodeAdaptersInfo(topology,0x10000);expect(bytes.length).toBe(640);
 expect(u32(bytes,0)).toBe(0);expect(text(bytes,8)).toBe(topology.interfaces[0].name);expect(u32(bytes,400)).toBe(6);
 expect([...bytes.slice(404,410)]).toEqual([2,0,0,9,8,7]);expect(u32(bytes,412)).toBe(2);expect(u32(bytes,416)).toBe(6);expect(u32(bytes,420)).toBe(0);
 expect(text(bytes,432)).toBe('10.9.8.7');expect(text(bytes,448)).toBe('255.0.0.0');expect(text(bytes,472)).toBe('0.0.0.0');
});
test('modern IP Helper native376/48/24 ABI uses bounded pointers, family filtering and capability flags',()=>{
 for(const family of [0,2,23])for(const flags of [0,1,0x10,0x20,0x80000000]){
  const base=0x10000,bytes=encodeAdaptersAddresses(getVirtualNetworkTopology(network()),base,family,flags);let row=0,count=0,addresses=0;
  while(true){count++;expect(u32(bytes,row)).toBe(376);expect(u32(bytes,row+56)&0x10).toBe(0);expect(u32(bytes,row+68)).toBe(1);
   if(flags&0x20)expect(u32(bytes,row+40)).toBe(0);else expect(u32(bytes,row+40)).toBeGreaterThanOrEqual(base+752);
   let entry=u32(bytes,row+16);while(entry){const offset=entry-base;expect(offset).toBeGreaterThanOrEqual(752);expect(offset+48).toBeLessThanOrEqual(bytes.length);expect(u32(bytes,offset)).toBe(48);
    const sockaddr=u32(bytes,offset+12)-base,af=new DataView(bytes.buffer).getUint16(sockaddr,true);expect([2,23]).toContain(af);if(family)expect(af).toBe(family);addresses++;
    expect(u32(bytes,offset+16)).toBe(af===2?16:28);entry=u32(bytes,offset+8);
   }
   if(flags&0x10)expect(u32(bytes,row+140)).toBeGreaterThanOrEqual(base+752);else expect(u32(bytes,row+140)).toBe(0);
   const next=u32(bytes,row+8);if(!next)break;row=next-base;expect(count).toBeLessThan(3);
  }
  expect(count).toBe(2);expect(addresses).toBe(flags&1?0:family?2:4);
 }
});

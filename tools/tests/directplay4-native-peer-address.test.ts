import {expect,test} from "bun:test";
import {LanNetwork} from "../../src/worker/net/lan-network";
import {nativeDiscoveryOwner} from "../../src/worker/modules/dplayx/native-wire/peer-address";

test("native owner rehomes only zero IP, preserves advertised port and copies input",()=>{
    const net=new LanNetwork(Uint8Array.of(2,0,0,1,2,3));
    net.configureGatewayAddresses([[127,0,0,1],[192,0,2,1]]);
    const peer={family:2,node:Uint8Array.of(2,1,127,0,0,1),ip:Uint8Array.of(127,0,0,1),port:49152};
    const raw=Uint8Array.of(2,0,0x08,0xfc,0,0,0,0,0,0,0,0,0,0,0,0);
    const zero=nativeDiscoveryOwner(raw,peer,13,net)!;
    expect(zero.address).toEqual({node:[2,1,127,0,0,1],port:2300});
    expect([...zero.sockaddr.slice(4,8)]).toEqual([127,0,0,1]);
    raw.set([192,0,2,1],4);
    const nonzero=nativeDiscoveryOwner(raw,peer,11,net)!;
    expect(nonzero.address).toEqual({node:[2,1,192,0,2,1],port:2300});
    raw.fill(0xff);peer.ip.fill(0xff);peer.node.fill(0xff);
    expect([...zero.sockaddr.slice(4,8)]).toEqual([127,0,0,1]);
    expect([...nonzero.sockaddr.slice(4,8)]).toEqual([192,0,2,1]);
    expect([...nonzero.peer.ip!]).toEqual([127,0,0,1]);expect(nonzero.version).toBe(11);
});
test("Buffer views use their own offset and returned owner owns every byte",()=>{
    const net=new LanNetwork();
    const raw=Buffer.from("ffff020008fcc00002010000000000000000ffff","hex").subarray(2,18);
    const node=Buffer.from("ff02017f000001ff","hex").subarray(1,7);
    const ip=Buffer.from("ff7f000001ff","hex").subarray(1,5);
    const owner=nativeDiscoveryOwner(raw,{family:2,node,ip,port:4000},13,net)!;
    expect(owner.address.port).toBe(2300);
    raw.fill(0); node.fill(0); ip.fill(0);
    expect([...owner.sockaddr.subarray(4,8)]).toEqual([192,0,2,1]);
    expect([...owner.peer.node]).toEqual([2,1,127,0,0,1]);
    expect([...owner.peer.ip!]).toEqual([127,0,0,1]);
});
test("malformed or unroutable native owner is rejected before publication",()=>{
    const net=new LanNetwork(), peer={family:2,node:Uint8Array.of(2,1,127,0,0,1),ip:Uint8Array.of(127,0,0,1),port:4000};
    const good=Uint8Array.of(2,0,0x08,0xfc,192,0,2,1,0,0,0,0,0,0,0,0);
    const invalid=(f:(b:Uint8Array)=>void)=>{const copy=good.slice();f(copy);return copy;};
    for(const raw of [good.slice(0,15),invalid(b=>{b[0]=23;}),invalid(b=>{b[2]=0;b[3]=0;}),invalid(b=>{b[4]=224;})])
        expect(nativeDiscoveryOwner(raw,peer,13,net)).toBeUndefined();
    expect(nativeDiscoveryOwner(good,{...peer,port:0},13,net)).toBeUndefined();
    expect(nativeDiscoveryOwner(good,{...peer,ip:Uint8Array.of(1,2,3,4)},13,net)).toBeUndefined();
    expect(nativeDiscoveryOwner(good,peer,65536,net)).toBeUndefined();
});

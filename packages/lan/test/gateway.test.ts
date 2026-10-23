/// <reference types="bun" />
import { expect, test } from "bun:test";
import { GatewayRoutes } from "../src/gateway";

test("native gateway rejects invalid capacity limits rather than disabling bounds", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 4097]) {
        expect(() => new GatewayRoutes({ routes: [], maxTcpConnections: value })).toThrow(RangeError);
        expect(() => new GatewayRoutes({ routes: [], maxUdpFlows: value })).toThrow(RangeError);
    }
    expect(() => new GatewayRoutes({ routes: [], connectTimeoutMs: Infinity })).toThrow(RangeError);
    expect(() => new GatewayRoutes({ routes: [], udpIdleTimeoutMs: 0 })).toThrow(RangeError);
});

test("IPv6 route scopes are distinct in readiness and DNS and reject invalid configuration",async()=>{
    const options={routes:[7,8].map(scopeId=>({host:"::1",address:"fe80::7",scopeId,names:["scope.test"],ports:[7],protocols:["udp" as const]}))};
    const routes=new GatewayRoutes(options);await routes.initialize();
    const advertised=routes.advertisedIpv6,result=await routes.resolve({host:"scope.test",family:6});
    expect(advertised.map(item=>item.scopeId)).toEqual([7,8]);
    expect(advertised[0].node).not.toEqual(advertised[1].node);
    expect(result.addresses.map(item=>item.scopeId)).toEqual([7,8]);
    expect((await routes.resolve({host:"fe80::7%8",family:6})).addresses).toHaveLength(1);
    for(const scopeId of [-1,1.5,0x100000000,NaN,Infinity])expect(()=>new GatewayRoutes({routes:[{...options.routes[0],scopeId}]})).toThrow();
    expect(()=>new GatewayRoutes({routes:[{...options.routes[0],address:"fe80::7%4294967296"}]})).toThrow();
});

test("native RAW leases canonicalize mapped IPv4 and equivalent numeric IPv6 zones",async()=>{
    const routes=new GatewayRoutes({routes:[
        {host:"127.0.0.1",address:"203.0.113.1",protocols:["raw"],ipProtocols:[1]},
        {host:"::ffff:127.0.0.1",address:"203.0.113.2",protocols:["udp"],ports:[7]},
        {host:"fe80::123%009",address:"2001:db8::1",protocols:["raw"],ipProtocols:[58]},
        {host:"fe80::123%9",address:"2001:db8::2",protocols:["udp"],ports:[7]},
    ]});
    await routes.initialize();const a={},b={};
    const one=routes.findRaw("203.0.113.1",1)!,two=routes.find("203.0.113.2",7,"udp")!;
    const raw=routes.acquireNative(one,"203.0.113.1",a,true);
    expect(()=>routes.acquireNative(two,"203.0.113.2",b)).toThrow();
    raw.release();const shared=routes.acquireNative(two,"203.0.113.2",b);shared.release();
    const first=routes.findRaw("2001:db8::1",58)!,second=routes.find("2001:db8::2",7,"udp")!;
    const scoped=routes.acquireNative(first,"2001:db8::1",a,true);
    expect(()=>routes.acquireNative(second,"2001:db8::2",b)).toThrow();
    scoped.release();
});

test("unspecified UDP destinations and actual loopback own the same native policy lease",async()=>{
 for(const [unspecified,loopback,advertised]of [["0.0.0.0","127.0.0.1",["203.0.113.201","203.0.113.202"]],["::","::1",["2001:db8::201","2001:db8::202"]]] as const){
  const routes=new GatewayRoutes({routes:[{host:unspecified,address:advertised[0],ports:[7],protocols:["udp"]},{host:loopback,address:advertised[1],protocols:["raw"],ipProtocols:[1]}]});await routes.initialize();
  const udp=routes.find(advertised[0],7,"udp")!,raw=routes.findRaw(advertised[1],1)!,a={},b={};
  const shared=routes.acquireNative(udp,advertised[0],a);
  expect(()=>routes.acquireNative(raw,advertised[1],b,true)).toThrow();
  shared.release();const exclusive=routes.acquireNative(raw,advertised[1],b,true);
  expect(()=>routes.acquireNative(udp,advertised[0],a)).toThrow();
  exclusive.release();const reopened=routes.acquireNative(udp,advertised[0],a);reopened.release();
 }
});

import { expect, test } from "bun:test";
import { LanNetwork } from "../../src/worker/net/lan-network";
import { DirectPlaySession, type Discovery } from "../../src/worker/modules/dplayx/session";

const instance = "1".repeat(32);
const entry = (epoch?: object): Discovery => ({
    desc: {instance, application:"2".repeat(32), flags:0, maxPlayers:8, name:"x", password:"", user:[0,0,0,0]},
    currentPlayers:0, address:{node:[2,1,127,0,0,1],port:2300}, seen:Date.now(),
    ...(epoch ? {native:true as const, nativeEpoch:epoch} : {}),
});

test("finish and stop preserve native cache, close and replacement invalidate only native", () => {
    const net = new LanNetwork(), session = new DirectPlaySession(net);
    const first = session.beginNativeDiscovery(), saved = entry(first.epoch);
    session.discovered.set(instance, saved);
    first.finish();
    expect(session.isCurrentNativeDiscovery(saved)).toBe(true);
    session.stopDiscovery();
    expect(session.isCurrentNativeDiscovery(saved)).toBe(true);

    const virtual = entry();
    session.discovered.set(instance, virtual);
    expect(session.isCurrentNativeDiscovery(saved)).toBe(false);
    const second = session.beginNativeDiscovery();
    expect(session.discovered.get(instance)).toBe(virtual);
    expect(session.isCurrentNativeDiscovery(saved)).toBe(false);
    const fresh = entry(second.epoch);
    session.discovered.set(instance, fresh);
    expect(session.isCurrentNativeDiscovery(fresh)).toBe(true);
    session.close();
    expect(second.signal.aborted).toBe(true);
    expect(second.current()).toBe(false);
    expect(session.discovered.has(instance)).toBe(false);
    expect(session.isCurrentNativeDiscovery(fresh)).toBe(false);
    const third = session.beginNativeDiscovery();
    session.discovered.set(instance, fresh); // Simulate an obsolete publication.
    expect(session.isCurrentNativeDiscovery(fresh)).toBe(false);
    session.discovered.set(instance, virtual);
    session.close();
    expect(session.discovered.get(instance)).toBe(virtual);
    expect(third.current()).toBe(false);
    session.dispose();
});

test("exact native cache owner is revoked synchronously on replacement, expiry and close", () => {
    const net = new LanNetwork(), session = new DirectPlaySession(net);
    net.attach({send:()=>true, close:()=>{}});
    expect(session.initialize()).toBe(0);
    const first = session.beginNativeDiscovery(), old = entry(first.epoch);
    session.cacheDiscovery(old); first.finish();
    const signal = session.nativeDiscoverySignal(old)!;
    expect(signal.aborted).toBe(false);
    session.cacheDiscovery(entry());
    expect(signal.aborted).toBe(true);
    expect(session.nativeDiscoverySignal(old)).toBeUndefined();
    const expired = entry(first.epoch); expired.seen = Date.now() - 31000;
    session.cacheDiscovery(expired);
    const expirySignal = session.nativeDiscoverySignal(expired)!;
    session.discover(expired.desc.application);
    expect(expirySignal.aborted).toBe(true);
    const next = session.beginNativeDiscovery(), fresh = entry(next.epoch);
    session.cacheDiscovery(fresh); next.finish();
    const freshSignal = session.nativeDiscoverySignal(fresh)!;
    session.close();
    expect(freshSignal.aborted).toBe(true);
    session.dispose();
});

test("reentrant cache replacement retires only the exact previous owner", () => {
    const session = new DirectPlaySession(new LanNetwork());
    const discovery = session.beginNativeDiscovery(), old = entry(discovery.epoch);
    session.cacheDiscovery(old); discovery.finish();
    const signal = session.nativeDiscoverySignal(old)!, replacement = entry(discovery.epoch), latest = entry(discovery.epoch);
    signal.addEventListener("abort", () => session.cacheDiscovery(latest), {once:true});
    session.cacheDiscovery(replacement);
    expect(signal.aborted).toBe(true);
    expect(session.discovered.get(instance)).toBe(latest);
    const latestSignal = session.nativeDiscoverySignal(latest)!;
    expect(latestSignal.aborted).toBe(false);
    session.close(); expect(latestSignal.aborted).toBe(true);
    session.dispose();
});

test("disconnect and dispose invalidate cache and old operations across reconnect", () => {
    const net = new LanNetwork(), session = new DirectPlaySession(net);
    net.attach({send:()=>true, close:()=>{}});
    const old = session.beginNativeDiscovery(), saved = entry(old.epoch);
    session.discovered.set(instance, saved);
    net.setConnected(false, "test disconnect");
    expect(old.current()).toBe(false);
    expect(old.signal.aborted).toBe(true);
    expect(session.discovered.size).toBe(0);
    net.setConnected(true);
    const next = session.beginNativeDiscovery(), fresh = entry(next.epoch);
    session.discovered.set(instance, fresh);
    old.finish();
    expect(next.current()).toBe(true);
    expect(session.isCurrentNativeDiscovery(saved)).toBe(false);
    expect(session.isCurrentNativeDiscovery(fresh)).toBe(true);
    session.dispose();
    expect(next.current()).toBe(false);
    expect(session.isCurrentNativeDiscovery(fresh)).toBe(false);
});
